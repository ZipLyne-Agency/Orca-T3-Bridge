#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { defaultConfigPath, initialize } from "./init.js";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { loadConfig } from "./config.js";
import { BridgeError, publicError } from "./errors.js";
import { Catalog } from "./orca/catalog.js";
import { installedOrcaRpc } from "./orca/runtime.js";
import { State } from "./state.js";
import { BridgeAgent } from "./acp/agent.js";
import { T3Connection } from "./t3/connection.js";
import { syncOnce, syncWatch, syncScopes } from "./t3/sync.js";
import { configureProvider, providerInstance } from "./t3/setup.js";
import { service } from "./service.js";

const help = `Orca sessions in the standard T3 Code apps

  orca-t3-bridge init [--t3-app "/Applications/T3 Code.app"] [--t3-url http://127.0.0.1:PORT/]
  orca-t3-bridge provider --config /absolute/path/config.json
  orca-t3-bridge doctor [--config ...] [--offline]
  orca-t3-bridge acp --config ...
  orca-t3-bridge enable --config ...
  orca-t3-bridge disable --config ...
  orca-t3-bridge sync --config ... [--watch]
  orca-t3-bridge service render --config ... [--output /absolute/path/agent.plist]
  orca-t3-bridge service install|start|uninstall|status --config ...
  orca-t3-bridge receipts list --config ...
  orca-t3-bridge receipts resolve --config ... --operation ID --outcome accepted|rejected

Configuration defaults to ~/.config/orca-t3-bridge/config.json. Override with --config.
init also accepts --t3-base-dir and --orca-app. Use --version to print the version.

init and provider prepare local files/output. enable changes only the named T3 provider.
sync imports existing sessions. It never starts an Orca agent. disable keeps thread history.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, help: { type: "boolean", short: "h" },
    offline: { type: "boolean" }, watch: { type: "boolean" },
    operation: { type: "string" }, outcome: { type: "string" },
    output: { type: "string" }, version: { type: "boolean" },
    "t3-url": { type: "string" }, "t3-base-dir": { type: "string" },
    "t3-app": { type: "string" }, "orca-app": { type: "string" },
  } });
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`); return;
  }
  const command = positionals[0];
  if (!command || values.help) { process.stdout.write(help); return; }
  const configFile = values.config ? resolve(values.config) : defaultConfigPath();
  const entrypoint = fileURLToPath(import.meta.url);
  if (command === "init") {
    await initialize(configFile, { t3Url: values["t3-url"], t3BaseDir: values["t3-base-dir"],
      t3App: values["t3-app"], orcaApp: values["orca-app"] });
    process.stdout.write(`Configuration created at ${configFile}. Run doctor, then enable and sync.\n`); return;
  }
  const config = await loadConfig(command === "doctor" && values.offline && !values.config ? undefined : configFile);
  if (command === "provider") {
    process.stdout.write(`${JSON.stringify(providerInstance(configFile, entrypoint), null, 2)}\n`); return;
  }
  if (command === "service") {
    process.stdout.write(await service(positionals[1] ?? "status", config, configFile, entrypoint,
      values.output ? resolve(values.output) : undefined));
    return;
  }
  if (command === "doctor" && values.offline) {
    process.stdout.write(JSON.stringify({ ok: true, node: process.versions.node,
      protocol: "ACP v1", t3Protocol: 2, activation: "not checked; offline" }) + "\n"); return;
  }
  if (command === "doctor") {
    const catalog = new Catalog(installedOrcaRpc(config), config);
    const status = await catalog.status();
    const sessions = await catalog.list(undefined, true);
    process.stdout.write(JSON.stringify({ ok: true, orcaVersion: status.appVersion ?? "unknown",
      sessions: sessions.length, durableDelivery: status.capabilities.includes("terminal.prompt-delivery.v1") }) + "\n"); return;
  }
  const state = new State(config.stateDir);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    if (command === "receipts") {
      if (positionals[1] === "list") process.stdout.write(JSON.stringify(state.receipts(), null, 2) + "\n");
      else if (positionals[1] === "resolve" && values.operation &&
        (values.outcome === "accepted" || values.outcome === "rejected")) {
        state.resolve(values.operation, values.outcome);
        process.stdout.write("Receipt resolved from your inspection. No prompt was sent.\n");
      } else throw new BridgeError("arguments", "Use receipts list or receipts resolve --operation ID --outcome accepted|rejected.");
      return;
    }
    const catalog = new Catalog(installedOrcaRpc(config), config);
    if (command === "acp") {
      const bridge = new BridgeAgent(catalog, config, state);
      // Node 22's web-stream declarations predate the DOM iterator result types in TS 7.
      const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(Writable.toWeb(process.stdout), input,
        { maxMessageBytes: Math.max(config.limits.promptBytes, config.limits.historyBytes) + 65_536 });
      const connection = bridge.app.connect(stream);
      const close = () => connection.close();
      shutdown.signal.addEventListener("abort", close, { once: true });
      try { await connection.closed; }
      finally {
        shutdown.signal.removeEventListener("abort", close);
        await bridge.close();
      }
      return;
    }
    if (!config.t3) throw new BridgeError("t3_not_configured", "Supply --config with the T3 environment connection.");
    if (command === "sync" && values.watch) {
      await syncWatch(catalog, state, config, { configFile, entrypoint }, shutdown.signal,
        (result) => process.stdout.write(JSON.stringify(result) + "\n")); return;
    }
    if (["enable", "disable", "sync"].includes(command)) {
      const scopes = command === "sync" ? syncScopes : [...syncScopes, "settings:write"];
      const t3 = await T3Connection.open(config.t3, scopes);
      try {
        if (command === "sync") process.stdout.write(JSON.stringify(await syncOnce(catalog, t3, state, config, { configFile, entrypoint })) + "\n");
        else {
          await configureProvider(t3, config, configFile, entrypoint, command === "enable");
          process.stdout.write(command === "enable" ? "Orca provider enabled. Run sync to import sessions.\n" : "Orca provider disabled. Existing history was kept.\n");
        }
      } finally { await t3.close(); }
      return;
    }
    throw new BridgeError("arguments", "Unknown bridge command. Use --help.");
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    state.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${publicError(error)}\n`);
  process.exitCode = 1;
});
