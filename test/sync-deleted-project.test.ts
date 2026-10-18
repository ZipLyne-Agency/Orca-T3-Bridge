import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures/fake-orca.js";
import { configSchema } from "../src/config.js";
import { State } from "../src/state.js";
import type { Catalog } from "../src/orca/catalog.js";
import type { T3Connection } from "../src/t3/connection.js";
import { providerInstance } from "../src/t3/setup.js";
import { syncOnce } from "../src/t3/sync.js";
import { matchesLegacyLaunchAgent } from "../src/service.js";
import { destinationKey, digest } from "../src/util.js";

test("sync respects thread removal and stops failed refreshes even after the source revision changes", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  try {
    const config = configSchema.parse({ ...f.config, t3: { url: "http://127.0.0.1:3773", baseDir: f.root, executable: "/fake/t3", instanceId: "orca" } });
    const session = { id: "fixture-session", cwd: f.fake.cwd, title: "Fixture", updatedAt: 2, ref: { kind: "terminal" } };
    const catalog = { list: async () => [session] } as unknown as Catalog;
    const thread = { deletedAt: null as string | null, archivedAt: null as string | null, providerInstanceId: "orca" };
    let runs = [{ ordinal: 1, status: "failed", userMessageId: "orca-refresh-old-revision" }];
    let dispatches = 0;
    const connection = {
      rpc: async (tag: string) => {
        if (tag === "server.getSettings") return { providerInstances: { orca: providerInstance(f.configFile, "/test/dist/src/cli.js") } };
        if (tag === "server.importAcpRegistrySession") return { threadId: "fixture-thread", imported: false };
        assert.equal(tag, "orchestration.dispatchCommand"); dispatches++; return {};
      },
      http: async (path: string) => {
        if (path === "/api/projects") return { projects: [{ id: "project", workspaceRoot: f.fake.cwd, deletedAt: null }] };
        assert.ok(path.startsWith("/api/orchestration/threads/"));
        return { projection: { thread, runs } };
      },
    } as unknown as T3Connection;
    const sync = () => syncOnce(catalog, connection, state, config, { configFile: f.configFile, entrypoint: "/test/dist/src/cli.js" });
    for (const status of ["failed", "cancelled", "interrupted"]) {
      runs[0]!.status = status;
      for (const revision of [2, 3]) {
        session.updatedAt = revision;
        await assert.rejects(sync(), /local history refresh failed/);
      }
    }
    assert.equal(dispatches, 0);
    for (const field of ["deletedAt", "archivedAt"] as const) {
      thread[field] = "2026-10-18T00:00:00Z";
      assert.deepEqual(await sync(), { discovered: 1, imported: 0, skipped: 1 });
      thread[field] = null;
    }
    assert.equal(dispatches, 0, "Removed threads must be skipped before inspecting old failed runs");
    // A successful explicit recovery permits subsequent automatic updates.
    const failedKey = digest({ session: session.id, thread: "fixture-thread", revision: `${session.updatedAt}` }).slice(0, 40);
    runs[0]!.userMessageId = `orca-refresh-${failedKey}`;
    runs.unshift({ ordinal: 2, status: "completed", userMessageId: "manual-recovery" });
    await sync(); assert.equal(dispatches, 0, "Manual recovery also covers the unchanged failed revision");
    assert.equal(state.refreshRevision(destinationKey(session.id, config)), `${session.updatedAt}`);
    session.updatedAt++;
    await sync(); assert.equal(dispatches, 1);
    const key = digest({ session: session.id, thread: "fixture-thread", revision: `${session.updatedAt}` }).slice(0, 40);
    runs.unshift({ ordinal: 3, status: "completed", userMessageId: `orca-refresh-${key}` });
    await sync(); assert.equal(dispatches, 1);
    assert.equal(state.refreshRevision(destinationKey(session.id, config)), `${session.updatedAt}`);
  } finally { state.close(); await f.close(); }
});

test("a replayed creation receipt for a deleted project does not stop sync or restore it", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  try {
    const config = configSchema.parse({ ...f.config, t3: { url: "http://127.0.0.1:3773", baseDir: f.root, executable: "/fake/t3", instanceId: "orca" } });
    let creates = 0;
    const catalog = { list: async () => [{ cwd: f.fake.cwd }, { cwd: f.fake.cwd }] } as unknown as Catalog;
    const connection = {
      rpc: async (tag: string) => {
        assert.equal(tag, "server.getSettings", "Deleted project must never reach session import or dispatch");
        return { providerInstances: { orca: providerInstance(f.configFile, "/test/dist/src/cli.js") } };
      },
      http: async (path: string) => {
        if (path === "/api/projects") return { projects: [] };
        assert.equal(path, "/api/projects/mutate"); creates++;
        return { id: "deleted", workspaceRoot: f.fake.cwd, deletedAt: "2026-10-18T00:00:00Z" };
      },
    } as unknown as T3Connection;
    assert.deepEqual(await syncOnce(catalog, connection, state, config, { configFile: f.configFile, entrypoint: "/test/dist/src/cli.js" }),
      { discovered: 2, imported: 0, skipped: 2 });
    assert.equal(creates, 1);
  } finally { state.close(); await f.close(); }
});

test("legacy migration recognizes only the exact watcher arguments and label", () => {
  const agent = { Label: "bridge", ProgramArguments: ["/new/node", "/old/cli.js", "sync", "--watch", "--config", "/config"] };
  assert.equal(matchesLegacyLaunchAgent(agent, "bridge", "/old/cli.js", "/config"), true);
  assert.equal(matchesLegacyLaunchAgent(agent, "other", "/old/cli.js", "/config"), false);
  assert.equal(matchesLegacyLaunchAgent(agent, "bridge", "/old/cli.js", "/other"), false);
  agent.ProgramArguments[2] = "acp";
  assert.equal(matchesLegacyLaunchAgent(agent, "bridge", "/old/cli.js", "/config"), false);
});
