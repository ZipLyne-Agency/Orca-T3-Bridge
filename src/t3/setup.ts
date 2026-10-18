import { z } from "zod";
import type { Config } from "../config.js";
import { BridgeError } from "../errors.js";
import { T3Connection } from "./connection.js";

const settingsSchema = z.object({ providerInstances: z.record(z.string(), z.unknown()).default({}) });
const instanceSchema = z.object({ driver: z.literal("acpRegistry"), enabled: z.boolean().optional(),
  displayName: z.string().optional(), config: z.object({ source: z.literal("local"),
    commandPath: z.string(), commandArgs: z.array(z.string()) }).catchall(z.unknown()),
}).catchall(z.unknown());

export function providerInstance(configFile: string, entrypoint: string, executable = process.execPath) {
  return { driver: "acpRegistry", displayName: "Orca", enabled: true, config: {
    source: "local", commandPath: executable, commandArgs: [entrypoint, "acp", "--config", configFile],
    customModels: ["existing"],
  } };
}

export async function assertConfiguredProvider(connection: T3Connection, config: Config,
  configFile: string, entrypoint: string): Promise<void> {
  if (!config.t3) throw new BridgeError("t3_not_configured", "No T3 connection is configured.");
  const expected = providerInstance(configFile, entrypoint);
  const settings = await connection.rpc("server.getSettings", {}, settingsSchema);
  const instance = instanceSchema.safeParse(settings.providerInstances[config.t3.instanceId]);
  if (!instance.success || instance.data.enabled === false ||
    instance.data.config.commandPath !== expected.config.commandPath ||
    JSON.stringify(instance.data.config.commandArgs) !== JSON.stringify(expected.config.commandArgs)) {
    throw new BridgeError("provider_collision", "Sync requires the exact enabled Orca bridge provider. No refresh commands were dispatched.");
  }
}

/** An atomic single-instance mutation preserves every other provider and setting. */
export async function configureProvider(connection: T3Connection, config: Config,
  configFile: string, entrypoint: string, enabled: boolean): Promise<void> {
  if (!config.t3) throw new BridgeError("t3_not_configured", "Configure the T3 environment before enabling the bridge.");
  const desired = providerInstance(configFile, entrypoint);
  const settings = await connection.rpc("server.getSettings", {}, settingsSchema);
  const existing = settings.providerInstances[config.t3.instanceId];
  if (existing !== undefined) {
    const parsed = instanceSchema.safeParse(existing);
    if (!parsed.success || parsed.data.config.commandPath !== desired.config.commandPath ||
      JSON.stringify(parsed.data.config.commandArgs) !== JSON.stringify(desired.config.commandArgs)) {
      throw new BridgeError("provider_collision", "That T3 provider ID belongs to another configuration. Choose a different instanceId.");
    }
    if (parsed.data.enabled === enabled) return;
  } else if (!enabled) return;
  await connection.rpc("server.updateSettings", {
    patch: {}, providerInstanceMutation: { operation: existing === undefined ? "create" : "upsert",
      instanceId: config.t3.instanceId, instance: { ...desired, enabled } },
  }, settingsSchema);
}
