import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "./errors.js";
import type { Config } from "./config.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function destinationKey(session: string, config: Config): string {
  return digest({ session, baseDir: config.t3?.baseDir, instanceId: config.t3?.instanceId });
}

export function operationId(): string {
  return `${Date.now()}-${randomUUID().replaceAll("-", "")}`;
}

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { throw new BridgeError("workspace_missing", "The session workspace is unavailable on this machine."); }
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, signal ? { signal } : {}); }
  catch (error) { if (!signal?.aborted) throw error; }
}

export function clipUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let end = Math.min(text.length, bytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > bytes) end--;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError("timeout", "The bridge request timed out.")), ms);
      onAbort = () => reject(new BridgeError("cancelled", "The bridge connection closed."));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
