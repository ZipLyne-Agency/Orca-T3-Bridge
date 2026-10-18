import { createHash } from "node:crypto";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { BridgeError } from "../errors.js";

// Verified against T3 5a4e99805337. Unknown runtime templates stop before delivery.
const linkingHash = "24d3bba14c84a8e0feeae3d4e3dc4e7513171a084854d2e1c7ce5cc232b28306";
function isRuntime(text: string): boolean {
  const match = /^<runtime_info>In case you're asked: you are running in T3 Code through the [^\r\n<>]+ harness[^\r\n<>]*<\/runtime_info>\n\n([\s\S]+)$/.exec(text);
  return Boolean(match && createHash("sha256").update(match[1]!).digest("hex") === linkingHash);
}
function changed(): never {
  throw new BridgeError("t3_prompt_contract_changed", "T3's prompt format changed. No text was sent to Orca; update the bridge compatibility adapter.");
}

export function promptText(params: PromptRequest, limit: number, t3 = false): string {
  let blocks = params.prompt;
  if (t3) {
    // Current T3 always appends its own runtime block after the user message.
    // Never pass that context into an existing Orca agent's conversation.
    const last = blocks.at(-1);
    if (!last || last.type !== "text" || !isRuntime(last.text)) changed();
    blocks = blocks.slice(0, -1);
  }
  const parts: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      let text = block.text;
      if (t3 && index === 0 && text.startsWith("<t3_code_instructions>")) {
        const wrapped = /^<t3_code_instructions>\n## T3 Code interaction mode: (?:Default|Plan)\n[\s\S]*?\n<\/t3_code_instructions>\n\n<user_request>\n([\s\S]*)\n<\/user_request>$/.exec(text);
        if (!wrapped) changed();
        text = wrapped[1]!;
      }
      parts.push(text);
    } else if (block.type === "resource_link") parts.push(`${block.name}: ${block.uri}`);
    else throw new BridgeError("unsupported_attachment", "This Orca bridge accepts text and resource links. Attach images or files in Orca.");
  }
  const text = parts.join("\n");
  if (!text.trim()) throw new BridgeError("empty_prompt", "Enter a reply before sending.");
  if (Buffer.byteLength(text) > limit) throw new BridgeError("prompt_too_large", "The reply exceeds the bridge prompt limit.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new BridgeError("control_characters", "The reply contains terminal control characters.");
  return text;
}
