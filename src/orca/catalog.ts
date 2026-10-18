import { isAbsolute, resolve } from "node:path";
import type { Config } from "../config.js";
import { permitsWorktree } from "../config.js";
import { BridgeError } from "../errors.js";
import { canonicalPath } from "../util.js";
import { callOrca, type OrcaRpc } from "./runtime.js";
import { decodeSession, encodeSession, type SessionRef } from "./session-id.js";
import { statusSchema, tabsSchema, terminalListSchema, worktreeListSchema } from "./schemas.js";

export interface OrcaSession {
  id: string;
  ref: SessionRef;
  cwd: string;
  title: string;
  agent: string;
  updatedAt: number;
  terminal?: string;
  writable: boolean;
  transcript?: { id: string; transcriptPath?: string };
  activity?: string;
}

export class Catalog {
  private cache: { at: number; sessions: OrcaSession[] } | undefined;
  constructor(readonly rpc: OrcaRpc, readonly config: Config) {}

  async list(cwd?: string, fresh = false): Promise<OrcaSession[]> {
    if (fresh || !this.cache || Date.now() - this.cache.at > 1000) {
      const limit = 4096;
      const terminals = await callOrca(this.rpc, "terminal.list", terminalListSchema,
        { limit, includeVisualLayouts: false });
      if (terminals.truncated) throw new BridgeError("catalog_limit",
        "Orca has more terminals than the configured session limit. Narrow includeWorktrees or raise the limit.");
      const sessions: OrcaSession[] = [];
      for (const row of terminals.terminals) {
        // A shell is deliberately never treated as a coding agent prompt target.
        if (!row.agentIdentity || ["none", "shell", "terminal", "unknown"].includes(row.agentIdentity) ||
          !row.ptyId || !row.incarnationId || !row.connected || !isAbsolute(row.worktreePath) ||
          !permitsWorktree(this.config, row.worktreePath)) continue;
        const ref: SessionRef = { kind: "terminal", source: this.config.sourceId,
          host: row.executionHostId ?? "local", pty: row.ptyId, incarnation: row.incarnationId };
        sessions.push({ id: encodeSession(ref), ref, cwd: row.worktreePath,
          title: row.title || `${row.agentIdentity} in ${row.worktreePath.split("/").at(-1)}`,
          agent: row.agentIdentity, updatedAt: row.lastOutputAt ?? 0,
          terminal: row.handle, writable: row.writable });
      }
      const tabs = await callOrca(this.rpc, "session.tabs.listAll", tabsSchema);
      for (const session of sessions) {
        if (session.ref.kind !== "terminal") continue;
        const ref = session.ref;
        const tab = tabs.snapshots.flatMap((snapshot) => snapshot.tabs).find((tab) =>
          tab.type === "terminal" && tab.ptyId === ref.pty && tab.incarnationId === ref.incarnation);
        if (tab?.agentStatus?.providerSession) session.transcript = {
          id: tab.agentStatus.providerSession.id,
          ...(tab.agentStatus.providerSession.transcriptPath ?
            { transcriptPath: tab.agentStatus.providerSession.transcriptPath } : {}),
        };
        if (tab?.agentStatus) session.activity = tab.agentStatus.state;
      }
      const nativeTabs = tabs.snapshots.flatMap((snapshot) => snapshot.tabs.filter((tab) =>
        tab.type === "agent-session" && tab.sessionId && tab.agent).map((tab) => ({ snapshot, tab })));
      if (nativeTabs.length) {
        const roots = await callOrca(this.rpc, "worktree.list", worktreeListSchema, { limit });
        if (roots.truncated) throw new BridgeError("catalog_limit", "Orca workspace listing was truncated.");
        for (const { snapshot, tab } of nativeTabs) {
          const root = roots.worktrees.find((root) => root.id === snapshot.worktree);
          if (!root || !isAbsolute(root.path) || !tab.sessionId || !tab.agent || !permitsWorktree(this.config, root.path)) continue;
          const ref: SessionRef = { kind: "native", source: this.config.sourceId, session: tab.sessionId };
          sessions.push({ id: encodeSession(ref), ref, cwd: root.path,
            title: tab.title || `${tab.agent} in ${root.path.split("/").at(-1)}`,
            agent: tab.agent, updatedAt: 0, writable: !snapshot.agentSessionsUnverifiable });
        }
      }
      const unique = [...new Map(sessions.map((session) => [session.id, session])).values()];
      if (unique.length > this.config.limits.sessions) throw new BridgeError("catalog_limit", "The configured session limit was exceeded.");
      unique.sort((a, b) => a.id.localeCompare(b.id));
      this.cache = { at: Date.now(), sessions: unique };
    }
    if (!cwd) return this.cache.sessions;
    const canonical = await canonicalPath(cwd);
    const matches: OrcaSession[] = [];
    for (const session of this.cache.sessions) {
      if (resolve(session.cwd) === resolve(cwd) || await canonicalPath(session.cwd).catch(() => null) === canonical)
        matches.push(session);
    }
    return matches;
  }

  async get(id: string, cwd?: string): Promise<OrcaSession> {
    decodeSession(id, this.config.sourceId);
    const found = (await this.list(cwd, true)).find((session) => session.id === id);
    if (!found) throw new BridgeError("session_missing", "That Orca session is closed, replaced, or outside this workspace.");
    return found;
  }

  async status() { return await callOrca(this.rpc, "status.get", statusSchema); }
}
