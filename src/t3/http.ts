import { z } from "zod";
import { BridgeError } from "../errors.js";

/** All outbound HTTP has an absolute deadline, no redirect, and a byte bound. */
export async function httpJson<S extends z.ZodType>(url: URL, schema: S,
  init: RequestInit = {}, timeoutMs = 15_000): Promise<z.infer<S>> {
  // T3 repeats text across nodes, messages and timeline projections, and keeps
  // complete turns even in bounded snapshots. Budget this endpoint separately;
  // ordinary API responses retain their smaller cap.
  const maxBytes = /^\/api\/orchestration\/threads\/[^/]+\/bounded$/.test(url.pathname)
    ? 16_777_216 : 4_194_304;
  const response = await fetch(url, { ...init, redirect: "error",
    signal: AbortSignal.timeout(timeoutMs) }).catch(() => {
      throw new BridgeError("t3_transport_failed", "The T3 HTTP connection failed. No mutation was automatically retried.");
    });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BridgeError(`t3_http_${response.status}`, `T3 refused the request (HTTP ${response.status}).`);
  }
  if (!response.body) throw new BridgeError("t3_empty_response", "T3 returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BridgeError("t3_response_limit", "T3 response exceeded the bridge limit.");
      chunks.push(value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = schema.safeParse(raw);
    if (!result.success) throw new BridgeError("t3_contract_changed", "T3 returned an incompatible response. Run doctor after updating T3.");
    return result.data;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
