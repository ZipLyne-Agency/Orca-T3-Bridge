import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute, "Use an absolute path");
const slug = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

export const configSchema = z.object({
  sourceId: slug.default("local-orca"),
  orca: z.object({
    appPath: absolutePath.default("/Applications/Orca.app"),
    userDataPath: absolutePath.optional(),
    requestTimeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  }).default({ appPath: "/Applications/Orca.app", requestTimeoutMs: 10_000 }),
  stateDir: absolutePath.default(join(homedir(), ".local", "state", "orca-t3-bridge")),
  includeWorktrees: z.array(absolutePath).max(256).default([]),
  excludeWorktrees: z.array(absolutePath).max(256).default([]),
  polling: z.object({
    activeMs: z.number().int().min(250).max(10_000).default(1000),
    idleMs: z.number().int().min(1000).max(60_000).default(5000),
    syncMs: z.number().int().min(5000).max(300_000).default(15_000),
  }).default({ activeMs: 1000, idleMs: 5000, syncMs: 15_000 }),
  limits: z.object({
    sessions: z.number().int().min(1).max(256).default(128),
    attachedPerProcess: z.number().int().min(1).max(32).default(8),
    historyItems: z.number().int().min(20).max(2000).default(1000),
    historyBytes: z.number().int().min(16_384).max(4_194_304).default(1_048_576),
    promptBytes: z.number().int().min(1024).max(131_072).default(65_536),
    observationMs: z.number().int().min(10_000).max(86_400_000).default(3_600_000),
  }).default({ sessions: 128, attachedPerProcess: 8, historyItems: 1000,
    historyBytes: 1_048_576, promptBytes: 65_536, observationMs: 3_600_000 }),
  t3: z.object({
    url: z.url().refine((value) => {
      const u = new URL(value);
      return !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" &&
        (u.protocol === "https:" || (u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)));
    }, "Use an HTTPS origin or loopback HTTP origin without credentials"),
    autoDetectUrl: z.boolean().default(false),
    baseDir: absolutePath,
    executable: absolutePath,
    executableArgs: z.array(z.string().max(4096)).max(16).default([]),
    instanceId: slug.default("orca"),
  }).optional(),
}).strict();

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(path?: string): Promise<Config> {
  const raw: unknown = path ? JSON.parse(await readFile(resolve(path), "utf8")) : {};
  return configSchema.parse(raw);
}

export function permitsWorktree(config: Config, cwd: string): boolean {
  const normalized = resolve(cwd);
  return !config.excludeWorktrees.some((root) => resolve(root) === normalized) &&
    (config.includeWorktrees.length === 0 ||
      config.includeWorktrees.some((root) => resolve(root) === normalized));
}
