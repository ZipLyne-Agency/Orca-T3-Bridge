import { z } from "zod";

const id = z.string().min(1).max(4096);
const timestamp = z.number().finite().nonnegative();
export const statusSchema = z.object({ runtimeId: id, appVersion: z.string().optional(),
  capabilities: z.array(z.string()).default([]), graphStatus: z.string() });
export const terminalSchema = z.object({
  handle: id, ptyId: z.string().nullable(), incarnationId: z.string().nullable().optional(),
  worktreeId: id, worktreePath: z.string().max(4096), executionHostId: z.string().optional(),
  title: z.string().nullable(), connected: z.boolean(), writable: z.boolean(),
  lastOutputAt: timestamp.nullable(), agentIdentity: z.string().optional(),
  agentWait: z.object({ source: z.string(), reason: z.string().optional() }).nullable().optional(),
});
export const terminalListSchema = z.object({ terminals: z.array(terminalSchema).max(4096),
  totalCount: z.number().int().nonnegative(), truncated: z.boolean() });
export const terminalReadSchema = z.object({ terminal: z.object({
  handle: id, status: z.enum(["running", "exited", "unknown"]), tail: z.array(z.string()).max(10000),
  truncated: z.boolean(), limited: z.boolean().optional(),
  oldestCursor: z.string().optional(), nextCursor: z.string().nullable(),
  latestCursor: z.string().optional(),
}) });
export const terminalWaitSchema = z.object({ wait: z.object({
  handle: id, satisfied: z.boolean(), status: z.enum(["running", "exited", "unknown"]),
  blockedReason: z.string().optional(), exitCode: z.number().nullable(),
}) });
export const terminalSendSchema = z.object({ send: z.object({
  accepted: z.boolean(), handle: id, refusedReason: z.string().optional(),
  prompt: z.object({ requestId: id, stages: z.array(z.string()), provider: z.string(),
    observation: z.string() }).optional(),
}) });
export const tabsSchema = z.object({ snapshots: z.array(z.object({
  worktree: id, publicationEpoch: z.string(),
  agentSessionsUnverifiable: z.boolean().optional(),
  tabs: z.array(z.object({ type: z.string(), id,
    title: z.string().optional(), sessionId: z.string().optional(), agent: z.string().optional(),
    ptyId: z.string().nullable().optional(), incarnationId: z.string().nullable().optional(),
    agentStatus: z.object({ state: z.string(), providerSession: z.object({
      key: z.string(), id: z.string(), transcriptPath: z.string().optional(),
    }).optional() }).nullable().optional(),
  })).max(4096),
})).max(4096) });
export const worktreeListSchema = z.object({ worktrees: z.array(z.object({
  id: z.string(), path: z.string(),
})).max(4096), truncated: z.boolean().optional() });

export const journalCursorSchema = z.object({ epoch: id, sequence: z.number().int().nonnegative() });
export const journalItemSchema = z.object({ itemId: id, revision: z.number().int().positive(),
  sequence: z.number().int().nonnegative(), observedAt: timestamp,
  body: z.object({ kind: z.string() }).catchall(z.unknown()),
});
export const historySchema = z.object({ ok: z.boolean(), page: z.object({
  sessionId: id, epoch: id, fence: z.number().int().positive().optional(),
  items: z.array(journalItemSchema).max(200),
  removedItemIds: z.array(z.string()).default([]),
  hasOlder: z.boolean(), hasNewer: z.boolean(),
  window: z.object({ oldest: journalCursorSchema.nullable(), newest: journalCursorSchema.nullable(),
    nextCursor: journalCursorSchema }),
}).catchall(z.unknown()) });
export type JournalItem = z.infer<typeof journalItemSchema>;
export const transcriptSchema = z.object({ messages: z.array(z.object({
  id, role: z.enum(["user", "assistant", "tool", "reasoning", "system"]),
  blocks: z.array(z.object({ type: z.string() }).catchall(z.unknown())).max(4096),
  state: z.string().optional(),
})).max(2000), hasMore: z.boolean().optional(), beforeOffset: z.number().optional(),
  error: z.string().optional(),
});
export const mutationSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), replayed: z.boolean(), fence: z.number().int().positive(),
    value: z.unknown() }),
  z.object({ ok: z.literal(false), refusal: z.object({ code: z.string() }).catchall(z.unknown()) }),
]);
