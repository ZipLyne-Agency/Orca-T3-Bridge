import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { configSchema, type Config } from "../../src/config.js";
import type { OrcaRpc, RpcOptions } from "../../src/orca/runtime.js";
import { BridgeError } from "../../src/errors.js";

interface Message { id: string; role: string; blocks: { type: string; text: string }[] }
interface Terminal {
  pty: string; incarnation: string; handle: string; alive: boolean;
  messages: Message[]; remaining: number; waiting: boolean; lastOutput: number;
}

export class FakeOrca implements OrcaRpc {
  readonly terminals: Terminal[] = [];
  readonly calls: { method: string; params: unknown; options?: RpcOptions }[] = [];
  sends = 0;
  interrupts = 0;
  starts = 0;
  dropSendReply = false;
  nativeEnabled = false;
  nativeWorking = 0;
  nativeItems: Record<string, unknown>[] = [];
  nativeApprovals: Record<string, unknown>[] = [];
  cwd = "";
  constructor(cwd: string) {
    this.cwd = cwd;
    this.terminals.push({ pty: "pty-1", incarnation: "inc-1", handle: "term-1", alive: true,
      messages: [this.message("history-user", "user", "Existing Orca question"),
        this.message("history-answer", "assistant", "Existing Orca answer")],
      remaining: 0, waiting: false, lastOutput: Date.now() });
  }
  message(id: string, role: string, text: string): Message { return { id, role, blocks: [{ type: "text", text }] }; }

  async call(method: string, params?: unknown, options?: RpcOptions): Promise<unknown> {
    this.calls.push({ method, params, ...(options ? { options } : {}) });
    const p = z.record(z.string(), z.unknown()).parse(params ?? {});
    const terminal = this.terminals.find((terminal) => terminal.handle === p.terminal) ?? this.terminals[0];
    if (!terminal) throw new Error("fixture empty");
    switch (method) {
      case "status.get": return { runtimeId: "fake-runtime", appVersion: "1.4.226", graphStatus: "ready",
        capabilities: ["terminal.prompt-delivery.v1"] };
      case "terminal.list": return { terminals: this.terminals.map((terminal) => ({
        handle: terminal.handle, ptyId: terminal.pty, incarnationId: terminal.incarnation,
        worktreeId: "workspace-1", worktreePath: this.cwd, executionHostId: "local",
        title: "Fixture Orca session", connected: terminal.alive, writable: terminal.alive,
        lastOutputAt: terminal.lastOutput, agentIdentity: "codex",
      })), truncated: false, totalCount: this.terminals.length };
      case "session.tabs.listAll": return { snapshots: [{ worktree: "workspace-1", publicationEpoch: "fixture",
        tabs: [...this.terminals.map((terminal) => ({ type: "terminal", id: terminal.pty,
          ptyId: terminal.pty, incarnationId: terminal.incarnation,
          agentStatus: { state: terminal.remaining ? "working" : "idle",
            providerSession: { key: "session_id", id: `provider-${terminal.pty}` } } })),
        ...(this.nativeEnabled ? [{ type: "agent-session", id: "native-tab", sessionId: "native-1",
          agent: "claude", title: "Fixture native session" }] : [])] }] };
      case "worktree.list": return { worktrees: [{ id: "workspace-1", path: this.cwd }], truncated: false };
      case "terminal.isRunningAgent": return { isRunningAgent: terminal.alive };
      case "nativeChat.readSession": return { messages: terminal.messages, hasMore: false, beforeOffset: 0 };
      case "terminal.read": return { terminal: { handle: terminal.handle, status: terminal.alive ? "running" : "exited",
        tail: terminal.messages.map((message) => message.blocks[0]?.text ?? ""), truncated: false,
        nextCursor: `${terminal.messages.length}`, latestCursor: `${terminal.messages.length}` } };
      case "terminal.wait": {
        if (terminal.remaining > 0 && --terminal.remaining === 0) {
          terminal.messages.push(this.message(`answer-${this.sends}`, "assistant", `Fake response ${this.sends}`));
          terminal.lastOutput++;
        }
        if (terminal.remaining > 0 && !terminal.waiting)
          throw new BridgeError("timeout", "Orca refused terminal.wait (timeout).");
        return { wait: { handle: terminal.handle, satisfied: terminal.remaining === 0 && !terminal.waiting,
          status: terminal.alive ? "running" : "exited", exitCode: null,
          ...(terminal.waiting ? { blockedReason: "agent-approval-prompt" } : {}) } };
      }
      case "terminal.send": {
        // Match Orca 1.4.226: the raw-input sendable guard rejects combined
        // text + Enter. Atomic agent prompts use agentPrompt instead.
        if (p.requireAgentStatus === "sendable" && p.text && (p.enter || p.interrupt))
          return { send: { accepted: false, handle: terminal.handle, bytesWritten: 0 } };
        if (p.interrupt) { this.interrupts++; terminal.remaining = 0; return { send: { accepted: true, handle: terminal.handle } }; }
        this.sends++;
        terminal.messages.push(this.message(`send-${this.sends}`, "user", z.string().parse(p.text)));
        terminal.remaining = 3; terminal.lastOutput++;
        if (this.dropSendReply) throw new BridgeError("orca_disconnected", "Fixture lost the send receipt.", true);
        return { send: { accepted: true, handle: terminal.handle, prompt: {
          requestId: options?.orchestrationRequestId ?? "missing-id", stages: ["input_accepted", "turn_started"],
          observation: "observed", provider: "codex",
        } } };
      }
      case "agentSession.history": {
        if (this.nativeWorking > 0 && --this.nativeWorking === 0) this.nativeItems.push({
          itemId: "native-answer", revision: 1, sequence: 2, observedAt: Date.now(),
          body: { kind: "message", role: "assistant", blocks: [{ type: "text", text: "Native fixture response" }] },
        });
        return { ok: true, page: { sessionId: "native-1", epoch: "e1", fence: 1,
          items: [...this.nativeItems, ...this.nativeApprovals], removedItemIds: [],
          hasOlder: false, hasNewer: false, working: this.nativeWorking > 0,
          window: { oldest: null, newest: null, nextCursor: { epoch: "e1", sequence: this.nativeItems.length } } } };
      }
      case "agentSession.send": this.sends++; this.nativeWorking = 3; return {
        ok: true, replayed: false, fence: 1, value: { clientMessageId: "native-message",
          submission: { dispatchState: "accepted" } } };
      case "agentSession.cancel": this.interrupts++; this.nativeWorking = 0; return {
        ok: true, replayed: false, fence: 1, value: { cancelled: true } };
      case "agentSession.respondToApproval":
      case "agentSession.respondToQuestion": this.nativeApprovals = []; return {
        ok: true, replayed: false, fence: 1, value: { itemId: p.itemId } };
      default: throw new BridgeError("method_not_supported", `Unknown fixture method ${method}`);
    }
  }
}

