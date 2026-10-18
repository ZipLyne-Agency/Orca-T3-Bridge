import { agent, PROTOCOL_VERSION, RequestError, type AgentContext, type AgentApp,
  type SessionConfigOption, type PromptRequest, type PromptResponse } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Catalog } from "../orca/catalog.js";
import type { State } from "../state.js";
import { Mutations } from "../orca/mutations.js";
import { BridgeError, publicError } from "../errors.js";
import { canonicalPath, pause } from "../util.js";
import { Observer } from "./observer.js";
import { promptText } from "./prompt.js";

export const modelOptions: SessionConfigOption[] = [{ id: "model", name: "Model", category: "model",
  type: "select", currentValue: "existing", options: [{ value: "existing", name: "Use Orca's current model" }] }];

export class BridgeAgent {
  readonly app: AgentApp;
  private readonly observers = new Map<string, Observer>();
  private readonly controls = new Map<string, string>();
  private readonly prompting = new Set<string>();
  private readonly historyPrompts = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly jobs = new Set<Promise<PromptResponse>>();
  private readonly mutations: Mutations;
  private closed = false;
  private t3Client = false;

  constructor(private readonly catalog: Catalog, private readonly config: Config, private readonly state: State) {
    this.mutations = new Mutations(catalog, state);
    this.app = agent({ name: "orca-t3-bridge" })
      .onRequest("initialize", ({ params }) => { this.t3Client = params.clientInfo?.name === "t3-code"; return { protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: "orca-t3-bridge", version: "0.1.0", title: "Orca" }, authMethods: [] }; })
      .onRequest("authenticate", () => ({}))
      .onRequest("session/new", async ({ params }) => {
        // T3 probes a provider by opening a session. This creates no Orca agent or paid work.
        const cwd = await canonicalPath(params.cwd);
        if (this.controls.size >= 32) throw RequestError.invalidParams(undefined, "Too many bridge discovery sessions.");
        const sessionId = `orca-discovery-${randomUUID()}`;
        this.controls.set(sessionId, cwd);
        return { sessionId, configOptions: modelOptions };
      })
      .onRequest("session/list", async ({ params }) => {
        const sessions = await this.catalog.list(params.cwd ?? undefined);
        const offset = params.cursor ? Number(params.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw RequestError.invalidParams();
        const page = sessions.slice(offset, offset + 100);
        return { sessions: page.map((session) => ({ sessionId: session.id, cwd: session.cwd,
          title: session.title, updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null })),
          ...(offset + page.length < sessions.length ? { nextCursor: `${offset + page.length}` } : {}) };
      })
      .onRequest("session/load", async ({ params, client }) => {
        await this.load(params.sessionId, params.cwd, client);
        return { configOptions: modelOptions };
      })
      .onRequest("session/resume", async ({ params, client }) => {
        await this.load(params.sessionId, params.cwd, client);
        return { sessionId: params.sessionId, configOptions: modelOptions };
      })
      .onRequest("session/set_config_option", ({ params }) => {
        if (params.configId !== "model" || params.value !== "existing") throw RequestError.invalidParams(undefined,
          "Choose the model and permission mode in Orca for this existing session.");
        return { configOptions: modelOptions };
      })
      .onRequest("session/prompt", async ({ params, client, signal }) => {
        const job = this.prompt(params, client, signal);
        this.jobs.add(job);
        try { return await job; }
        catch (error) { throw RequestError.internalError({ code: error instanceof BridgeError ? error.code : "bridge_failure" }, publicError(error)); }
        finally { this.jobs.delete(job); }
      })
      .onNotification("session/cancel", async ({ params }) => {
        const observer = this.observers.get(params.sessionId);
        if (observer && this.prompting.has(params.sessionId)) {
          if (!this.historyPrompts.has(params.sessionId)) await this.mutations.cancel(observer.session, observer.snapshot?.fence);
          this.cancelled.add(params.sessionId);
          await observer.refresh();
        }
      });
  }

  private async load(id: string, cwd: string, client: AgentContext, replay = true): Promise<Observer> {
    if (this.closed) throw new BridgeError("bridge_closed", "The bridge connection is closed.");
    const prior = this.observers.get(id);
    if (prior && ((!prior.failure && !prior.expired) || replay && this.prompting.has(id))) {
      if (replay) await prior.refresh(true);
      return prior;
    }
    if (prior) { await prior.close(); this.observers.delete(id); }
    if (this.observers.size >= this.config.limits.attachedPerProcess)
      throw new BridgeError("observation_limit", "This bridge connection reached its observation limit.");
    const session = await this.catalog.get(id, cwd);
    const observer = new Observer(session, this.catalog, this.config, client, this.state, this.t3Client);
    if (replay) await observer.refresh(true);
    this.observers.set(id, observer);
    observer.start();
    return observer;
  }

