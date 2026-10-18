import type { DatabaseSync } from "node:sqlite";

/** New local metadata database only. No Orca or T3 database is opened here. */
export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
  const row = db.prepare("PRAGMA user_version").get();
  const version = Number(row?.user_version ?? 0);
  if (version > 3) throw new Error("Bridge database belongs to a newer bridge version.");
  if (version === 3) { db.exec("COMMIT"); return; }
  if (version === 1) {
    db.exec("ALTER TABLE imports ADD COLUMN revision TEXT NOT NULL DEFAULT '';");
  }
  if (version >= 1) {
    db.exec("CREATE TABLE projected (session TEXT NOT NULL, item TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(session,item)); PRAGMA user_version=3; COMMIT;");
    return;
  }
  db.exec(`
    CREATE TABLE receipts (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE leases (session TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);
    CREATE TABLE imports (session TEXT PRIMARY KEY, thread TEXT NOT NULL, project TEXT NOT NULL, revision TEXT NOT NULL DEFAULT '');
    CREATE TABLE projected (session TEXT NOT NULL, item TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(session,item));
    CREATE INDEX receipts_session ON receipts(session, state);
    PRAGMA user_version=3;
    COMMIT;`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
