import { z } from "zod";
import { BridgeError } from "../errors.js";

const refSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), source: z.string(), host: z.string(),
    pty: z.string().min(1).max(512), incarnation: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("native"), source: z.string(), session: z.string().min(1).max(512) }).strict(),
]);
export type SessionRef = z.infer<typeof refSchema>;
export function encodeSession(ref: SessionRef): string {
  const encoded = `orca-${Buffer.from(JSON.stringify(refSchema.parse(ref))).toString("base64url")}`;
  if (encoded.length > 1024) throw new BridgeError("session_id_too_large", "Orca session identity exceeds T3's limit.");
  return encoded;
}
export function decodeSession(value: string, source: string): SessionRef {
  try {
    if (!value.startsWith("orca-") || value.length > 1024 || !/^orca-[\w-]+$/.test(value)) throw new Error();
    const ref = refSchema.parse(JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")));
    if (ref.source !== source || encodeSession(ref) !== value) throw new Error();
    return ref;
  } catch { throw new BridgeError("invalid_session", "This session does not belong to the configured Orca source."); }
}
