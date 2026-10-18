import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";
import { migrate } from "./migrations.js";

export type ReceiptState = "sending" | "accepted" | "rejected" | "unknown";
export class State {
  private readonly db: DatabaseSync;
  readonly owner = randomUUID();
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "bridge.sqlite"));
    chmodSync(join(dir, "bridge.sqlite"), 0o600);
    this.db.exec("PRAGMA busy_timeout=5000");
    migrate(this.db);
    this.db.prepare("DELETE FROM receipts WHERE state IN ('accepted','rejected') AND updated<?").run(Date.now() - 7 * 86_400_000);
  }

  acquire(session: string): () => void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.db.prepare("SELECT owner, pid FROM leases WHERE session=?").get(session);
      if (lease) {
        let alive = true;
        try { process.kill(Number(lease.pid), 0); } catch (error) {
          alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
        if (alive) throw new BridgeError("session_busy", "Another bridge connection is sending to this session.");
        this.db.prepare("DELETE FROM leases WHERE session=?").run(session);
        this.db.prepare("UPDATE receipts SET state='unknown',updated=? WHERE session=? AND state='sending'").run(Date.now(), session);
      }
      const pending = this.db.prepare("SELECT id FROM receipts WHERE session=? AND state IN ('sending','unknown') LIMIT 1").get(session);
      if (pending) throw new BridgeError("delivery_unknown",
        "A previous prompt has uncertain delivery. Inspect Orca, then use receipts resolve with its operation ID; the bridge will not resend it.", true);
      this.db.prepare("INSERT INTO leases VALUES(?,?,?)").run(session, this.owner, process.pid);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return () => { this.db.prepare("DELETE FROM leases WHERE session=? AND owner=?").run(session, this.owner); };
  }

  begin(id: string, session: string, fingerprint: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const count = this.db.prepare("SELECT COUNT(*) AS total FROM receipts").get();
    if (Number(count?.total) >= 20_000) throw new BridgeError("receipt_limit",
      "The bridge receipt store reached its limit. Resolve uncertain receipts and retain or clear old completed receipts before continuing.");
    this.db.prepare("INSERT INTO receipts VALUES(?,?,?,'sending',?,?)").run(id, session, fingerprint, Date.now(), Date.now());
    this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finish(id: string, state: Exclude<ReceiptState, "sending">): void {
    this.db.prepare("UPDATE receipts SET state=?,updated=? WHERE id=?").run(state, Date.now(), id);
  }
  receipts(): Record<string, unknown>[] {
    return this.db.prepare("SELECT id,session,state,created,updated FROM receipts ORDER BY created DESC LIMIT 200").all();
  }
  resolve(id: string, state: "accepted" | "rejected"): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
    const row = this.db.prepare("SELECT r.session,l.pid FROM receipts r LEFT JOIN leases l ON r.session=l.session WHERE r.id=?").get(id);
    if (!row) throw new BridgeError("receipt_missing", "No such bridge receipt.");
    if (row.pid !== null) {
      let alive = true;
      try { process.kill(Number(row.pid), 0); } catch (error) {
        alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
      if (alive) throw new BridgeError("receipt_busy", "Stop the bridge connection holding this receipt before resolving it.");
      this.db.prepare("DELETE FROM leases WHERE session=?").run(String(row.session));
    }
    this.finish(id, state);
    this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  markImported(session: string, thread: string, project: string): void {
    this.db.prepare(`INSERT INTO imports(session,thread,project) VALUES(?,?,?) ON CONFLICT(session)
      DO UPDATE SET thread=excluded.thread,project=excluded.project,
      revision=CASE WHEN imports.thread=excluded.thread THEN imports.revision ELSE '' END`).run(session, thread, project);
  }
  refreshRevision(session: string): string {
    const row = this.db.prepare("SELECT revision FROM imports WHERE session=?").get(session);
    return typeof row?.revision === "string" ? row.revision : "";
  }
  markRefreshed(session: string, revision: string): void {
    this.db.prepare("UPDATE imports SET revision=? WHERE session=?").run(revision, session);
  }
  imported(session: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM imports WHERE session=?").get(session)); }
  projectedRevision(session: string, item: string): string | undefined {
    const row = this.db.prepare("SELECT revision FROM projected WHERE session=? AND item=?").get(session, item);
    return typeof row?.revision === "string" ? row.revision : undefined;
  }
  markProjected(session: string, item: string, revision: string): void {
    this.db.prepare("INSERT INTO projected VALUES(?,?,?) ON CONFLICT(session,item) DO UPDATE SET revision=excluded.revision").run(session, item, revision);
  }
  pruneProjected(session: string, retained: Set<string>): void {
    const rows = this.db.prepare("SELECT item FROM projected WHERE session=?").all(session);
    for (const row of rows) if (!retained.has(String(row.item)))
      this.db.prepare("DELETE FROM projected WHERE session=? AND item=?").run(session, String(row.item));
  }
  close(): void {
    this.db.prepare("UPDATE receipts SET state='unknown',updated=? WHERE state='sending' AND session IN (SELECT session FROM leases WHERE owner=?)").run(Date.now(), this.owner);
    this.db.prepare("DELETE FROM leases WHERE owner=?").run(this.owner);
    this.db.close();
  }
}
