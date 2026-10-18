import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { BridgeError, errorCode } from "../errors.js";

export interface RpcOptions {
  timeoutMs?: number;
  orchestrationRequestId?: string;
  terminalPromptPreflight?: { runtimeId: string };
}

export interface OrcaRpc {
  call(method: string, params?: unknown, options?: RpcOptions): Promise<unknown>;
}

const transportSchema = z.object({ kind: z.string(), endpoint: z.string() });
const metadataSchema = z.object({ runtimeId: z.string().min(1), authToken: z.string().min(1),
  transports: z.array(transportSchema).optional(), transport: transportSchema.optional() });
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown(),
    _meta: z.object({ runtimeId: z.string() }).optional() }),
  z.object({ id: z.string(), ok: z.literal(false),
    error: z.object({ code: z.string() }), _meta: z.object({ runtimeId: z.string() }).optional() }),
]);

/** Use Orca's own profile reader; keep its credential inside each local socket call. */
export function installedOrcaRpc(config: Config): OrcaRpc {
  const file = join(config.orca.appPath, "Contents", "Resources", "app.asar.unpacked",
    "out", "cli", "runtime", "metadata.js");
  let read: () => z.infer<typeof metadataSchema>;
  try {
    const require = createRequire(import.meta.url);
    const module: unknown = require(file);
    if (typeof module !== "object" || module === null || !("readMetadata" in module) ||
      !("getPlatformUserDataPath" in module) || typeof module.readMetadata !== "function" ||
      typeof module.getPlatformUserDataPath !== "function") throw new Error("missing export");
    const readMetadata = module.readMetadata as (path: string) => unknown;
    const defaultPath = module.getPlatformUserDataPath as () => string;
    read = () => metadataSchema.parse(readMetadata(config.orca.userDataPath ?? defaultPath()));
  } catch {
    throw new BridgeError("orca_incompatible", "The installed Orca CLI profile reader is unavailable. Run doctor after updating Orca.");
  }
  return {
    async call(method, params, options) {
      try {
        const metadata = read();
        const transport = (metadata.transports ?? (metadata.transport ? [metadata.transport] : []))
          .find((candidate) => candidate.kind === "unix");
        if (!transport || !isAbsolute(transport.endpoint)) throw new BridgeError("orca_incompatible",
          "The configured Orca profile has no local Unix socket.");
        if (options?.terminalPromptPreflight &&
          options.terminalPromptPreflight.runtimeId !== metadata.runtimeId) throw new BridgeError(
          "runtime_changed", "Orca restarted before delivery. No prompt was sent.");
        return await request(transport.endpoint, metadata, method, params,
          options?.timeoutMs ?? config.orca.requestTimeoutMs, options?.orchestrationRequestId);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(errorCode(error), `Orca request failed (${errorCode(error)}).`,
          method === "terminal.send" || method.startsWith("agentSession."));
      }
    },
  };
}

function request(endpoint: string, metadata: z.infer<typeof metadataSchema>, method: string,
  params: unknown, timeoutMs: number, operationId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const id = randomUUID();
    let buffer = Buffer.alloc(0);
    let done = false;
    let dispatched = false;
    const finish = (error?: BridgeError, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      buffer = Buffer.alloc(0);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new BridgeError("orca_timeout",
      "Orca did not answer before the request deadline. Delivery may be unknown; the bridge did not retry.", dispatched)), timeoutMs);
    socket.once("connect", () => {
      dispatched = true;
      socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params,
        ...(operationId ? { orchestrationRequestId: operationId } : {}) })}\n`);
    });
    socket.once("error", () => finish(new BridgeError("orca_unavailable",
      "The configured Orca runtime is unavailable. No automatic retry was attempted.", dispatched)));
    socket.once("close", () => finish(new BridgeError("orca_disconnected",
      "Orca closed the connection. No automatic retry was attempted.", dispatched)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8_388_608) return finish(new BridgeError("response_too_large", "Orca response exceeded the bridge byte limit.", dispatched));
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        if (!line.trim()) continue;
        try {
          const raw: unknown = JSON.parse(line);
          if (typeof raw === "object" && raw !== null && "_keepalive" in raw && raw._keepalive === true) continue;
          const frame = envelopeSchema.parse(raw);
          if (frame.id !== id || (frame._meta && frame._meta.runtimeId !== metadata.runtimeId))
            throw new Error("identity changed");
          if (!frame.ok) finish(new BridgeError(frame.error.code,
            `Orca refused ${method} (${frame.error.code}).`));
          else finish(undefined, frame.result);
          return;
        } catch { return finish(new BridgeError("orca_contract_changed", "Orca returned an incompatible response.", dispatched)); }
      }
    });
  });
}

export async function callOrca<S extends z.ZodType>(
  rpc: OrcaRpc, method: string, schema: S, params?: unknown, options?: RpcOptions,
): Promise<z.infer<S>> {
  const result = schema.safeParse(await rpc.call(method, params, options));
  if (!result.success) throw new BridgeError("orca_contract_changed",
    `Orca returned an incompatible ${method} response. No automatic retry was attempted.`);
  return result.data;
}
