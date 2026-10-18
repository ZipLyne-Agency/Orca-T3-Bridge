import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../src/init.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-init-"));
  const environment = { home: join(root, "home space"), applications: join(root, "Applications") };
  const app = join(environment.applications, "T3 Code.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>T3 Code</string></dict></plist>');
  await writeFile(join(app, "Contents", "MacOS", "T3 Code"), "");
  await writeFile(join(app, "Contents", "Resources", "app.asar"), "");
  await mkdir(join(environment.applications, "Orca.app"));
  const baseDir = join(environment.home, ".t3");
  await mkdir(join(baseDir, "userdata"), { recursive: true });
  await writeFile(join(baseDir, "userdata", "server-runtime.json"), JSON.stringify({ port: 4123, host: "0.0.0.0", token: "must-not-copy" }));
  return { root, environment, app, baseDir, configFile: join(environment.home, ".config", "bridge", "config.json") };
}

test("init discovers local apps and loopback port, writes private config and refuses overwrite", async () => {
  const f = await fixture();
  try {
    const config = await initialize(f.configFile, {}, f.environment);
    assert.equal(config.t3?.url, "http://127.0.0.1:4123/");
    assert.equal(config.t3?.executable, join(f.app, "Contents", "MacOS", "T3 Code"));
    assert.equal(config.stateDir, join(f.environment.home, ".local", "state", "orca-t3-bridge"));
    const contents = await readFile(f.configFile, "utf8");
    assert.ok(!contents.includes("must-not-copy"));
    assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
    await assert.rejects(initialize(f.configFile, {}, f.environment), /already exists/);
    assert.equal(await readFile(f.configFile, "utf8"), contents);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("init requires a choice for multiple apps and accepts explicit environment settings", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.environment.applications, "T3 Code Nightly.app"));
    await assert.rejects(initialize(f.configFile, {}, f.environment), /--t3-app/);
    const config = await initialize(f.configFile, { t3App: f.app, t3BaseDir: f.baseDir, t3Url: "http://localhost:5123/" }, f.environment);
    assert.equal(config.t3?.url, "http://localhost:5123/");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("init fails before writing when discovery or the supplied origin is invalid", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.baseDir, "userdata", "server-runtime.json"), '{"port":0}');
    await assert.rejects(initialize(f.configFile, {}, f.environment), /--t3-url/);
    await assert.rejects(initialize(f.configFile, { t3Url: "http://example.com/" }, f.environment));
    await assert.rejects(stat(f.configFile), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
