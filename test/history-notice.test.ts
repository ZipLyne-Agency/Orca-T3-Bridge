import { test } from "node:test";
import assert from "node:assert/strict";
import { client, type SessionNotification } from "@agentclientprotocol/sdk";
import { fixture } from "./fixtures/fake-orca.js";
import { runtimeBlock } from "./fixtures/t3-prompt.js";
import { Catalog } from "../src/orca/catalog.js";
import { State } from "../src/state.js";
import { BridgeAgent } from "../src/acp/agent.js";

test("limited history is disclosed once during import and never inserted into new replies", async () => {
  const f = await fixture();
  f.fake.terminals[0]!.messages.unshift(f.fake.message("old-large-row", "user",
    "old history ".repeat(100_000)));
  async function turn(text: string): Promise<SessionNotification[]> {
    const state = new State(f.config.stateDir);
    const catalog = new Catalog(f.fake, f.config);
    const bridge = new BridgeAgent(catalog, f.config, state);
    const updates: SessionNotification[] = [];
    try {
      await client().onNotification("session/update", ({ params }) => { updates.push(params); })
        .connectWith(bridge.app, async (ctx) => {
          await ctx.request("initialize", { protocolVersion: 1,
            clientInfo: { name: "t3-code", version: "fixture" }, clientCapabilities: {} });
          const [session] = await catalog.list(); assert.ok(session);
          await ctx.request("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
          updates.length = 0;
          await ctx.request("session/prompt", { sessionId: session.id,
            prompt: [{ type: "text", text }, { type: "text", text: runtimeBlock }] });
        });
      return updates;
    } finally { await bridge.close(); state.close(); }
  }
  const notices = (updates: SessionNotification[]) => updates.filter(({ update }) =>
    "messageId" in update && update.messageId === "history-window").length;
  try {
    const reply = await turn("Hi");
    assert.equal(notices(reply), 0, "a new reply must not begin with a history warning");
    assert.ok(JSON.stringify(reply).includes("Fake response 1"));
    assert.equal(notices(await turn("/orca-refresh")), 1, "initial history import discloses its window");
    assert.equal(notices(await turn("/orca-refresh")), 0, "reconnect must not repeat the import notice");
    const next = await turn("Hello again");
    assert.equal(notices(next), 0);
    assert.ok(JSON.stringify(next).includes("Fake response 2"));
    assert.equal(f.fake.sends, 2, "history refreshes must not send prompts");
  } finally { await f.close(); }
});
