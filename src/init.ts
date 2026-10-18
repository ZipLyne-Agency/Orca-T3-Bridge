import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { configSchema, type Config } from "./config.js";
import { BridgeError } from "./errors.js";
import { runProcess } from "./process.js";

export const defaultConfigPath = () => join(homedir(), ".config", "orca-t3-bridge", "config.json");

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function t3Application(appPath: string): Promise<{ executable: string; executableArgs: string[] }> {
  const app = resolve(appPath);
  const name = (await runProcess("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-",
    join(app, "Contents", "Info.plist")])).trim();
  if (!name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) {
    throw new BridgeError("t3_application", "T3 has an invalid bundle executable name.");
  }
  const executable = join(app, "Contents", "MacOS", name);
  const server = join(app, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs");
  // app.asar is a file to Node; Electron resolves the entrypoint inside it.
  if (!await exists(executable) || !await exists(join(app, "Contents", "Resources", "app.asar"))) {
    throw new BridgeError("t3_application", "The T3 application bundle is incomplete. Supply --t3-app with the installed app path.");
  }
  return { executable, executableArgs: [server] };
}

export async function initialize(configFile: string, options: {
  t3Url?: string | undefined; t3BaseDir?: string | undefined;
  t3App?: string | undefined; orcaApp?: string | undefined;
}, environment = { home: homedir(), applications: "/Applications" }): Promise<Config> {
  if (await exists(configFile)) throw new BridgeError("config_exists", "Configuration already exists. Edit it or choose another --config path.");
  let app = options.t3App;
  if (!app) {
    const candidates = [join(environment.applications, "T3 Code.app"), join(environment.applications, "T3 Code Nightly.app")];
    const installed = [];
    for (const path of candidates) if (await exists(path)) installed.push(path);
    if (installed.length !== 1) throw new BridgeError("t3_application", "Supply --t3-app with the T3 application you want to connect (exactly one installation must be discoverable).");
    app = installed[0]!;
  }
  const t3App = await t3Application(app);
  const baseDir = resolve(options.t3BaseDir ?? join(environment.home, ".t3"));
  let url = options.t3Url;
  if (!url) {
    try {
      const runtime = z.object({ port: z.number().int().min(1).max(65535) })
        .parse(JSON.parse(await readFile(join(baseDir, "userdata", "server-runtime.json"), "utf8")));
      url = `http://127.0.0.1:${runtime.port}/`;
    } catch {
      throw new BridgeError("t3_url", "Open T3 desktop first, or supply --t3-url and --t3-base-dir for your T3 environment.");
    }
  }
  const orcaApp = resolve(options.orcaApp ?? join(environment.applications, "Orca.app"));
  if (!await exists(orcaApp)) throw new BridgeError("orca_application", "Install Orca or supply --orca-app with its application path.");
  const config = configSchema.parse({ sourceId: "local-orca", orca: { appPath: orcaApp },
    stateDir: join(environment.home, ".local", "state", "orca-t3-bridge"),
    t3: { url, baseDir, ...t3App, instanceId: "orca" } });
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}
