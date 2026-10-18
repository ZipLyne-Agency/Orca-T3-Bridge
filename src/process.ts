import { spawn } from "node:child_process";
import { BridgeError } from "./errors.js";

/** Bounded, shell-free subprocess. Captured output is never included in an error. */
export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false,
      stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let ended = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new BridgeError("process_timeout", "A bridge subprocess exceeded its deadline."));
    }, options.timeoutMs ?? 30_000);
    function finish(error?: BridgeError): void {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString("utf8"));
    }
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1_048_576)) {
        child.kill("SIGKILL");
        finish(new BridgeError("process_output_limit", "A bridge subprocess exceeded its output limit."));
      } else chunks.push(chunk);
    });
    // Drain diagnostics without retaining credentials, prompts, or provider output.
    child.stderr.on("data", () => undefined);
    child.once("error", () => finish(new BridgeError("process_unavailable", "A required bridge subprocess could not start.")));
    child.once("close", (code) => finish(code === 0 ? undefined :
      new BridgeError("process_failed", "A bridge subprocess failed. Run doctor to check its installation.")));
  });
}
