import { test } from "node:test";
import assert from "node:assert/strict";
import { client, type SessionNotification } from "@agentclientprotocol/sdk";
import { fixture } from "./fixtures/fake-orca.js";
import { Catalog } from "../src/orca/catalog.js";
import { installedOrcaRpc } from "../src/orca/runtime.js";
import { BridgeAgent } from "../src/acp/agent.js";
import { State } from "../src/state.js";
import { Mutations } from "../src/orca/mutations.js";
import { decodeSession } from "../src/orca/session-id.js";
import { runtimeBlock } from "./fixtures/t3-prompt.js";
import { pause } from "../src/util.js";

test("detached terminals with empty or relative workspace paths do not poison discovery or become reply targets", async () => {
  const f = await fixture();
  const call = f.fake.call.bind(f.fake);
  const catalog = new Catalog({ async call(method, params, options) {
    const result = await call(method, params, options);
    if (method !== "terminal.list") return result;
    const list = result as { terminals: Record<string, unknown>[]; totalCount: number };
    for (const path of ["", "relative-workspace"]) list.terminals.push({ ...list.terminals[0],
      handle: `detached-${list.terminals.length}`, ptyId: `detached-${list.terminals.length}`,
      worktreePath: path });
    list.totalCount = list.terminals.length;
    return list;
  } }, f.config);
  try {
    const sessions = await catalog.list();
    assert.equal(sessions.length, 1); assert.equal(sessions[0]?.cwd, f.fake.cwd);
  } finally { await f.close(); }
});

test("ACP discovery, history and replies use the same existing terminal through the Unix transport", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  const catalog = new Catalog(installedOrcaRpc(f.config), f.config);
  const bridge = new BridgeAgent(catalog, f.config, state);
  const updates: SessionNotification[] = [];
  const app = client().onNotification("session/update", ({ params }) => { updates.push(params); });
  try {
    await app.connectWith(bridge.app, async (ctx) => {
      const initialized = await ctx.request("initialize", { protocolVersion: 2, clientCapabilities: {} });
      assert.equal(initialized.protocolVersion, 1);
      await ctx.request("session/new", { cwd: f.fake.cwd, mcpServers: [] });
      assert.equal(f.fake.sends, 0); assert.equal(f.fake.starts, 0);
      const listed = await ctx.request("session/list", { cwd: f.fake.cwd });
      const id = listed.sessions[0]?.sessionId; assert.ok(id);
      await ctx.request("session/load", { sessionId: id, cwd: f.fake.cwd, mcpServers: [] });
      assert.ok(JSON.stringify(updates).includes("Existing Orca answer"));
      const result = await ctx.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "Continue fixture" }] });
      assert.equal(result.stopReason, "end_turn"); assert.equal(f.fake.sends, 1);
      assert.ok(JSON.stringify(updates).includes("Fake response 1"));
      assert.equal(f.fake.interrupts, 0); assert.equal(f.fake.starts, 0);
      const send = f.fake.calls.find((call) => call.method === "terminal.send");
      assert.ok(send?.options?.orchestrationRequestId);
    });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("a lost send acknowledgment persists uncertainty and is never resent on the next connection", async () => {
  const f = await fixture(); let state = new State(f.config.stateDir);
  const catalog = new Catalog(f.fake, f.config);
  try {
    const [session] = await catalog.list(); assert.ok(session);
    f.fake.dropSendReply = true;
    await assert.rejects(new Mutations(catalog, state).send(session, "One logical send"));
    assert.equal(f.fake.sends, 1); assert.equal(state.receipts()[0]?.state, "unknown");
    state.close(); state = new State(f.config.stateDir);
    await assert.rejects(new Mutations(catalog, state).send(session, "One logical send"), /uncertain delivery/);
    assert.equal(f.fake.sends, 1);
  } finally { state.close(); await f.close(); }
});

test("replacing a PTY incarnation invalidates an imported session before any text is written", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  const catalog = new Catalog(f.fake, f.config);
  try {
    const [session] = await catalog.list(); assert.ok(session);
    const old = decodeSession(session.id, f.config.sourceId); assert.equal(old.kind, "terminal");
    f.fake.terminals[0]!.incarnation = "replacement";
    await assert.rejects(new Mutations(catalog, state).send(session, "Must not reach replacement"), /replaced/);
    assert.equal(f.fake.sends, 0);
  } finally { state.close(); await f.close(); }
});

