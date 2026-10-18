# Configuration and CLI

All commands use `~/.config/orca-t3-bridge/config.json` unless you supply
`--config /absolute/path/config.json`. Run `init` once. It creates parent
directories and a mode-0600 configuration file, without enabling the provider.

## Automatic setup

```sh
orca-t3-bridge init
```

The bridge looks for `/Applications/T3 Code.app` and
`/Applications/T3 Code Nightly.app`. It requires exactly one match, or an explicit
`--t3-app` choice. It reads the bundle executable from `Info.plist`, then reads the
port from `<t3 baseDir>/userdata/server-runtime.json`. It uses that port on
`127.0.0.1`, even if T3 listens on other interfaces. No credential is copied.

## Custom installations

```sh
orca-t3-bridge init \
  --config "$HOME/.config/orca-t3-bridge/config.json" \
  --t3-app "/Applications/T3 Code Nightly.app" \
  --t3-base-dir "$HOME/.t3" \
  --t3-url "http://127.0.0.1:3773/" \
  --orca-app "/Applications/Orca.app"
```

The port above is an example. Choose the actual origin of your T3 environment.
`baseDir` must belong to that same server because its auth CLI issues the bridge's
scoped session. The bridge must run on the Mac hosting Orca and the T3 server.

For a standalone T3 server executable, prepare a configuration using
[`config.example.json`](../config.example.json), set `t3.executable` to its absolute
path, and set `t3.executableArgs` to `[]`. The example contains `/Users/you`
placeholders. JSON paths must be absolute; shell variables and `~` are not expanded.

## Fields

| Field | Purpose / default |
| --- | --- |
| `sourceId` | Stable source identity, default `local-orca`; keep it unchanged after import |
| `orca.appPath` | Orca bundle, default `/Applications/Orca.app` |
| `orca.userDataPath` | Optional Orca profile override |
| `orca.requestTimeoutMs` | Local request deadline, default `10000` |
| `stateDir` | Private receipts and sync data, default `~/.local/state/orca-t3-bridge` resolved to your home |
| `includeWorktrees` | Exact absolute paths to include; `[]` includes all discoverable sessions |
| `excludeWorktrees` | Exact absolute paths to omit; exclusions win |
| `t3.url` | HTTPS origin or loopback HTTP origin, without credentials, query or path |
| `t3.baseDir` | T3 server data directory |
| `t3.executable` | Absolute T3 executable or app Electron executable |
| `t3.executableArgs` | Server entrypoint for Electron; otherwise CLI arguments |
| `t3.instanceId` | Dedicated provider ID, default `orca` |
| `polling.activeMs` / `idleMs` / `syncMs` | Default `1000` / `5000` / `15000` |
| `limits.sessions` / `attachedPerProcess` | Default `128` / `8` |
| `limits.historyItems` / `historyBytes` | Default `1000` / `1048576` |
| `limits.promptBytes` / `observationMs` | Default `65536` / `3600000` |

All values are validated against bounded ranges in
[`src/config.ts`](../src/config.ts). No API key belongs in this file.

## Commands

| Command | Effect |
| --- | --- |
| `init` | Create a configuration; existing files are preserved |
| `doctor` | Read Orca status, session count and delivery capability |
| `doctor --offline` | Validate runtime defaults without connecting; add `--config` to validate a file |
| `provider` | Print the ACP provider entry for inspection |
| `enable` / `disable` | Enable or disable only the matching T3 provider |
| `sync` | Import/reuse eligible sessions and refresh changed history |
| `sync --watch` | Repeat sync until interrupted or three consecutive failures |
| `acp` | ACP stdio entrypoint, launched by T3 |
| `receipts list` | Inspect delivery receipt metadata |
| `receipts resolve --operation ID --outcome accepted\|rejected` | Record the result of manual inspection; sends nothing |
| `--help` / `--version` | Show usage / package version |

## Background sync

```sh
orca-t3-bridge service render --output "$HOME/orca-t3-agent.plist"
orca-t3-bridge service install
orca-t3-bridge service status
```

`render` only writes a plist for inspection. `install` creates a LaunchAgent and
starts it. It runs at login and has no automatic restart loop. `service start`
restarts it after a failure; `service uninstall` stops and removes the matching
service. Errors are written to `stateDir/service-error.log`; routine output is discarded.
A foreground `sync --watch` is an alternative; stop it with Ctrl-C.

## Upgrading and removing

Install the new release archive, then run `enable` again if its executable path
changed. Reinstall the service if the Node or package path changed. T3 can retain
an existing ACP subprocess; restart the imported provider connection or T3 when
ready to load updated code, after active work has settled.

Keep `sourceId`, `stateDir` and `t3.instanceId` stable. Do not delete receipt state
to clear a delivery error. Resolve uncertain sends first.

To remove the integration, run `service uninstall`, then `disable`, then
`npm uninstall --global orca-t3-bridge`. Imported history stays in T3. Source edits
or deletions in Orca do not erase previously imported text.
