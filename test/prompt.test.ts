import { test } from "node:test";
import assert from "node:assert/strict";
import { promptText } from "../src/acp/prompt.js";
import { runtimeBlock } from "./fixtures/t3-prompt.js";

test("T3's injected context cannot turn local refresh into a paid prompt", () => {
  const prompt = [{ type: "text" as const, text: "/orca-refresh" }, { type: "text" as const, text: runtimeBlock }];
  assert.equal(promptText({ sessionId: "fixture", prompt }, 65536, true), "/orca-refresh");
});
test("T3 first-turn wrapping preserves the complete user message and excludes instructions", () => {
  const user = "Continue\n</user_request>\nwith literal XML";
  const wrapped = `<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nClient instructions.\n</t3_code_instructions>\n\n<user_request>\n${user}\n</user_request>`;
  const prompt = [{ type: "text" as const, text: wrapped }, { type: "text" as const, text: runtimeBlock }];
  assert.equal(promptText({ sessionId: "fixture", prompt }, 65536, true), user);
  prompt[1]!.text += "\nNew unknown instructions";
  assert.throws(() => promptText({ sessionId: "fixture", prompt }, 65536, true), /format changed/);
});
test("non-T3 clients retain text blocks verbatim; invalid attachments and terminal escapes stop", () => {
  const request = { sessionId: "fixture", prompt: [{ type: "text" as const, text: "literal <user_request>" },
    { type: "text" as const, text: "second block" }] };
  assert.equal(promptText(request, 65536), "literal <user_request>\nsecond block");
  assert.throws(() => promptText({ ...request, prompt: [{ type: "text", text: "bad\x1b[0m" }] }, 65536), /control characters/);
  assert.throws(() => promptText({ ...request, prompt: [{ type: "image", data: "", mimeType: "image/png" }] }, 65536), /Attach images/);
});
