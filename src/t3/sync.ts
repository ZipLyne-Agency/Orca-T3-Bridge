import { basename } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Catalog } from "../orca/catalog.js";
import type { State } from "../state.js";
import { BridgeError } from "../errors.js";
import { canonicalPath, digest, destinationKey, pause } from "../util.js";
import { T3Connection } from "./connection.js";
import { assertConfiguredProvider } from "./setup.js";
import { callOrca } from "../orca/runtime.js";
import { historySchema } from "../orca/schemas.js";

// Creating a project with scripts: [] requires settings:write in T3. Keep the
// empty scripts explicit so imports cannot inherit host automation scripts.
export const syncScopes = ["orchestration:read", "orchestration:operate", "providers:manage", "settings:write"];
const projectSchema = z.object({ id: z.string(), workspaceRoot: z.string() });
const projectSnapshotSchema = z.object({ projects: z.array(projectSchema).max(4096) });
const importedSchema = z.object({ threadId: z.string(), imported: z.boolean() });
const detailSchema = z.object({ projection: z.object({
  thread: z.object({ deletedAt: z.string().nullable(), providerInstanceId: z.string() }),
  runs: z.array(z.object({ status: z.string(), userMessageId: z.string() })),
}) });
export interface BridgeInstallation { configFile: string; entrypoint: string }

export async function syncOnce(catalog: Catalog, t3: T3Connection, state: State,
  config: Config, installation: BridgeInstallation): Promise<{ discovered: number; imported: number }> {
  await assertConfiguredProvider(t3, config, installation.configFile, installation.entrypoint);
  const sessions = await catalog.list(undefined, true);
  const projects = await t3.http("/api/projects", projectSnapshotSchema);
  const roots = new Map<string, z.infer<typeof projectSchema>>();
  for (const project of projects.projects) {
    const root = await canonicalPath(project.workspaceRoot).catch(() => null);
    if (root) roots.set(root, project);
  }
  let imported = 0;
  for (const session of sessions) {
    const cwd = await canonicalPath(session.cwd);
    let project = roots.get(cwd);
    if (!project) {
      const id = `orca-${digest({ source: config.sourceId, cwd }).slice(0, 32)}`;
      project = await t3.http("/api/projects/mutate", projectSchema, {
        method: "POST", body: JSON.stringify({ type: "project.create",
          commandId: `orca-project-${digest({ source: config.sourceId, cwd }).slice(0, 32)}`,
          projectId: id, title: `${basename(cwd)} (Orca)`, workspaceRoot: cwd,
          createWorkspaceRootIfMissing: false, scripts: [],
        }),
      });
      roots.set(cwd, project);
    }
    const result = await t3.rpc("server.importAcpRegistrySession", {
      instanceId: config.t3?.instanceId ?? "orca", projectId: project.id,
      sessionId: session.id, title: session.title,
      ...(session.updatedAt ? { updatedAt: new Date(session.updatedAt).toISOString() } : {}),
    }, importedSchema);
    const mapping = destinationKey(session.id, config);
    state.markImported(mapping, result.threadId, project.id);
    if (result.imported) imported++;
    let revision = `${session.updatedAt}`;
    if (session.ref.kind === "native") {
      const { page } = await callOrca(catalog.rpc, "agentSession.history", historySchema,
        { sessionId: session.ref.session, direction: "tail", limit: 1 });
      revision = digest({ epoch: page.epoch, cursor: page.window.nextCursor,
        items: page.items.map((item) => ({ id: item.itemId, revision: item.revision })), working: page.working });
    }
    if (result.imported || state.refreshRevision(mapping) !== revision) {
      const detail = await t3.http(`/api/orchestration/threads/${encodeURIComponent(result.threadId)}/bounded?compactTurnItems=true`, detailSchema);
      if (detail.projection.thread.providerInstanceId !== config.t3?.instanceId)
        throw new BridgeError("thread_provider_changed", "An imported thread now uses another provider. Refresh stopped before dispatch.");
      const key = digest({ session: session.id, thread: result.threadId, revision }).slice(0, 40);
      const messageId = `orca-refresh-${key}`;
      const prior = detail.projection.runs.find((run) => run.userMessageId === messageId);
      if (prior?.status === "completed") { state.markRefreshed(mapping, revision); continue; }
      if (prior && ["failed", "cancelled", "interrupted"].includes(prior.status))
        throw new BridgeError("refresh_failed", "A local history refresh failed in T3. Inspect that imported conversation and send /orca-refresh there to retry without forwarding a prompt to Orca.");
      const busy = detail.projection.runs.some((run) => ["preparing", "queued", "starting", "running", "waiting"].includes(run.status));
      if (!prior && !busy && detail.projection.thread.deletedAt === null) {
        await t3.rpc("orchestration.dispatchCommand", { type: "message.dispatch",
          commandId: messageId, messageId,
          threadId: result.threadId, text: "/orca-refresh", attachments: [],
          modelSelection: { instanceId: config.t3?.instanceId, model: "existing" },
          createdBy: "system", creationSource: "server", dispatchMode: { type: "start_immediately" },
        }, z.unknown());
      }
    }
  }
  return { discovered: sessions.length, imported };
}

export async function syncWatch(catalog: Catalog, state: State, config: Config,
  installation: BridgeInstallation, signal: AbortSignal,
  report: (result: { discovered: number; imported: number }) => void): Promise<void> {
  if (!config.t3) throw new BridgeError("t3_not_configured", "Set the T3 connection in the bridge configuration.");
  let t3: T3Connection | undefined;
  let failures = 0;
  try {
    while (!signal.aborted) {
      try {
        if (!t3 || t3.expiresAt - Date.now() < 60_000) {
          await t3?.close();
          t3 = await T3Connection.open(config.t3, syncScopes);
        }
        report(await syncOnce(catalog, t3, state, config, installation)); failures = 0;
      } catch (error) {
        await t3?.close(); t3 = undefined;
        if (++failures >= 3) throw error;
      }
      await pause(config.polling.syncMs * Math.max(1, 2 ** failures), signal);
    }
  } finally { await t3?.close(); }
}
