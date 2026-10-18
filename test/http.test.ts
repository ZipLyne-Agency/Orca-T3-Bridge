import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { httpJson } from "../src/t3/http.js";

test("large bounded T3 projections fit their own budget while both response caps remain enforced", async (t) => {
  let size = 5 * 1024 * 1024;
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => {
    let emitted = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) { controller.close(); return; }
        emitted = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "x".repeat(size) })));
      },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }));
  });
  const schema = z.object({ text: z.string() });
  const ordinary = new URL("http://localhost/api/projects");
  const bounded = new URL("http://localhost/api/orchestration/threads/test/bounded?compactTurnItems=true");
  await assert.rejects(httpJson(ordinary, schema), /exceeded the bridge limit/);
  assert.equal((await httpJson(bounded, schema)).text.length, size);
  size = 17 * 1024 * 1024;
  await assert.rejects(httpJson(bounded, schema), /exceeded the bridge limit/);
  assert.ok(cancelled >= 2, "oversized response bodies must be cancelled");
});