  private async prompt(params: PromptRequest, client: AgentContext, signal: AbortSignal): Promise<PromptResponse> {
    const text = promptText(params, this.config.limits.promptBytes, this.t3Client);
    const discovery = this.controls.get(params.sessionId);
    if (discovery) {
      const sessions = await this.catalog.list(discovery, true);
      const message = sessions.length ? `Orca has ${sessions.length} existing session(s) for this workspace. Run the bridge sync command to import them, then open the imported conversation.\n` :
        "No Orca agent session is running for this workspace. Start one in Orca, then run bridge sync.\n";
      await client.notify("session/update", { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } } });
      return { stopReason: "end_turn" };
    }
    let observer = this.observers.get(params.sessionId);
    if (!observer) throw new BridgeError("session_not_loaded", "Load this imported Orca session before sending a reply.");
    if (this.prompting.has(params.sessionId)) throw new BridgeError("session_busy", "A reply is already being observed for this session.");
    this.prompting.add(params.sessionId);
    this.cancelled.delete(params.sessionId);
    const refreshOnly = text.trim() === "/orca-refresh";
    if (refreshOnly) this.historyPrompts.add(params.sessionId);
    let operationId: string | undefined;
    let settled = false;
    try {
      // Renew before any send. Never replay a prompt when an observer expires.
      if (observer.expired || observer.failure instanceof BridgeError && observer.failure.code === "observation_expired")
        observer = await this.load(params.sessionId, observer.session.cwd, client, false);
      if (observer.failure) throw observer.failure;
      if (signal.aborted || this.closed || this.cancelled.has(params.sessionId)) return { stopReason: "cancelled" };
      observer.importingHistory = refreshOnly;
      observer.active = true;
      observer.interactions.beginTurn();
      const observationSignal = AbortSignal.any([signal, observer.controller.signal]);
      const before = await observer.refresh();
      if (refreshOnly && !before.waiting) { settled = true; return { stopReason: "end_turn" }; }
      if (!refreshOnly) observer.activeProjection.suppressUser(text);
      const receipt = refreshOnly ? { operationId: "local-refresh", startObserved: true } :
        await this.mutations.send(observer.session, text, before.fence);
      if (!refreshOnly) operationId = receipt.operationId;
      const startedAt = Date.now();
      let started = receipt.startObserved;
      while (!observationSignal.aborted && !this.closed) {
        if (this.cancelled.has(params.sessionId)) { settled = true; return { stopReason: "cancelled" }; }
        const current = await observer.refresh();
        started ||= Boolean(current.working);
        if (current.waiting && observer.session.ref.kind === "terminal") {
          settled = true;
          await observer.projection.text("Orca is waiting for input. Send your answer as the next message, or answer in Orca.\n");
          return { stopReason: "end_turn" };
        }
        if (current.waiting && observer.interactions.handoff) {
          settled = true;
          await observer.activeProjection.text("The pending request remains in Orca. Answer it there, or send /orca-refresh to open it again.\n");
          return { stopReason: "end_turn" };
        }
        if (refreshOnly && !current.waiting) { settled = true; return { stopReason: "end_turn" }; }
        if (current.exited || (started && current.working === false && !current.waiting)) {
          settled = true; return { stopReason: "end_turn" };
        }
        if (observer.failure) throw observer.failure;
        if (!started && Date.now() - startedAt > 15_000) {
          await observer.projection.text(`Orca accepted input but has not confirmed a turn start. Check the original session before sending again. Receipt: ${receipt.operationId}\n`);
          return { stopReason: "end_turn" };
        }
        if (Date.now() - startedAt >= this.config.limits.observationMs)
          throw new BridgeError("observation_expired", "The observation deadline was reached. Orca keeps running; no prompt was retried.");
        await pause(this.config.polling.activeMs, observationSignal);
      }
      return { stopReason: "cancelled" };
    } finally {
      // A T3 retry after a disconnected observation must not dispatch another paid turn.
      if (operationId && !settled) this.state.finish(operationId, "unknown");
      observer.active = false; observer.importingHistory = false;
      this.prompting.delete(params.sessionId); this.cancelled.delete(params.sessionId);
      this.historyPrompts.delete(params.sessionId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const observer of this.observers.values()) observer.controller.abort();
    await Promise.allSettled(this.jobs);
    await Promise.all([...this.observers.values()].map((observer) => observer.close()));
    this.observers.clear();
    this.controls.clear();
  }
}
