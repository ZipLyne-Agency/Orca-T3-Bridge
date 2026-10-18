import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/fake-orca.js";
import { Catalog } from "../src/orca/catalog.js";
import { TerminalReader } from "../src/orca/readers.js";
import { BridgeError } from "../src/errors.js";

test("idle-condition timeouts preserve history and progress, but transport timeouts propagate", async () => {
  const f = await fixture();
  try {
    const [session] = await new Catalog(f.fake, f.config).list();
    assert.ok(session);
    f.fake.terminals[0]!.remaining = 2;
    const reader = new TerminalReader(f.fake, f.config);
    const busy = await reader.read(session);
    assert.equal(busy.working, true);
    assert.ok(busy.items.length > 0);
    assert.equal((await reader.read(session)).working, false);
    const disconnected = new TerminalReader({ async call() {
      throw new BridgeError("orca_timeout", "Transport deadline expired");
    } }, f.config);
    await assert.rejects(disconnected.read(session), /Transport deadline expired/);
    assert.equal(f.fake.sends, 0);
  } finally { await f.close(); }
});
