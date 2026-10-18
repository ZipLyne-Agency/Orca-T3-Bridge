import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixtures/fake-orca.js";
import { configSchema } from "../src/config.js";
import { State } from "../src/state.js";
import { BridgeError } from "../src/errors.js";
import { desktopFailure, discoverT3Origin, syncLease } from "../src/desktop.js";
import { configureProvider, isPriorBridge, providerInstance } from "../src/t3/setup.js";
import type { T3Connection } from "../src/t3/connection.js";

const t3 = { url: "http://127.0.0.1:3773/", baseDir: "/example/t3", executable: "/example/t3-cli", instanceId: "orca" };

test("desktop follows a changed local port only for automatically discovered environments", async () => {
  const f = await fixture();
  try {
    const baseDir = join(f.root, "t3"); await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(join(baseDir, "userdata/server-runtime.json"), JSON.stringify({ port: 8123, host: "0.0.0.0" }));
    const config = configSchema.parse({ ...f.config, t3: { ...t3, baseDir, autoDetectUrl: true } });
    assert.equal((await discoverT3Origin(config)).t3?.url, "http://127.0.0.1:8123/");
    const manual = configSchema.parse({ ...config, t3: { ...config.t3, autoDetectUrl: false } });
    assert.equal((await discoverT3Origin(manual)).t3?.url, t3.url);
    await writeFile(join(baseDir, "userdata/server-runtime.json"), '{"port":65536}');
    await assert.rejects(discoverT3Origin(config), (error: unknown) => error instanceof BridgeError && error.code === "t3_unavailable");
  } finally { await f.close(); }
});

test("desktop and CLI share one sync lease without touching prompt receipts", async () => {
  const f = await fixture(); const one = new State(f.config.stateDir); const two = new State(f.config.stateDir);
  try {
    const config = configSchema.parse({ ...f.config, t3 });
    const release = syncLease(one, config);
    assert.throws(() => syncLease(two, config), /Another sync worker/);
    release(); syncLease(two, config)();
    assert.deepEqual(one.receipts(), []);
  } finally { one.close(); two.close(); await f.close(); }
});

test("desktop retries availability failures and stops for contract, delivery and configuration failures", () => {
  for (const code of ["orca_unavailable", "t3_transport_failed", "t3_disconnected", "ENOENT"])
    assert.equal(desktopFailure(new BridgeError(code, "test")).retry, true);
  for (const code of ["delivery_unknown", "provider_collision", "orca_contract_changed", "refresh_failed", "sync_busy"])
    assert.equal(desktopFailure(new BridgeError(code, "test")).retry, false);
});

test("relocation requires explicit opt-in, the same config and an identifiable bridge package", async () => {
  const f = await fixture();
  try {
    const oldRoot = join(f.root, "old-install"); const oldEntry = join(oldRoot, "dist/src/cli.js");
    await mkdir(join(oldRoot, "dist/src"), { recursive: true });
    await writeFile(join(oldRoot, "package.json"), '{"name":"orca-t3-bridge"}');
    const prior = providerInstance(f.configFile, oldEntry, "/old/node");
    assert.equal(await isPriorBridge(prior, f.configFile), true);
    assert.equal(await isPriorBridge(prior, f.configFile + "-different"), false);
    const updates: unknown[] = [];
    const connection = { rpc: async (tag: string, payload: unknown) => {
      if (tag === "server.getSettings") return { providerInstances: { orca: prior, unrelated: { enabled: true } } };
      updates.push(payload); return { providerInstances: {} };
    } } as unknown as T3Connection;
    const config = configSchema.parse({ ...f.config, t3 });
    await assert.rejects(configureProvider(connection, config, f.configFile, "/new/dist/src/cli.js", true), /another configuration/);
    assert.equal(updates.length, 0);
    await configureProvider(connection, config, f.configFile, "/new/dist/src/cli.js", true, true);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "orca",
      instance: providerInstance(f.configFile, "/new/dist/src/cli.js") } });
    await writeFile(join(oldRoot, "package.json"), '{"name":"another-provider"}');
    assert.equal(await isPriorBridge(prior, f.configFile), false);
    assert.ok((await readFile(f.configFile, "utf8")).length > 0);
  } finally { await f.close(); }
});

test("relocation recognizes a moved Mac bundle only when both runtime paths match", async () => {
  const old = "/missing/Orca T3 Bridge.app";
  const prior = providerInstance("/same/config.json", `${old}/Contents/Resources/bridge/dist/src/cli.js`, `${old}/Contents/MacOS/node-arm64`);
  assert.equal(await isPriorBridge(prior, "/same/config.json"), true);
  assert.equal(await isPriorBridge(prior, "/other/config.json"), false);
  prior.config.commandPath = "/different.app/Contents/MacOS/node-arm64";
  assert.equal(await isPriorBridge(prior, "/same/config.json"), false);
});
