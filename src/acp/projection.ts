import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import type { DisplayItem, Snapshot } from "../orca/readers.js";
import { clipUtf8 } from "../util.js";
import type { State } from "../state.js";

export type Notify = (notification: SessionNotification) => Promise<void>;

/** ACP chunks append. Track every source row so rereads do not duplicate its text or tools. */
export class Projection {
  private readonly rows = new Map<string, { revision: string; texts: Map<number, string> }>();
  private readonly suppressedUsers: string[] = [];
  private warnedTruncated = false;
  constructor(private readonly sessionId: string, private readonly notify: Notify,
    private readonly durable?: { state: State; key: string; labelUsers: boolean }) {}

  suppressUser(text: string): void { this.suppressedUsers.push(text); }
  async text(text: string, id = `notice-${Date.now()}`): Promise<void> {
    await this.update({ sessionUpdate: "agent_message_chunk", messageId: id,
      content: { type: "text", text } });
  }
  private async update(update: SessionUpdate): Promise<void> {
    await this.notify({ sessionId: this.sessionId, update });
  }

  async apply(snapshot: Snapshot, replay = false, includeHistoryNotice = true): Promise<void> {
    if (replay) { this.rows.clear(); this.warnedTruncated = false; }
    if (snapshot.truncated && includeHistoryNotice && !this.warnedTruncated) {
      // Keep the import notice separate from source-row pruning so reconnects
      // remember it even after the displayed history window has moved.
      const noticesKey = this.durable ? `${this.durable.key}:notices` : undefined;
      if (!this.durable || !this.durable.state.projectedRevision(noticesKey!, "history-window")) {
        await this.text("Showing recent Orca history. Older messages are available in Orca.\n", "history-window");
        if (this.durable) this.durable.state.markProjected(noticesKey!, "history-window", "1");
      }
      this.warnedTruncated = true;
    }
    for (const item of snapshot.items) await this.item(item, replay);
    const retained = new Set(snapshot.items.map((item) => item.id));
    for (const key of this.rows.keys()) if (!retained.has(key)) this.rows.delete(key);
    this.durable?.state.pruneProjected(this.durable.key, retained);
  }

  private async item(item: DisplayItem, replay: boolean): Promise<void> {
    const previous = this.rows.get(item.id);
    if (previous?.revision === item.revision) return;
    if (!previous && this.durable?.state.projectedRevision(this.durable.key, item.id) === item.revision) {
      const texts = new Map<number, string>();
      item.blocks.forEach((block, index) => { if (block.type === "text" && typeof block.text === "string") texts.set(index, block.text); });
      this.rows.set(item.id, { revision: item.revision, texts });
      return;
    }
    const texts = previous?.texts ?? new Map<number, string>();
    const fullText = item.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
    if (!replay && item.role === "user" && typeof fullText === "string") {
      const matched = this.suppressedUsers.indexOf(fullText);
      if (matched >= 0) {
        this.suppressedUsers.splice(matched, 1);
        item.blocks.forEach((block, index) => {
          if (block.type === "text" && typeof block.text === "string") texts.set(index, block.text);
        });
        this.rows.set(item.id, { revision: item.revision, texts });
        this.durable?.state.markProjected(this.durable.key, item.id, item.revision);
        return;
      }
    }
    for (const [index, block] of item.blocks.entries()) {
      if (block.type === "text" && typeof block.text === "string") {
        const prior = texts.get(index) ?? "";
        if (block.text === prior) continue;
        const suffix = block.text.startsWith(prior) ? block.text.slice(prior.length) :
          `\n[Orca revised this message]\n${block.text}`;
        const label = this.durable?.labelUsers && prior === "" ?
          item.role === "user" ? "**You in Orca**\n\n" : item.role === "assistant" ? "**Orca**\n\n" : "" : "";
        await this.update({ sessionUpdate: item.role === "user" && !this.durable?.labelUsers ? "user_message_chunk" :
          item.role === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId: `orca:${item.id}:${index}`,
          content: { type: "text", text: label + suffix },
          _meta: { orcaItemId: item.id },
        });
        texts.set(index, block.text);
      } else if (block.type === "tool-call") {
        const id = typeof block.callId === "string" ? block.callId : `${item.id}:${index}`;
        const status = block.state === "running" ? "in_progress" : block.state === "failed" ? "failed" : "completed";
        const output = typeof block.output === "object" && block.output !== null && "head" in block.output &&
          typeof block.output.head === "string" ? block.output.head : undefined;
        await this.update({ sessionUpdate: previous ? "tool_call_update" : "tool_call",
          toolCallId: id, title: typeof block.name === "string" ? block.name : "Orca tool",
          status, rawInput: block.input,
          ...(output === undefined ? {} : { content: [{ type: "content", content: { type: "text", text: output } }] }),
        });
      } else if (block.type === "tool-result" && typeof block.output === "string") {
        if (typeof block.callId === "string") await this.update({ sessionUpdate: "tool_call_update",
          toolCallId: block.callId, status: block.isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: clipUtf8(block.output, 262_144) } }],
        });
        else await this.text(clipUtf8(block.output, 262_144), `tool-result:${item.id}:${index}`);
      } else if (!previous) {
        await this.text(`[Orca ${block.type} content is available in the original session.]\n`, `unsupported:${item.id}:${index}`);
      }
    }
    this.rows.set(item.id, { revision: item.revision, texts });
    this.durable?.state.markProjected(this.durable.key, item.id, item.revision);
  }
}
