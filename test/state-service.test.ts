import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { State } from "../src/state.js";
import { launchAgent, service } from "../src/service.js";
import { fixture } from "./fixtures/fake-orca.js";
import { configSchema } from "../src/config.js";

test("two bridge connections share leases and uncertain-delivery admission", async () => {
  const f = await fixture(); const first = new State(f.config.stateDir); const second = new State(f.config.stateDir);
  try {
    const release = first.acquire("session");
    first.begin("operation", "session", "fingerprint");
    assert.throws(() => second.acquire("session"), /Another bridge connection/);
    assert.throws(() => second.resolve("operation", "accepted"), /Stop the bridge connection/);
    first.finish("operation", "unknown"); release();
    assert.throws(() => second.acquire("session"), /uncertain delivery/);
    second.resolve("operation", "accepted");
    second.acquire("session")();
  } finally { first.close(); second.close(); await f.close(); }
});

test("an abandoned send can be resolved after its exact owner process exits", async () => {
  const f = await fixture();
  try {
    const source = `import {State} from ${JSON.stringify(new URL("../src/state.js", import.meta.url).href)};
      const s = new State(${JSON.stringify(f.config.stateDir)}); s.acquire('abandoned');
      s.begin('crashed-operation','abandoned','fingerprint'); process.exit(0);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0);
    const state = new State(f.config.stateDir);
    try {
      assert.throws(() => state.acquire("abandoned"), /uncertain delivery/);
      state.resolve("crashed-operation", "accepted");
      state.acquire("abandoned")();
    } finally { state.close(); }
  } finally { await f.close(); }
});

test("launch-agent generation preserves literal paths and does not install or enable anything", async () => {
  const f = await fixture();
  try {
    const config = configSchema.parse({ ...f.config, t3: { url: "http://localhost:3773/", baseDir: join(f.root, "t3"),
      executable: "/bin/false", instanceId: "fixture" } });
    const configFile = join(f.root, "config <&>.json");
    const entrypoint = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const rendered = launchAgent(config, configFile, entrypoint, process.execPath, f.root);
    const output = join(f.root, "prepared.plist");
    await service("render", config, configFile, entrypoint, output);
    const data = await readFile(output, "utf8");
    assert.equal(data, rendered.contents);
    assert.ok(data.includes("config &lt;&amp;&gt;.json"));
    assert.ok(!data.includes("KeepAlive"));
    assert.ok(!data.includes("enable"));
    const check = spawnSync("/usr/bin/plutil", ["-lint", output], { encoding: "utf8", timeout: 5000 });
    assert.equal(check.status, 0);
    await assert.rejects(readFile(rendered.path), /ENOENT/);
    await assert.rejects(service("render", config, configFile, entrypoint, output), /EEXIST/);
    // Offline receipt inspection must work even when the Orca installation is absent.
    await writeFile(f.configFile, JSON.stringify({ ...f.config, orca: { appPath: "/not-installed/Orca.app" } }));
    const receipts = spawnSync(process.execPath, [entrypoint, "receipts", "list", "--config", f.configFile], { encoding: "utf8", timeout: 5000 });
    assert.equal(receipts.status, 0); assert.deepEqual(JSON.parse(receipts.stdout), []);
  } finally { await f.close(); }
});
