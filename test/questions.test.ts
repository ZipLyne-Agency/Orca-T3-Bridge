import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "@agentclientprotocol/sdk";
import { BridgeAgent } from "../src/acp/agent.js";
import { Catalog } from "../src/orca/catalog.js";
import { State } from "../src/state.js";
import { fixture } from "./fixtures/fake-orca.js";

test("native grouped questions preserve opaque choices and typed answers", async () => {
  const f = await fixture(); f.fake.nativeEnabled = true;
  f.fake.nativeApprovals.push({ itemId: "question-1", revision: 2, sequence: 1, observedAt: Date.now(),
    body: { kind: "question", question: "Choose details", options: [], questions: [
      { id: "features", question: "Which features?", multiSelect: true,
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "answer-id", question: "What name?", multiSelect: false,
        options: [], freeTextQuestionId: "answer-id" },
    ], resolution: { state: "pending" } } });
  const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config);
  const bridge = new BridgeAgent(catalog, f.config, state);
  try {
    await client().onRequest("elicitation/create", () => ({ action: "accept",
      content: { q0o0: true, q0o1: "true", other1: "A human's answer" } }))
      .connectWith(bridge.app, async (ctx) => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const session = (await catalog.list()).find((session) => session.ref.kind === "native"); assert.ok(session);
        await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
        await ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "/orca-refresh" }] });
        const call = f.fake.calls.find((call) => call.method === "agentSession.respondToQuestion"); assert.ok(call);
        assert.deepEqual((call.params as { answers: unknown }).answers, [
          { questionId: "features", optionIds: ["a", "b"] },
          { questionId: "answer-id", optionIds: [], other: "A human's answer" },
        ]);
        assert.equal(f.fake.sends, 0);
      });
  } finally { await bridge.close(); state.close(); await f.close(); }
});

test("an invalid approval answer stays pending in Orca and reports the handoff", async () => {
  const f = await fixture(); f.fake.nativeEnabled = true;
  f.fake.nativeApprovals.push({ itemId: "approval-1", revision: 2, sequence: 1, observedAt: Date.now(),
    body: { kind: "approval", title: "Fixture approval", options: [{ id: "offered", label: "Allow once" }], resolution: { state: "pending" } } });
  const state = new State(f.config.stateDir); const catalog = new Catalog(f.fake, f.config);
  const bridge = new BridgeAgent(catalog, f.config, state); const updates: unknown[] = [];
  try {
    await client().onRequest("elicitation/create", () => ({ action: "accept", content: { q0: "invented" } }))
      .onNotification("session/update", ({ params }) => { updates.push(params); })
      .connectWith(bridge.app, async (ctx) => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const session = (await catalog.list()).find((session) => session.ref.kind === "native"); assert.ok(session);
        await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
        await ctx.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "/orca-refresh" }] });
        assert.equal(f.fake.calls.filter((call) => call.method === "agentSession.respondToApproval").length, 0);
        assert.equal(f.fake.nativeApprovals.length, 1);
        assert.ok(JSON.stringify(updates).includes("pending request remains in Orca"));
        assert.equal(f.fake.sends, 0); assert.equal(f.fake.interrupts, 0);
      });
  } finally { await bridge.close(); state.close(); await f.close(); }
});
