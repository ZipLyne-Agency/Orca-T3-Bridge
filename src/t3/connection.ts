import WebSocket from "ws";
import { z } from "zod";
import type { Config } from "../config.js";
import { BridgeError } from "../errors.js";
import { runProcess } from "../process.js";
import { httpJson } from "./http.js";

const issuedSchema = z.object({ sessionId: z.string(), token: z.string().min(1),
  expiresAt: z.iso.datetime() });
const ticketSchema = z.object({ ticket: z.string().min(1), expiresAt: z.string() });
interface Pending { resolve(value: unknown): void; reject(error: BridgeError): void; timer: NodeJS.Timeout }

export class T3Connection {
  private socket: WebSocket | undefined;
  private issued: z.infer<typeof issuedSchema> | undefined;
  private serial = 0;
  private readonly pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | undefined;
  private lastPong = Date.now();
  private closed = false;
  private constructor(readonly config: NonNullable<Config["t3"]>) {}

  static async open(config: NonNullable<Config["t3"]>, scopes: string[]): Promise<T3Connection> {
    const connection = new T3Connection(config);
    try {
      const raw = await connection.cli(["auth", "session", "issue", "--base-dir", config.baseDir,
        "--ttl", "1h", "--label", "Orca bridge", "--subject", "orca-t3-bridge",
        ...scopes.flatMap((scope) => ["--scope", scope]), "--json"]);
      connection.issued = issuedSchema.parse(JSON.parse(raw));
      const ticket = await connection.http("/api/auth/websocket-ticket", ticketSchema, { method: "POST" });
      const url = new URL("/ws", config.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("orchestrationProtocol", "2");
      url.searchParams.set("wsTicket", ticket.ticket);
      await connection.connect(url);
      return connection;
    } catch (error) { await connection.close(); throw error; }
  }

  private async cli(args: string[]): Promise<string> {
    return await runProcess(this.config.executable, [...this.config.executableArgs, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 30_000,
    });
  }

  async http<S extends z.ZodType>(path: string, schema: S, init: RequestInit = {}): Promise<z.infer<S>> {
    if (!this.issued) throw new BridgeError("t3_not_connected", "No T3 session is available.");
    return await httpJson(new URL(path, this.config.url), schema, { ...init,
      headers: { "content-type": "application/json", "x-t3-orchestration-protocol": "2",
        ...init.headers, authorization: `Bearer ${this.issued.token}` } });
  }

  private async connect(url: URL): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: 8_388_608,
        handshakeTimeout: 10_000, followRedirects: false });
      this.socket = socket;
      socket.once("open", resolve);
      socket.on("error", () => {
        const error = new BridgeError("t3_socket_failed", "The T3 WebSocket connection failed. No mutation was retried.");
        reject(error); this.failPending(error);
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume(); socket.terminate();
        reject(new BridgeError("t3_handshake_failed", `T3 refused the socket handshake (HTTP ${response.statusCode ?? "unknown"}).`));
      });
      socket.once("close", () => this.failPending(new BridgeError("t3_disconnected", "T3 disconnected. No mutation was retried.")));
      socket.on("message", (raw) => {
        try {
          const frame: unknown = JSON.parse(raw.toString());
          this.onFrame(frame);
        } catch { this.failPending(new BridgeError("t3_contract_changed", "T3 sent an incompatible RPC frame.")); socket.terminate(); }
      });
    });
    this.lastPong = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 60_000) { this.socket?.terminate(); return; }
      this.socket?.send(JSON.stringify({ _tag: "Ping" }));
    }, 20_000);
  }

  private onFrame(raw: unknown): void {
    const frame = z.object({ _tag: z.string() }).catchall(z.unknown()).parse(raw);
    if (frame._tag === "Pong") { this.lastPong = Date.now(); return; }
    if (frame._tag === "Ping") { this.socket?.send(JSON.stringify({ _tag: "Pong" })); return; }
    if (frame._tag === "Defect") { this.failPending(new BridgeError("t3_rpc_defect", "T3 reported an internal RPC failure.")); return; }
    if (frame._tag !== "Exit" || (typeof frame.requestId !== "string" && typeof frame.requestId !== "number")) return;
    const id = String(frame.requestId);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    const exit = z.object({ _tag: z.string(), value: z.unknown().optional() }).parse(frame.exit);
    if (exit._tag === "Success") pending.resolve(exit.value);
    else pending.reject(new BridgeError("t3_rpc_failed", "T3 refused the RPC operation. No automatic retry was attempted."));
  }

  async rpc<S extends z.ZodType>(tag: string, payload: unknown, schema: S): Promise<z.infer<S>> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN)
      throw new BridgeError("t3_disconnected", "T3 is not connected.");
    if (this.pending.size >= 16) throw new BridgeError("rpc_limit", "The T3 request concurrency limit was reached.");
    const socket = this.socket;
    const id = `${++this.serial}`;
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
        reject(new BridgeError("t3_timeout", "T3 RPC exceeded its deadline. The bridge did not retry it."));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BridgeError("t3_contract_changed", `T3 returned an incompatible ${tag} result.`);
    return parsed.data;
  }

  private failPending(error: BridgeError): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  get expiresAt(): number { return this.issued ? Date.parse(this.issued.expiresAt) : 0; }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.terminate(); this.socket = undefined;
    this.failPending(new BridgeError("t3_closed", "The bridge closed its T3 connection."));
    if (this.issued) {
      const id = this.issued.sessionId; this.issued = undefined;
      await this.cli(["auth", "session", "revoke", "--base-dir", this.config.baseDir, id]).catch(() => undefined);
    }
  }
}
