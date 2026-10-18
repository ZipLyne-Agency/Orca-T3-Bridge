import type { AgentContext } from "@agentclientprotocol/sdk";
import type { Config } from "../config.js";
import type { Catalog, OrcaSession } from "../orca/catalog.js";
import { readNative, TerminalReader, type Snapshot } from "../orca/readers.js";
import { BridgeError, publicError } from "../errors.js";
import { pause, destinationKey } from "../util.js";
import type { State } from "../state.js";
import { Projection } from "./projection.js";
import { Interactions } from "./interactions.js";

export class Observer {
  readonly controller = new AbortController();
  readonly projection: Projection;
  readonly interactions: Interactions;
  readonly activeProjection: Projection;
  snapshot: Snapshot | undefined;
  active = false;
  importingHistory = false;
  sequence = 0;
  failure: unknown;
  private readonly terminal: TerminalReader;
  private refreshing: Promise<Snapshot> | undefined;
  private job: Promise<void> | undefined;
  private readonly started = Date.now();

  constructor(readonly session: OrcaSession, private readonly catalog: Catalog,
    private readonly config: Config, client: AgentContext, state: State, t3Client: boolean) {
    this.projection = new Projection(session.id, (update) => client.notify("session/update", update));
    this.activeProjection = t3Client ? new Projection(session.id, (update) => client.notify("session/update", update),
      { state, key: destinationKey(session.id, config), labelUsers: true }) : this.projection;
    this.terminal = new TerminalReader(catalog.rpc, config);
    this.interactions = new Interactions(catalog.rpc, client, session, this.controller.signal,
      (error) => this.activeProjection.text(`${publicError(error)} Answer the pending request in Orca.\n`));
  }

  async refresh(replay = false): Promise<Snapshot> {
    if (this.refreshing) {
      const snapshot = await this.refreshing;
      if (replay) await this.projection.apply(snapshot, true);
      return snapshot;
    }
    this.refreshing = (async () => {
      const current = await this.catalog.get(this.session.id, this.session.cwd);
      const snapshot = current.ref.kind === "native" ?
        await readNative(this.catalog.rpc, current, this.config) : await this.terminal.read(current);
      await (this.active ? this.activeProjection : this.projection).apply(snapshot, replay,
        !this.active || this.importingHistory);
      this.snapshot = snapshot;
      this.sequence++;
      if (this.active) this.interactions.process(snapshot);
      return snapshot;
    })();
    try { return await this.refreshing; }
    finally { this.refreshing = undefined; }
  }

  start(): void {
    if (this.job) return;
    this.job = this.loop();
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      if (Date.now() - this.started >= this.config.limits.observationMs) {
        this.failure = new BridgeError("observation_expired", "This bridge observation reached its lifetime limit. Reopen the conversation to refresh it; Orca keeps running.");
        break;
      }
      await pause(this.active || this.snapshot?.working ? this.config.polling.activeMs :
        this.config.polling.idleMs, this.controller.signal);
      if (this.controller.signal.aborted) break;
      try { await this.refresh(); failures = 0; }
      catch (error) {
        if (++failures >= 3) { this.failure = error; break; }
        await pause(Math.min(5000, 500 * 2 ** failures), this.controller.signal);
      }
    }
    if (this.failure && !this.controller.signal.aborted)
      await this.projection.text(publicError(this.failure)).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.job;
    await this.refreshing?.catch(() => undefined);
  }
}
