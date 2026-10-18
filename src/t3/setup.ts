import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { BridgeError } from "../errors.js";
import { T3Connection } from "./connection.js";

export const settingsSchema = z.object({ providerInstances: z.record(z.string(), z.unknown()).default({}) });
export const instanceSchema = z.object({ driver: z.literal("acpRegistry"), enabled: z.boolean().optional(),
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
  configFile: string, entrypoint: string, enabled: boolean, allowRelocation = false): Promise<void> {
  if (!config.t3) throw new BridgeError("t3_not_configured", "Configure the T3 environment before enabling the bridge.");
  const desired = providerInstance(configFile, entrypoint);
  const settings = await connection.rpc("server.getSettings", {}, settingsSchema);
  const existing = settings.providerInstances[config.t3.instanceId];
  if (existing !== undefined) {
    const parsed = instanceSchema.safeParse(existing);
    const same = parsed.success && parsed.data.config.commandPath === desired.config.commandPath &&
      JSON.stringify(parsed.data.config.commandArgs) === JSON.stringify(desired.config.commandArgs);
    if (!same && (!allowRelocation || !await isPriorBridge(existing, configFile))) {
      throw new BridgeError("provider_collision", "That T3 provider ID belongs to another configuration. Choose a different instanceId.");
    }
    if (same && parsed.data.enabled === enabled) return;
  } else if (!enabled) return;
  await connection.rpc("server.updateSettings", {
    patch: {}, providerInstanceMutation: { operation: existing === undefined ? "create" : "upsert",
      instanceId: config.t3.instanceId, instance: { ...desired, enabled } },
  }, settingsSchema);
}

/** Explicit desktop migration only: the same config and an identifiable bridge package. */
export async function isPriorBridge(value: unknown, configFile: string): Promise<boolean> {
  const parsed = instanceSchema.safeParse(value);
  if (!parsed.success) return false;
  const args = parsed.data.config.commandArgs;
  if (args.length !== 4 || args[1] !== "acp" || args[2] !== "--config" ||
    args[3] !== configFile || !args[0]?.endsWith("/dist/src/cli.js")) return false;
  const bundle = args[0].match(/^(.*\.app)\/Contents\/Resources\/bridge\/dist\/src\/cli\.js$/)?.[1];
  if (bundle && ["arm64", "x64"].some(arch => parsed.data.config.commandPath === `${bundle}/Contents/MacOS/node-${arch}`)) return true;
  try {
    const pkg: unknown = JSON.parse(await readFile(resolve(dirname(args[0]), "../../package.json"), "utf8"));
    return z.object({ name: z.literal("orca-t3-bridge") }).safeParse(pkg).success;
  } catch { return false; }
}
