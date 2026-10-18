import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { t3Application } from "../src/init.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixture } from "../test/fixtures/fake-orca.js";
import { configSchema } from "../src/config.js";
import { State } from "../src/state.js";
import { Catalog } from "../src/orca/catalog.js";
import { installedOrcaRpc } from "../src/orca/runtime.js";
import { T3Connection } from "../src/t3/connection.js";
import { configureProvider } from "../src/t3/setup.js";
import { syncOnce, syncScopes } from "../src/t3/sync.js";
import { pause, withTimeout } from "../src/util.js";
import { publicError } from "../src/errors.js";
import { connectDesktop, runDesktop } from "../src/desktop.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  try { await withTimeout(exited, 8000); }
  catch { child.kill("SIGKILL"); await withTimeout(exited, 3000); }
}

async function waitReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Isolated T3 exited during startup");
    try {
      const response = await fetch(new URL("/api/auth/session", url), {
        signal: AbortSignal.timeout(1000), redirect: "error",
      });
      await response.body?.cancel();
      if ([200, 401].includes(response.status)) return;
    } catch { /* Readiness only; never retry a mutation. */ }
    await pause(250);
  }
  throw new Error("Isolated T3 readiness deadline exceeded");
}

const projectionSchema = z.object({ snapshotSequence: z.number(), projection: z.object({
  thread: z.object({ id: z.string() }).catchall(z.unknown()),
  messages: z.array(z.unknown()),
}).catchall(z.unknown()) });

