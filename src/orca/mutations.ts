import { z } from "zod";
import type { Catalog, OrcaSession } from "./catalog.js";
import { callOrca, type OrcaRpc } from "./runtime.js";
import { mutationSchema, terminalSendSchema } from "./schemas.js";
import { BridgeError } from "../errors.js";
import { digest, operationId } from "../util.js";
import type { State } from "../state.js";

const durableTerminalCapability = "terminal.prompt-delivery.v1";

export class Mutations {
  constructor(private readonly catalog: Catalog, private readonly state: State) {}
  async send(session: OrcaSession, text: string, fence?: number): Promise<{ operationId: string; startObserved: boolean }> {
    const current = await this.catalog.get(session.id, session.cwd);
    if (!current.writable) throw new BridgeError("session_read_only", "This Orca session is read-only.");
    const release = this.state.acquire(session.id);
    const id = operationId();
    let recorded = false;
    try {
      if (current.ref.kind === "terminal") {
        const running = await callOrca(this.catalog.rpc, "terminal.isRunningAgent",
          z.object({ isRunningAgent: z.boolean() }), { terminal: current.terminal });
        if (!running.isRunningAgent) throw new BridgeError("agent_exited", "The agent exited; no text was sent to its shell.");
        const status = await this.catalog.status();
        if (!status.capabilities.includes(durableTerminalCapability)) throw new BridgeError("orca_incompatible",
          "This Orca runtime cannot record durable prompt delivery. Update Orca before sending from T3.");
        this.state.begin(id, session.id, digest(text)); recorded = true;
        // Match Orca's CLI atomic agent-prompt path. requireAgentStatus belongs
        // to raw input and explicitly rejects text combined with Enter.
        const result = await callOrca(this.catalog.rpc, "terminal.send", terminalSendSchema, {
          terminal: current.terminal, text, enter: true, agentPrompt: true,
          requireWriteSettlement: true, waitSubmitMs: 1000,
          client: { id: "orca-t3-bridge", type: "desktop" },
        }, { orchestrationRequestId: id, terminalPromptPreflight: { runtimeId: status.runtimeId } });
        if (!result.send.accepted) {
          this.state.finish(id, "rejected");
          throw new BridgeError("send_refused", "Orca refused the prompt. It was not retried.");
        }
        if (result.send.prompt?.requestId !== id) throw new BridgeError("delivery_unknown",
          "Orca accepted input without the expected durable receipt. Inspect Orca before sending again.", true);
        this.state.finish(id, "accepted");
        return { operationId: id, startObserved: result.send.prompt.stages.includes("turn_started") };
      }
      if (!fence) throw new BridgeError("orca_incompatible", "Orca did not expose a write fence for this chat.");
      this.state.begin(id, session.id, digest(text)); recorded = true;
      const fields = { body: { kind: "message", role: "user", blocks: [{ type: "text", text }] } };
      const value = await mutateNative(this.catalog.rpc, current.ref.session, fence, "agentSession.send", fields, id);
      const submission = z.object({ submission: z.object({
        dispatchState: z.enum(["pending", "accepted", "rejected", "unknown"]),
      }) }).safeParse(value);
      if (!submission.success || submission.data.submission.dispatchState === "unknown")
        throw new BridgeError("delivery_unknown", "Orca's prompt receipt could not be verified.", true);
      if (submission.data.submission.dispatchState === "rejected") {
        this.state.finish(id, "rejected");
        throw new BridgeError("send_refused", "Orca rejected the message before dispatch.");
      }
      this.state.finish(id, "accepted");
      return { operationId: id, startObserved: submission.data.submission.dispatchState === "accepted" };
    } catch (error) {
      if (recorded && !(error instanceof BridgeError && error.code === "send_refused"))
        this.state.finish(id, error instanceof BridgeError && error.code === "native_refused" ? "rejected" : "unknown");
      throw error;
    } finally { release(); }
  }

  async cancel(session: OrcaSession, fence?: number): Promise<void> {
    const current = await this.catalog.get(session.id, session.cwd);
    if (current.ref.kind === "native") {
      if (!fence) throw new BridgeError("orca_incompatible", "No current Orca write fence is available.");
      await mutateNative(this.catalog.rpc, current.ref.session, fence, "agentSession.cancel", {});
    } else {
      await callOrca(this.catalog.rpc, "terminal.send", terminalSendSchema, {
        terminal: current.terminal, interrupt: true, text: "\u0003", requireWriteSettlement: true,
        client: { id: "orca-t3-bridge", type: "desktop" },
      });
    }
  }
}

export async function mutateNative(rpc: OrcaRpc, sessionId: string, fence: number,
  method: string, fields: Record<string, unknown>, id = operationId()): Promise<unknown> {
  const result = await callOrca(rpc, method, mutationSchema, {
    envelope: { sessionId, clientOperationId: id, expectedRuntimeFence: fence,
      payloadFingerprint: digest({ method, sessionId, fields }) }, ...fields,
  });
  if (!result.ok) throw new BridgeError("native_refused", `Orca refused the operation (${result.refusal.code}).`);
  return result.value;
}
