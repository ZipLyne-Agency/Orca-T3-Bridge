import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";
import { BridgeError } from "../errors.js";
import { digest } from "../util.js";
import type { OrcaSession } from "./catalog.js";
import { callOrca, type OrcaRpc } from "./runtime.js";
import { historySchema, terminalReadSchema, terminalWaitSchema, transcriptSchema } from "./schemas.js";

export interface DisplayItem {
  id: string;
  revision: string;
  role: "user" | "assistant" | "tool" | "reasoning" | "system";
  blocks: { type: string; [key: string]: unknown }[];
}
export interface Snapshot {
  items: DisplayItem[];
  working: boolean | null;
  waiting: boolean;
  exited: boolean;
  truncated: boolean;
  fence?: number;
  prompts: z.infer<typeof historySchema>["page"]["items"];
}

function bound(items: DisplayItem[], config: Config): { items: DisplayItem[]; truncated: boolean } {
  let bytes = 0;
  const kept: DisplayItem[] = [];
  for (const item of items.slice().reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > config.limits.historyBytes || kept.length >= config.limits.historyItems) break;
    kept.push(item);
  }
  return { items: kept.reverse(), truncated: kept.length !== items.length };
}

export async function readNative(rpc: OrcaRpc, session: OrcaSession, config: Config): Promise<Snapshot> {
  if (session.ref.kind !== "native") throw new Error("native reader target");
  const pageLimit = Math.min(200, config.limits.historyItems);
  let response = await callOrca(rpc, "agentSession.history", historySchema,
    { sessionId: session.ref.session, direction: "tail", limit: pageLimit });
  const latest = response.page;
  const pages = [latest];
  let total = latest.items.length;
  let bytes = Buffer.byteLength(JSON.stringify(latest.items));
  const visited = new Set<string>();
  while (response.page.hasOlder && total < config.limits.historyItems && bytes < config.limits.historyBytes) {
    const cursor = response.page.window.oldest;
    if (!cursor) break;
    const key = JSON.stringify(cursor);
    if (visited.has(key)) throw new BridgeError("orca_contract_changed", "Orca history pagination repeated a cursor.");
    visited.add(key);
    response = await callOrca(rpc, "agentSession.history", historySchema,
      { sessionId: session.ref.session, direction: "before", cursor,
        limit: Math.min(200, config.limits.historyItems - total) });
    if (response.page.epoch !== latest.epoch || response.page.items.length === 0) break;
    total += response.page.items.length;
    bytes += Buffer.byteLength(JSON.stringify(response.page.items));
    pages.unshift(response.page);
  }
  const rows = [...new Map(pages.flatMap((page) => page.items).map((item) => [item.itemId, item])).values()];
  const items: DisplayItem[] = rows.map((row) => {
    const body = row.body;
    if (body.kind === "message") {
      const parsed = z.object({ role: z.enum(["user", "assistant", "tool", "reasoning", "system"]),
        blocks: z.array(z.object({ type: z.string() }).catchall(z.unknown())) }).parse(body);
      return { id: row.itemId, revision: `${row.revision}`, ...parsed };
    }
    if (body.kind === "tool-call") return { id: row.itemId, revision: `${row.revision}`,
      role: "tool", blocks: [{ type: "tool-call", ...body }] };
    if (body.kind === "approval" || body.kind === "question") {
      const title = typeof body.title === "string" ? body.title : typeof body.question === "string" ? body.question : "Orca request";
      const detail = typeof body.detail === "string" ? body.detail : "";
      const subject = z.object({ kind: z.literal("plan"), text: z.string() }).safeParse(body.subject);
      return { id: row.itemId, revision: `${row.revision}`, role: "system",
        blocks: [{ type: "text", text: `${body.kind === "approval" ? "Approval" : "Question"}: ${title}\n${detail}${subject.success ? `\n${subject.data.text}` : ""}\n` }] };
    }
    return { id: row.itemId, revision: `${row.revision}`, role: "system", blocks: [] };
  });
  const bounded = bound(items.filter((item) => item.blocks.length), config);
  const prompts = rows.filter((row) => row.body.kind === "approval" || row.body.kind === "question");
  const pending = prompts.filter((row) => {
    const resolution = row.body.resolution;
    return typeof resolution === "object" && resolution !== null && "state" in resolution && resolution.state === "pending";
  });
  const working = typeof latest.working === "boolean" ? latest.working : null;
  return { ...bounded, truncated: bounded.truncated || Boolean(pages[0]?.hasOlder),
    working, waiting: pending.length > 0, exited: false, prompts: pending,
    ...(latest.fence ? { fence: latest.fence } : {}) };
}

