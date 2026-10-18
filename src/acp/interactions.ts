import type { AgentContext, CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { Snapshot } from "../orca/readers.js";
import type { OrcaSession } from "../orca/catalog.js";
import type { OrcaRpc } from "../orca/runtime.js";
import { mutateNative } from "../orca/mutations.js";
import { BridgeError } from "../errors.js";

const optionSchema = z.object({ id: z.string(), label: z.string() });
const freeInput = z.object({ allowEmpty: z.boolean().optional() });
const questionSchema = z.object({ id: z.string(), question: z.string(), multiSelect: z.boolean(),
  options: z.array(optionSchema).max(128), freeTextQuestionId: z.string().optional(), freeTextInput: freeInput.optional() });
const promptSchema = z.object({ kind: z.enum(["approval", "question"]),
  title: z.string().optional(), question: z.string().optional(), detail: z.string().nullable().optional(),
  options: z.array(optionSchema).max(128), questions: z.array(questionSchema).max(32).optional(),
  freeTextQuestionId: z.string().optional(), freeTextInput: freeInput.optional(),
  subject: z.object({ kind: z.string() }).catchall(z.unknown()).optional(),
  resolution: z.object({ state: z.string() }) });

/** Native approval IDs stay opaque. A form requires a human choice even in T3's Auto mode. */
export class Interactions {
  handoff = false;
  private readonly handled = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly rpc: OrcaRpc, private readonly client: AgentContext,
    private readonly session: OrcaSession, private readonly signal: AbortSignal,
    private readonly report: (error: unknown) => Promise<void>) {}

  beginTurn(): void {
    this.handoff = false;
    if (this.pending.size === 0) this.handled.clear();
  }

  process(snapshot: Snapshot): void {
    if (this.session.ref.kind !== "native" || !snapshot.fence) return;
    for (const row of snapshot.prompts) {
      const key = `${row.itemId}:${row.revision}`;
      if (this.handled.has(key)) continue;
      const parsed = promptSchema.safeParse(row.body);
      if (!parsed.success || parsed.data.resolution.state !== "pending") continue;
      this.handled.add(key);
      const operation = this.respond(row.itemId, row.revision, snapshot.fence, parsed.data);
      this.pending.add(operation);
      void operation.catch((error: unknown) => {
        this.handoff = true;
        return this.signal.aborted ? undefined : this.report(error);
      })
        .catch(() => undefined).finally(() => this.pending.delete(operation));
    }
  }

  private async respond(itemId: string, revision: number, fence: number,
    prompt: z.infer<typeof promptSchema>): Promise<void> {
    if (this.session.ref.kind !== "native") return;
    if (prompt.subject && prompt.subject.kind !== "plan")
      throw new BridgeError("unsupported_approval", "This approval has a subject the bridge cannot display. Answer it in Orca.");
    const grouped = prompt.kind === "question" && prompt.questions?.length ? prompt.questions : undefined;
    const questions = grouped ?? [{ id: prompt.freeTextQuestionId ?? "q1", question: prompt.question ?? prompt.title ?? "Orca request",
      multiSelect: false, options: prompt.options, freeTextQuestionId: prompt.freeTextQuestionId,
      freeTextInput: prompt.freeTextInput }];
    type Properties = Extract<CreateElicitationRequest, { requestedSchema: unknown }>["requestedSchema"]["properties"];
    const properties: Properties = {};
    const required: string[] = [];
    for (const [index, question] of questions.entries()) {
      if (question.freeTextQuestionId) properties[`other${index}`] = {
        type: "string", title: `${question.question} (written answer)`, maxLength: 65536,
      };
      if (!question.options.length) {
        if (!question.freeTextQuestionId) throw new BridgeError("unsupported_question", "Answer this question in Orca; it exposes no choices or text input.");
        required.push(`other${index}`); continue;
      }
      // T3 currently renders enum and boolean fields; oneOf and array schemas
      // lose their choices. Keep human labels visible and map them back to IDs.
      if (question.multiSelect) {
        question.options.forEach((option, optionIndex) => {
          properties[`q${index}o${optionIndex}`] = { type: "boolean",
            title: `${question.question}: ${option.label}` };
        });
      } else {
        properties[`q${index}`] = { type: "string", title: question.question,
          enum: question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}`) };
        if (!question.freeTextQuestionId) required.push(`q${index}`);
      }
    }
    const response = await this.client.request("elicitation/create", {
      mode: "form", sessionId: this.session.id,
      message: [prompt.kind === "approval" ? `Orca approval: ${prompt.title ?? "Permission requested"}` : "Orca needs your answer",
        prompt.detail, prompt.subject?.kind === "plan" && typeof prompt.subject.text === "string" ? prompt.subject.text : ""].filter(Boolean).join("\n\n"),
      requestedSchema: { type: "object", properties, required },
    }, { cancellationSignal: this.signal });
    const accepted = z.object({ action: z.literal("accept"), content: z.record(z.string(), z.unknown()) }).safeParse(response);
    if (this.signal.aborted || !accepted.success) { this.handoff = true; return; }
    const answers = questions.map((question, index) => {
      const value = accepted.data.content[`q${index}`];
      let choices: string[] = [];
      if (question.multiSelect) {
        question.options.forEach((option, optionIndex) => {
          const selected = accepted.data.content[`q${index}o${optionIndex}`];
          if (selected === true || selected === "true") choices.push(option.id);
          else if (selected !== undefined && selected !== false && selected !== "false")
            throw new BridgeError("invalid_answer", "Choose true or false for each offered option.");
        });
      } else if (value !== undefined) {
        const selected = question.options.find((option, optionIndex) => value === `${optionIndex + 1}. ${option.label}`);
        if (!selected) throw new BridgeError("invalid_answer", "Choose an option offered by Orca.");
        choices = [selected.id];
      }
      const other = accepted.data.content[`other${index}`];
      const hasOther = typeof other === "string" && (other.trim().length > 0 || question.freeTextInput?.allowEmpty === true);
      const count = choices.length + (hasOther ? 1 : 0);
      if (!count || (!question.multiSelect && count !== 1) || new Set(choices).size !== choices.length ||
        choices.some((id) => !question.options.some((option) => option.id === id)) ||
        (hasOther && (!question.freeTextQuestionId || Buffer.byteLength(other) > 65536)))
        throw new BridgeError("invalid_answer", "The response did not name an option offered by Orca.");
      return { questionId: question.id, optionIds: choices, ...(hasOther ? { other } : {}) };
    });
    const fields = { itemId, expectedRevision: revision,
      ...(prompt.kind === "question" ? { answers } : { optionId: answers[0]?.optionIds[0] }) };
    await mutateNative(this.rpc, this.session.ref.session, fence,
      prompt.kind === "approval" ? "agentSession.respondToApproval" : "agentSession.respondToQuestion", fields);
  }
}
