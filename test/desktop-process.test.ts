import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixtures/fake-orca.js";
import { configSchema } from "../src/config.js";
import { withTimeout } from "../src/util.js";

// A closed loopback port exercises availability without starting a real model or T3 profile.
test("desktop worker exits on owner stdin EOF while waiting for apps", async () => {
  const f = await fixture();
  const config = configSchema.parse({ ...f.config, t3: { url: "http://127.0.0.1:1/", baseDir: f.root,
    executable: process.execPath, instanceId: "orca-test" } });
  await writeFile(f.configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "desktop", "run", "--config", f.configFile], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.stderr.resume();
  try {
    const waiting = new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.includes('"phase":"waiting"')) resolve();
        if (output.length > 8192) reject(new Error("Unexpected output"));
      });
      child.once("error", reject);
    });
    await withTimeout(waiting, 8000);
    child.stdin.end();
    assert.equal(await withTimeout(closed, 5000), 0);
    assert.equal(f.fake.sends, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await f.close();
  }
});
