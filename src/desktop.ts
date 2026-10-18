import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Config, loadConfig } from "./config.js";
import { BridgeError, errorCode, publicError } from "./errors.js";
import { Catalog } from "./orca/catalog.js";
import { installedOrcaRpc } from "./orca/runtime.js";
import { State } from "./state.js";
import { T3Connection } from "./t3/connection.js";
import { configureProvider, isPriorBridge, instanceSchema, settingsSchema } from "./t3/setup.js";
import { syncOnce, syncScopes } from "./t3/sync.js";
import { removeLegacyService } from "./service.js";
import { digest } from "./util.js";

export interface DesktopEvent {
  phase: "connecting" | "connected" | "waiting" | "attention";
  message: string; code?: string; discovered?: number; imported?: number; lastSync?: string;
}

export function syncLease(state: State, config: Config): () => void {
  try { return state.acquire(`sync:${digest({ baseDir: config.t3?.baseDir, instance: config.t3?.instanceId })}`); }
  catch (error) {
    if (errorCode(error) === "session_busy") throw new BridgeError("sync_busy", "Another sync worker is running. Stop the command-line watcher or login service, then try again.");
    throw error;
  }
}

export async function discoverT3Origin(config: Config): Promise<Config> {
  if (!config.t3?.autoDetectUrl) return config;
  try {
    const runtime = z.object({ port: z.number().int().min(1).max(65535) }).parse(
      JSON.parse(await readFile(join(config.t3.baseDir, "userdata", "server-runtime.json"), "utf8")));
    return { ...config, t3: { ...config.t3, url: `http://127.0.0.1:${runtime.port}/` } };
  } catch { throw new BridgeError("t3_unavailable", "Waiting for T3 Code to open."); }
}

async function requireT3(config: Config): Promise<void> {
  if (!config.t3) throw new BridgeError("t3_not_configured", "Connect Orca and T3 in the app first.");
  try {
    const response = await fetch(new URL("/api/auth/session", config.t3.url), {
      signal: AbortSignal.timeout(2000), redirect: "error",
    });
    await response.body?.cancel();
    if (![200, 401].includes(response.status)) throw new Error("not ready");
  } catch { throw new BridgeError("t3_unavailable", "Waiting for T3 Code to open."); }
}

export async function connectDesktop(configFile: string, entrypoint: string): Promise<void> {
  const config = await discoverT3Origin(await loadConfig(configFile));
  const catalog = new Catalog(installedOrcaRpc(config), config);
  await catalog.status();
  await requireT3(config);
  if (!config.t3) throw new BridgeError("t3_not_configured", "Connect Orca and T3 first.");
  const connection = await T3Connection.open(config.t3, syncScopes);
  try {
    const settings = await connection.rpc("server.getSettings", {}, settingsSchema);
    const prior = settings.providerInstances[config.t3.instanceId];
    // Remove only a byte-for-byte matching CLI LaunchAgent before taking ownership.
    if (await isPriorBridge(prior, configFile)) {
      const old = instanceSchema.parse(prior).config;
      await removeLegacyService(config, configFile, old.commandArgs[0]!);
    }
    await configureProvider(connection, config, configFile, entrypoint, true, true);
  } finally { await connection.close(); }
}

const transient = new Set(["t3_unavailable", "orca_unavailable", "orca_disconnected", "orca_timeout",
  "ENOENT", "t3_disconnected", "t3_socket_failed", "t3_timeout", "t3_closed", "t3_transport_failed"]);
export function desktopFailure(error: unknown): { retry: boolean; event: DesktopEvent } {
  const code = errorCode(error);
  const retry = transient.has(code);
  return { retry, event: { phase: retry ? "waiting" : "attention", code,
    message: code === "ENOENT" || code.startsWith("orca_") && retry
      ? "Waiting for Orca to open. Sync will resume automatically."
      : code.startsWith("t3_") && retry ? "Waiting for T3 Code. Sync will resume automatically." : publicError(error) } };
}

/** A single reusable connection; retry only availability failures, never agent prompts. */
export async function runDesktop(configFile: string, entrypoint: string, state: State,
  signal: AbortSignal, emit: (event: DesktopEvent) => void,
  wait: (milliseconds: number) => Promise<void>): Promise<void> {
  const initial = await loadConfig(configFile);
  const release = syncLease(state, initial);
  let connection: T3Connection | undefined;
  let failures = 0;
  try {
    while (!signal.aborted) {
      let interval = initial.polling.syncMs;
      try {
        const config = await discoverT3Origin(await loadConfig(configFile));
        const catalog = new Catalog(installedOrcaRpc(config), config);
        await catalog.status();
        await requireT3(config);
        if (!config.t3) throw new BridgeError("t3_not_configured", "Connect Orca and T3 first.");
        if (!connection || connection.expiresAt - Date.now() < 60_000 || connection.config.url !== config.t3.url) {
          await connection?.close();
          connection = await T3Connection.open(config.t3, syncScopes);
        }
        if (signal.aborted) break;
        const result = await syncOnce(catalog, connection, state, config, { configFile, entrypoint });
        failures = 0;
        emit({ phase: "connected", message: result.skipped
          ? `Sync is active. ${result.skipped} session(s) are in removed T3 projects and were left unchanged.`
          : "New Orca sessions sync automatically.", ...result, lastSync: new Date().toISOString() });
      } catch (error) {
        await connection?.close(); connection = undefined;
        if (signal.aborted) break;
        const failure = desktopFailure(error);
        emit(failure.event);
        if (!failure.retry) return;
        interval = Math.min(120_000, 15_000 * 2 ** Math.min(++failures, 3));
      }
      if (!signal.aborted) await wait(interval);
    }
  } finally { await connection?.close(); release(); }
}