test("native sessions use Orca's fenced mutation and preserve provider process ownership", async () => {
  const f = await fixture(); f.fake.nativeEnabled = true;
  const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config);
  const bridge = new BridgeAgent(catalog, f.config, state); const updates: SessionNotification[] = [];
  try {
    await client().onNotification("session/update", ({ params }) => { updates.push(params); })
      .connectWith(bridge.app, async (ctx) => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const native = (await catalog.list()).find((session) => session.ref.kind === "native"); assert.ok(native);
        await ctx.request("session/load", { sessionId: native.id, cwd: native.cwd, mcpServers: [] });
        await ctx.request("session/prompt", { sessionId: native.id, prompt: [{ type: "text", text: "Native followup" }] });
        assert.ok(JSON.stringify(updates).includes("Native fixture response"));
        assert.equal(f.fake.starts, 0); assert.equal(f.fake.sends, 1);
        const mutation = f.fake.calls.find((call) => call.method === "agentSession.send"); assert.ok(mutation);
        assert.ok(JSON.stringify(mutation.params).includes('"expectedRuntimeFence":1'));
      });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("the sync refresh command hydrates history without forwarding a prompt or interrupting Orca", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  const catalog = new Catalog(f.fake, f.config); const bridge = new BridgeAgent(catalog, f.config, state);
  const updates: SessionNotification[] = [];
  try {
    await client().onNotification("session/update", ({ params }) => { updates.push(params); })
      .connectWith(bridge.app, async (ctx) => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const [session] = await catalog.list(); assert.ok(session);
        await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
        await ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "/orca-refresh" }] });
        assert.equal(f.fake.sends, 0); assert.equal(f.fake.interrupts, 0); assert.equal(f.fake.starts, 0);
        assert.ok(JSON.stringify(updates).includes("Existing Orca answer"));
      });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("T3 refresh deduplicates persisted history across bridge connections and reload replays ACP history", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir);
  const catalog = new Catalog(f.fake, f.config);
  try {
    for (const iteration of [0, 1]) {
      const bridge = new BridgeAgent(catalog, f.config, state); const updates: SessionNotification[] = [];
      try {
        await client().onNotification("session/update", ({ params }) => { updates.push(params); })
          .connectWith(bridge.app, async (ctx) => {
            await ctx.request("initialize", { protocolVersion: 1, clientInfo: { name: "t3-code", version: "fixture" }, clientCapabilities: {} });
            const [session] = await catalog.list(); assert.ok(session);
            for (const _ of [0, 1]) {
              updates.length = 0;
              await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
              assert.ok(JSON.stringify(updates).includes("Existing Orca answer"));
            }
            updates.length = 0;
            await ctx.request("session/prompt", { sessionId: session.id, prompt: [
              { type: "text", text: "/orca-refresh" }, { type: "text", text: runtimeBlock },
            ] });
            assert.equal(JSON.stringify(updates).includes("Existing Orca answer"), iteration === 0);
            assert.equal(f.fake.sends, 0); assert.equal(f.fake.starts, 0);
          });
      } finally { await bridge.close(); }
    }
  } finally { state.close(); await f.close(); }
});

test("disconnect after accepted delivery blocks an automatic resend while leaving Orca running", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config);
  const bridge = new BridgeAgent(catalog, f.config, state);
  try {
    await client().connectWith(bridge.app, async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const [session] = await catalog.list(); assert.ok(session);
      await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
      const pending = ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "Observe lost connection" }] });
      const deadline = Date.now() + 2000;
      while (f.fake.sends === 0 && Date.now() < deadline) await pause(5);
      assert.equal(f.fake.sends, 1);
      // Keep the fake turn running while closing only this bridge connection.
      f.fake.terminals[0]!.remaining = 100;
      await bridge.close(); await pending;
      assert.equal(f.fake.interrupts, 0);
      assert.equal(state.receipts()[0]?.state, "unknown");
      await assert.rejects(new Mutations(catalog, state).send(session, "Observe lost connection"), /uncertain delivery/);
      assert.equal(f.fake.sends, 1);
    });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("explicit cancellation reaches only the current Orca terminal and reports cancelled", async () => {
  const f = await fixture(); const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config);
  const bridge = new BridgeAgent(catalog, f.config, state);
  try {
    await client().connectWith(bridge.app, async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const [session] = await catalog.list(); assert.ok(session);
      await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
      const pending = ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "Cancellable fixture" }] });
      const deadline = Date.now() + 2000;
      while (f.fake.sends === 0 && Date.now() < deadline) await pause(5);
      f.fake.terminals[0]!.remaining = 100;
      await ctx.notify("session/cancel", { sessionId: session.id });
      const result = await pending;
      assert.equal(result.stopReason, "cancelled"); assert.equal(f.fake.interrupts, 1);
    });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("native approvals require an explicit human form choice with the original revision and fence", async () => {
  const f = await fixture(); f.fake.nativeEnabled = true;
  f.fake.nativeApprovals.push({ itemId: "approval-1", revision: 7, sequence: 1, observedAt: Date.now(),
    body: { kind: "approval", title: "Run fixture command", detail: "Fixture command details", options: [
      { id: "opaque-once", label: "Allow once" }, { id: "opaque-deny", label: "Deny" },
    ], resolution: { state: "pending" } } });
  const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config); const bridge = new BridgeAgent(catalog, f.config, state);
  let forms = 0;
  try {
    await client().onRequest("elicitation/create", ({ params }) => {
      forms++;
      assert.equal(f.fake.calls.filter((call) => call.method === "agentSession.respondToApproval").length, 0);
      assert.ok(JSON.stringify(params).includes("Fixture command details"));
      assert.ok(JSON.stringify(params).includes('"enum":["1. Allow once","2. Deny"]'));
      return { action: "accept", content: { q0: "1. Allow once" } };
    }).connectWith(bridge.app, async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = (await catalog.list()).find((session) => session.ref.kind === "native"); assert.ok(session);
      await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
      assert.equal(forms, 0);
      await ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "/orca-refresh" }] });
      assert.equal(forms, 1); assert.equal(f.fake.sends, 0);
      const response = f.fake.calls.find((call) => call.method === "agentSession.respondToApproval"); assert.ok(response);
      const fields = JSON.stringify(response.params);
      assert.ok(fields.includes('"expectedRuntimeFence":1')); assert.ok(fields.includes('"expectedRevision":7'));
      assert.ok(fields.includes('"optionId":"opaque-once"'));
    });
  } finally { await bridge.close(); state.close(); await f.close(); }
});