export class TerminalReader {
  private cursor: string | null = null;
  private streamItems: DisplayItem[] = [];
  private usingTranscript = false;
  constructor(private readonly rpc: OrcaRpc, private readonly config: Config) {}

  async read(session: OrcaSession): Promise<Snapshot> {
    if (!session.terminal) throw new BridgeError("session_missing", "The Orca terminal is unavailable.");
    const wait = await callOrca(this.rpc, "terminal.wait", terminalWaitSchema,
      { terminal: session.terminal, for: "tui-idle", timeoutMs: 1 }).catch((error: unknown) => {
        // Orca reports an unmet idle condition as a typed RPC timeout. It is a
        // busy observation; socket/deadline failures must still stop the read.
        if (!(error instanceof BridgeError) || error.code !== "timeout") throw error;
        return { wait: { handle: session.terminal!, satisfied: false,
          status: "running" as const, exitCode: null, blockedReason: undefined } };
      });
    if (session.transcript && ["claude", "codex", "opencode"].includes(session.agent)) {
      try {
        const read = await callOrca(this.rpc, "nativeChat.readSession", transcriptSchema,
          { agent: session.agent, sessionId: session.transcript.id,
            ...(session.transcript.transcriptPath ? { transcriptPath: session.transcript.transcriptPath } : {}),
            limit: this.config.limits.historyItems });
        if (!read.error && (read.messages.length > 0 || this.usingTranscript)) {
          this.usingTranscript = true;
          const items = read.messages.map((message) => ({ id: message.id,
            revision: digest(message), role: message.role, blocks: message.blocks }));
          const bounded = bound(items, this.config);
          return { ...bounded, truncated: bounded.truncated || Boolean(read.hasMore),
            working: !wait.wait.satisfied && !wait.wait.blockedReason && wait.wait.status === "running",
            waiting: Boolean(wait.wait.blockedReason), exited: wait.wait.status === "exited", prompts: [] };
        }
      } catch (error) {
        // Once transcript IDs are published, never replace them with a second copy from scrollback.
        if (this.usingTranscript) throw error;
        if (!(error instanceof BridgeError) || !["method_not_found", "method_not_supported", "orca_contract_changed"].includes(error.code)) throw error;
      }
    }
    const numericCursor = this.cursor === null ? undefined : Number(this.cursor);
    if (numericCursor !== undefined && (!Number.isSafeInteger(numericCursor) || numericCursor < 0))
      throw new BridgeError("orca_contract_changed", "Orca changed its terminal cursor format.");
    const { terminal } = await callOrca(this.rpc, "terminal.read", terminalReadSchema,
      { terminal: session.terminal, ...(numericCursor === undefined ? {} : { cursor: numericCursor }),
        limit: Math.min(1000, this.config.limits.historyItems) });
    const text = cleanTerminal(terminal.tail.join("\n"));
    if (text && terminal.nextCursor !== this.cursor) this.streamItems.push({
      id: `terminal-${this.cursor ?? "start"}-${terminal.nextCursor ?? "end"}`,
      revision: digest(text), role: "assistant", blocks: [{ type: "text", text }],
    });
    this.cursor = terminal.nextCursor;
    const bounded = bound(this.streamItems, this.config);
    this.streamItems = bounded.items;
    return { ...bounded, truncated: bounded.truncated || terminal.truncated || Boolean(terminal.limited),
      working: !wait.wait.satisfied && !wait.wait.blockedReason && terminal.status === "running",
      waiting: Boolean(wait.wait.blockedReason), exited: terminal.status === "exited", prompts: [] };
  }
}

export function cleanTerminal(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
