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