export interface Fixture { root: string; config: Config; fake: FakeOrca; configFile: string;
  close(): Promise<void> }

export async function fixture(options: { installedOrca?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orca-t3-fixture-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const fake = new FakeOrca(workspace);
  const config = configSchema.parse({ stateDir: join(root, "state"),
    polling: { activeMs: 250, idleMs: 1000 }, limits: { observationMs: 10_000 },
    orca: { userDataPath: join(root, "orca-profile"),
      ...(!options.installedOrca ? { appPath: join(root, "Orca.app") } : {}) },
  });
  await mkdir(config.orca.userDataPath!, { recursive: true });
  if (!options.installedOrca) {
    const moduleDir = join(config.orca.appPath, "Contents", "Resources", "app.asar.unpacked", "out", "cli", "runtime");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(moduleDir, "metadata.js"), `const fs=require('node:fs'),path=require('node:path');
exports.readMetadata=(dir)=>JSON.parse(fs.readFileSync(path.join(dir,'orca-runtime.json'),'utf8'));
exports.getPlatformUserDataPath=()=>{throw Error('Fixture must use an explicit profile')};\n`);
  }
  const token = "fixture-only-local-token";
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request: unknown = JSON.parse(buffer.slice(0, newline));
      buffer = "";
      const r = z.object({ id: z.string(), authToken: z.string(), method: z.string(), params: z.unknown().optional(),
        orchestrationRequestId: z.string().optional() }).parse(request);
      const presented = Buffer.from(r.authToken); const expected = Buffer.from(token);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { socket.destroy(); return; }
      void fake.call(r.method, r.params, r.orchestrationRequestId ? { orchestrationRequestId: r.orchestrationRequestId } : {})
        .then((result) => socket.end(JSON.stringify({ id: r.id, ok: true, result,
          _meta: { runtimeId: "fake-runtime" } }) + "\n"))
        .catch((error: unknown) => socket.end(JSON.stringify({ id: r.id, ok: false,
          error: { code: error instanceof BridgeError ? error.code : "fixture_error", message: "Fixture error" },
          _meta: { runtimeId: "fake-runtime" } }) + "\n"));
    });
  });
  const endpoint = join(root, "rpc.sock");
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  await writeFile(join(config.orca.userDataPath!, "orca-runtime.json"), JSON.stringify({
    runtimeId: "fake-runtime", authToken: token, pid: process.pid,
    transports: [{ kind: "unix", endpoint }],
  }), { mode: 0o600 });
  const configFile = join(root, "config.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return { root, config, configFile, fake, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}
