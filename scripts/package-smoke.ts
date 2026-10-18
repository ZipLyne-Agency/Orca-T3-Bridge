import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../src/process.js";

const root = await mkdtemp(join(tmpdir(), "bridge-package-"));
try {
  const output = await runProcess("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root]);
  const packages = JSON.parse(output) as { filename: string; files: { path: string }[] }[];
  const pkg = packages[0]; assert.ok(pkg);
  assert.ok(pkg.files.some((file) => file.path === "dist/src/cli.js"));
  assert.ok(!pkg.files.some((file) => /^(test|scripts|node_modules|\.github)\//.test(file.path)));
  await runProcess("npm", ["install", "--prefix", join(root, "install"), "--ignore-scripts", "--omit=dev",
    "--no-audit", "--no-fund", join(root, pkg.filename)], { timeoutMs: 60_000 });
  const cli = resolve(root, "install", "node_modules", "orca-t3-bridge", "dist", "src", "cli.js");
  assert.match(await runProcess(process.execPath, [cli, "--help"]), /Orca sessions/);
  assert.match(await runProcess(process.execPath, [cli, "--version"]), /^\d+\.\d+\.\d+/);
  const doctor = JSON.parse(await runProcess(process.execPath, [cli, "doctor", "--offline"])) as { ok: boolean };
  assert.equal(doctor.ok, true);
  process.stdout.write("Package smoke passed: fresh installation, help, version and offline doctor.\n");
} finally { await rm(root, { recursive: true, force: true }); }
