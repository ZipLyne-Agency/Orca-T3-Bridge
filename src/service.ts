import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { BridgeError } from "./errors.js";
import { runProcess } from "./process.js";
import { digest } from "./util.js";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function launchAgent(config: Config, configFile: string, entrypoint: string,
  executable = process.execPath, userHome = homedir()): { label: string; path: string; contents: string } {
  if (!config.t3) throw new BridgeError("t3_not_configured", "Configure T3 before preparing the sync service.");
  const label = `agency.ziplyne.orca-t3.${digest({ configFile, source: config.sourceId }).slice(0, 16)}`;
  const args = [executable, entrypoint, "sync", "--watch", "--config", configFile];
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(dirname(configFile))}</string>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>${xml(join(config.stateDir, "service-error.log"))}</string>
</dict></plist>\n`;
  // No KeepAlive: a terminal sync failure stays stopped instead of restarting forever.
  return { label, path: join(userHome, "Library", "LaunchAgents", `${label}.plist`), contents };
}

export async function service(action: string, config: Config, configFile: string,
  entrypoint: string, output?: string): Promise<string> {
  const agent = launchAgent(config, configFile, entrypoint);
  if (action === "render") {
    if (!output) return agent.contents;
    await writeFile(output, agent.contents, { flag: "wx", mode: 0o600 });
    return "LaunchAgent prepared. It has not been installed or started.\n";
  }
  if (process.platform !== "darwin" || !process.getuid)
    throw new BridgeError("unsupported_service", "LaunchAgent management requires macOS. Use sync --watch on other hosts.");
  const domain = `gui/${process.getuid()}`;
  if (action === "status" || action === "start") {
    if (action === "start") {
      const existing = await readFile(agent.path, "utf8");
      if (existing !== agent.contents) throw new BridgeError("service_collision", "Inspect the changed LaunchAgent before starting it.");
      await runProcess("/bin/launchctl", ["kickstart", `${domain}/${agent.label}`]);
      return "Sync service start requested. Use service status to inspect it.\n";
    }
    const info = await runProcess("/bin/launchctl", ["print", `${domain}/${agent.label}`])
      .catch(() => undefined);
    return JSON.stringify({ label: agent.label, loaded: info !== undefined,
      running: info !== undefined && /\bstate = running\b/.test(info), path: agent.path }) + "\n";
  }
  if (!["install", "uninstall"].includes(action))
    throw new BridgeError("arguments", "Use service render, install, uninstall, or status.");
  const existing = await readFile(agent.path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined && existing !== agent.contents)
    throw new BridgeError("service_collision", "The LaunchAgent file has changed. Inspect it before changing this service.");
  if (action === "install") {
    await mkdir(dirname(agent.path), { recursive: true });
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    if (existing === undefined) await writeFile(agent.path, agent.contents, { flag: "wx", mode: 0o600 });
    await runProcess("/bin/launchctl", ["bootstrap", domain, agent.path]);
    return `Sync service installed: ${agent.label}\n`;
  }
  if (existing === undefined) return "Sync service is not installed.\n";
  const loaded = await runProcess("/bin/launchctl", ["print", `${domain}/${agent.label}`])
    .then(() => true).catch(() => false);
  if (loaded) await runProcess("/bin/launchctl", ["bootout", domain, agent.path]);
  await unlink(agent.path);
  return "Sync service removed. Existing Orca agents and imported T3 history remain.\n";
}