async function run(): Promise<void> {
  const application = await t3Application(process.env.T3_APP_PATH ?? "/Applications/T3 Code Nightly.app");
  const f = await fixture({ installedOrca: true });
  f.fake.terminals[0]!.messages.unshift(f.fake.message("old-large-row", "user", "old history ".repeat(100_000)));
  const baseDir = join(f.root, "t3");
  const port = await freePort();
  const config = configSchema.parse({ ...f.config, t3: {
    url: `http://127.0.0.1:${port}/`, baseDir,
    ...application,
    instanceId: "orca-fixture",
  } });
  assert.ok(config.t3);
  await writeFile(f.configFile, JSON.stringify(config), { mode: 0o600 });
  await mkdir(join(baseDir, "userdata"), { recursive: true });
  const settings = { providerInstances: Object.fromEntries([
    "codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi", "muse",
  ].map((driver) => [driver, { driver, enabled: false, config: { enabled: false } }])),
    automaticGitFetchInterval: 0,
  };
  await writeFile(join(baseDir, "userdata", "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  const state = new State(config.stateDir);
  const catalog = new Catalog(installedOrcaRpc(config), config);
  let child: ChildProcess | undefined;
  let t3: T3Connection | undefined;
  let output = "";
  let phase = "startup";
  let lastProjection: z.infer<typeof projectionSchema> | undefined;
  try {
    child = spawn(config.t3.executable, [...config.t3.executableArgs, "--mode", "desktop",
      "--base-dir", baseDir, "--host", "127.0.0.1", "--port", `${port}`, "--no-browser"], {
      cwd: f.fake.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, USER: process.env.USER,
        TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", ELECTRON_RUN_AS_NODE: "1",
        DO_NOT_TRACK: "1", CI: "1" },
    });
    child.on("error", () => undefined);
    const collect = (chunk: Buffer) => { if (output.length < 2_097_152) output += chunk.toString(); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    process.stdout.write(JSON.stringify({ phase, pid: child.pid, cwd: f.fake.cwd, baseDir }) + "\n");
    await waitReady(config.t3.url, child);
    phase = "authenticate";
    t3 = await T3Connection.open(config.t3, [...syncScopes, "settings:write"]);
    phase = "configure";
    const entrypoint = resolve(fileURLToPath(new URL("../src/cli.js", import.meta.url)));
    await configureProvider(t3, config, f.configFile, entrypoint, true);
    phase = "provider-probe";
    const providerStatus = z.object({ providers: z.array(z.object({ instanceId: z.string(),
      nativeSessions: z.object({ canList: z.boolean(), canLoad: z.boolean() }).optional(),
      status: z.string(), message: z.string().optional(),
    })) }).passthrough();
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const status = await t3.rpc("server.refreshProviders", { instanceId: config.t3.instanceId,
        cwd: f.fake.cwd }, providerStatus);
      const provider = status.providers.find((provider) => provider.instanceId === config.t3?.instanceId);
      if (provider?.nativeSessions?.canList && provider.nativeSessions.canLoad) { ready = true; break; }
      await pause(500);
    }
    assert.ok(ready, "T3 must negotiate native session discovery through the unmodified ACP driver");
    assert.equal(f.fake.starts, 0); assert.equal(f.fake.sends, 0);
    phase = "sync";
    await t3.close();
    t3 = await T3Connection.open(config.t3, syncScopes);
    const first = await syncOnce(catalog, t3, state, config, { configFile: f.configFile, entrypoint });
    assert.equal(first.discovered, 1); assert.equal(first.imported, 1);
    const again = await syncOnce(catalog, t3, state, config, { configFile: f.configFile, entrypoint });
    assert.equal(again.imported, 0);
    phase = "desktop lifecycle";
    await connectDesktop(f.configFile, entrypoint);
    const desktopStop = new AbortController();
    let desktopConnected = false;
    await withTimeout(runDesktop(f.configFile, entrypoint, state, desktopStop.signal, event => {
      assert.equal(event.phase, "connected", event.message);
      assert.equal(event.imported, 0, "Desktop reconnect preserves existing imports");
      desktopConnected = true;
      desktopStop.abort();
    }, async () => { throw new Error("The desktop worker should stop before sleeping"); }), 15_000);
    assert.ok(desktopConnected);
    assert.equal(f.fake.sends, 0, "Desktop connect and automatic sync never send prompts");
    const projects = await t3.http("/api/projects", z.object({ projects: z.array(z.object({ id: z.string() })) }));
    const projectId = projects.projects[0]?.id; assert.ok(projectId);
    const listed = await t3.rpc("server.listAcpRegistrySessions", { instanceId: config.t3.instanceId,
      projectId }, z.object({ sessions: z.array(z.object({ importedThreadId: z.string().nullable() })) }));
    const threadId = listed.sessions[0]?.importedThreadId; assert.ok(threadId);
    phase = "projection";
    let projection: z.infer<typeof projectionSchema> | undefined;
    const waitUntil = Date.now() + 30_000;
    while (Date.now() < waitUntil) {
      projection = await t3.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, projectionSchema);
      lastProjection = projection;
      if (JSON.stringify(projection).includes("Existing Orca answer")) break;
      await pause(250);
    }
    assert.ok(JSON.stringify(projection).includes("Existing Orca answer"), "T3 must persist the imported Orca transcript");
    assert.equal(f.fake.sends, 0, "History refresh must never forward an agent prompt");
    phase = "external-update";
    f.fake.terminals[0]!.messages.push(f.fake.message("external-update", "assistant", "Work completed directly in Orca"));
    f.fake.terminals[0]!.lastOutput++;
    await t3.close();
    t3 = await T3Connection.open(config.t3, syncScopes);
    await syncOnce(catalog, t3, state, config, { configFile: f.configFile, entrypoint });
    const externalUntil = Date.now() + 15_000;
    while (Date.now() < externalUntil) {
      projection = await t3.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, projectionSchema);
      lastProjection = projection;
      if (JSON.stringify(projection).includes("Work completed directly in Orca")) break;
      await pause(250);
    }
    assert.ok(JSON.stringify(projection).includes("Work completed directly in Orca"));
    assert.equal(projection!.projection.messages.filter((message) => typeof message === "object" && message !== null &&
      "text" in message && typeof message.text === "string" && message.text.includes("Existing Orca answer")).length, 1);
    assert.equal(f.fake.sends, 0);
    phase = "send";
    await t3.rpc("orchestration.dispatchCommand", { type: "message.dispatch", commandId: "fixture-send-1",
      threadId, messageId: "fixture-message-1", text: "Reply through the real T3 server",
      attachments: [], createdBy: "user", creationSource: "mobile", dispatchMode: { type: "start_immediately" },
    }, z.unknown());
    const replyUntil = Date.now() + 30_000;
    while (Date.now() < replyUntil) {
      projection = await t3.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, projectionSchema);
      lastProjection = projection;
      if (JSON.stringify(projection).includes("Fake response 1")) break;
      await pause(250);
    }
    assert.equal(f.fake.sends, 1);
    const forwarded = f.fake.calls.find((call) => call.method === "terminal.send");
    assert.equal(z.object({ text: z.string() }).parse(forwarded?.params).text, "Reply through the real T3 server");
    assert.ok(JSON.stringify(projection).includes("Fake response 1"), "T3 must persist the response to a forwarded reply");
    const visibleMessages = z.array(z.object({ role: z.string(), text: z.string() }))
      .parse(projection!.projection.messages);
    assert.equal(visibleMessages.filter((message) => message.role === "assistant" &&
      message.text.includes("Showing recent Orca history.")).length, 1,
    "T3 must persist the history notice once across refresh, reconnect and a new reply");
    phase = "native-approval";
    f.fake.nativeEnabled = true;
    f.fake.nativeApprovals.push({ itemId: "native-approval", revision: 7, sequence: 1, observedAt: Date.now(),
      body: { kind: "approval", title: "Approve fake command", detail: "A fake command with no live side effects", options: [
        { id: "native-allow", label: "Allow once" }, { id: "native-deny", label: "Deny" },
      ], resolution: { state: "pending" } } });
    await syncOnce(catalog, t3, state, config, { configFile: f.configFile, entrypoint });
    const native = (await catalog.list(undefined, true)).find((session) => session.ref.kind === "native"); assert.ok(native);
    const nativeThread = await t3.rpc("server.importAcpRegistrySession", {
      instanceId: config.t3.instanceId, projectId, sessionId: native.id,
    }, z.object({ threadId: z.string() }));
    let requestId: string | undefined;
    const approvalUntil = Date.now() + 15_000;
    while (Date.now() < approvalUntil) {
      const detail = await t3.http(`/api/orchestration/threads/${encodeURIComponent(nativeThread.threadId)}`, projectionSchema);
      lastProjection = detail;
      const requests = z.array(z.object({ id: z.string(), kind: z.string(), status: z.string() }))
        .parse(detail.projection.runtimeRequests ?? []);
      requestId = requests.find((request) => request.kind === "user_input" && request.status === "pending")?.id;
      if (requestId) {
        assert.ok(JSON.stringify(detail.projection.turnItems).includes('"label":"1. Allow once"'), "T3 must display human-readable choices");
        break;
      }
      await pause(250);
    }
    assert.ok(requestId, "T3 must show the pending native approval as a human input request");
    assert.equal(f.fake.calls.filter((call) => call.method === "agentSession.respondToApproval").length, 0);
    await t3.rpc("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: "fixture-approve-1",
      threadId: nativeThread.threadId, requestId, answers: { q0: "1. Allow once" },
    }, z.unknown());
    const acceptedUntil = Date.now() + 10_000;
    while (f.fake.nativeApprovals.length && Date.now() < acceptedUntil) await pause(100);
    assert.equal(f.fake.nativeApprovals.length, 0);
    const approval = f.fake.calls.find((call) => call.method === "agentSession.respondToApproval");
    assert.equal(z.object({ optionId: z.string(), expectedRevision: z.number() }).parse(approval?.params).optionId, "native-allow");
    assert.equal(f.fake.sends, 1, "Answering an approval must not create a second agent prompt");
    phase = "disable";
    await configureProvider(t3, config, f.configFile, entrypoint, false);
    const retained = await t3.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, projectionSchema);
    assert.ok(JSON.stringify(retained).includes("Fake response 1"));
    assert.equal(f.fake.interrupts, 0, "Disabling or detaching the bridge must not stop Orca's agent");
    assert.equal(f.fake.starts, 0);
    process.stdout.write(JSON.stringify({ ok: true, phases: ["native discovery", "idempotent import", "desktop lifecycle", "transcript", "external update", "reconnect", "reply", "native approval", "disable keeps history"],
      realT3: true, realOrcaProfileReader: true, fakeAgentSends: f.fake.sends, providerStarts: f.fake.starts }) + "\n");
  } catch (error) {
    // The isolated log contains only fixtures, but may still hold T3 bootstrap credentials.
    const sanitized = output.replace(/(?:t3_[A-Za-z0-9_-]+|Bearer\s+\S+|token[=":\s]+[A-Za-z0-9._-]{12,})/gi, "[REDACTED]");
    const diagnostics = process.env.BRIDGE_DIAGNOSTICS_DIR ?? join(homedir(), "Assets", "orca-t3-bridge", "files");
    const logPath = join(diagnostics, "t3-smoke-diagnostics.log");
    await mkdir(diagnostics, { recursive: true });
    await writeFile(logPath, sanitized, { mode: 0o600 });
    const methods = Object.fromEntries([...new Set(f.fake.calls.map((call) => call.method))]
      .map((method) => [method, f.fake.calls.filter((call) => call.method === method).length]));
    // The fake projection contains no user content or provider credentials.
    await writeFile(join(diagnostics, "t3-smoke-projection.json"),
      JSON.stringify({ methods, projection: lastProjection }, null, 2), { mode: 0o600 });
    process.stderr.write(JSON.stringify({ phase, error: publicError(error), diagnostics: logPath }) + "\n");
    throw error;
  } finally {
    await t3?.close();
    if (child) await stop(child);
    state.close(); await f.close();
  }
}

run().catch((error: unknown) => { process.stderr.write(publicError(error) + "\n"); process.exitCode = 1; });
