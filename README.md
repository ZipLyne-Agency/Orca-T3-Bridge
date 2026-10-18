<div align="center">

# Orca -> T3 Code

### Your Orca agents. Your favorite T3 client.

Read and reply to existing Orca sessions from the standard T3 Code mobile and desktop apps.

[![Checks](https://github.com/ZipLyne-Agency/orca-t3-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ZipLyne-Agency/orca-t3-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ZipLyne-Agency/orca-t3-bridge)](https://github.com/ZipLyne-Agency/orca-t3-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-black.svg)](#requirements)

**[Download](https://github.com/ZipLyne-Agency/orca-t3-bridge/releases/latest) | [Setup](#quick-start) | [Configuration](docs/configuration.md) | [Troubleshooting](docs/troubleshooting.md) | [Contribute](CONTRIBUTING.md)**

Built by [ZipLyne](https://github.com/ZipLyne-Agency).

</div>

---

Keep your agents and workspaces in Orca. Open their conversations in T3, catch up
on progress, and send the next instruction from your phone. Orca continues running
the original session with its existing context, model and permissions.

```text
T3 on your phone --> Your T3 server --> This bridge --> Your Orca session
```

No custom phone app. No separate bridge account. Everything runs on the Mac that
already hosts Orca and T3.

## What you can do

| Capability | What happens |
| --- | --- |
| Bring sessions into T3 | Discover and import existing Orca terminals and native chats |
| Pick up a conversation | Read recent history and reply to the same running agent |
| Follow work from your phone | Read incremental output, reasoning and supported tool output |
| Answer native requests | Respond to supported approvals, choices and written questions |
| Keep sessions discoverable | Use the menu bar app with automatic sync and launch at login |
| Disconnect cleanly | Disable the bridge while keeping imported history and Orca agents |

**Early release:** this bridge depends on versioned Orca and T3 interfaces. The
compatibility table below lists the tested combination. New app versions may need
adapter updates.

## Requirements

- macOS 13 or later with Orca and T3 Code installed on the same Mac.
- The Mac app includes its runtime. The optional CLI needs Node.js **22.18 or later** and npm.
- Orca and T3 desktop open, with an existing Orca agent session.
- For phone access, the T3 mobile app already connected to this Mac's T3 environment.

| Component | Verified combination |
| --- | --- |
| Orca | `1.4.226` with `terminal.prompt-delivery.v1` |
| T3 Code Nightly | `0.0.46-nightly.20261014.3132`, commit `5a4e99805337` |
| Protocols | ACP v1 and T3 orchestration protocol 2 |
| Host | macOS; Linux and Windows are not supported in this release |

The Mac must stay awake and reachable through T3's existing connection. The bridge
does not set up remote access, port forwarding or phone pairing.

## Mac app

[Download the signed and notarized Mac app](https://github.com/ZipLyne-Agency/orca-t3-bridge/releases/latest) or [read the interactive guide](https://ziplyne-agency.github.io/Orca-T3-Bridge/).

1. Open the DMG and drag **Orca T3 Bridge** to **Applications**.
2. Open Orca, T3 Code, then Orca T3 Bridge. Choose **Connect Orca and T3**.
3. Use **Bridge** in the menu bar to check status, sync, pause, or change login and update preferences.

The app starts at login after the first successful connection. It remembers whether
syncing is enabled, waits when Orca or T3 is closed, and resumes when they return.
Sparkle checks for signed updates automatically. **Check for Updates** is also
available in Settings and the menu bar's More menu.

Existing command-line configuration, imported conversation IDs, and delivery receipts
are preserved. Connecting migrates the provider to the bundled runtime and removes
only a matching legacy sync login service. Keep the app in Applications so its path
stays stable across updates. Pausing stops discovery; existing conversations remain
usable through T3. Quit stops the sync worker. To uninstall, turn off **Open at login**,
disable the provider as described in the [guide](https://ziplyne-agency.github.io/Orca-T3-Bridge/#remove),
quit, then remove the app.

The universal download supports Apple Silicon and Intel. See [macOS development and release](docs/macos.md).

## Quick start (optional CLI)

### 1. Install the release

Download **`orca-t3-bridge-0.2.2.tgz`** from the
[latest release](https://github.com/ZipLyne-Agency/orca-t3-bridge/releases/latest),
then install it from your Downloads directory:

```sh
npm install --global "$HOME/Downloads/orca-t3-bridge-0.2.2.tgz"
orca-t3-bridge --version
```

The archive contains compiled JavaScript. Building from source is optional.
Published archives include a `SHA256SUMS` file for checksum verification.

### 2. Connect your local apps

With Orca and T3 open:

```sh
orca-t3-bridge init
orca-t3-bridge doctor
orca-t3-bridge enable
orca-t3-bridge sync
```

`init` detects the installed T3 app and its local port, then writes a private
configuration at `~/.config/orca-t3-bridge/config.json`. It never overwrites an
existing configuration. If both stable and nightly T3 are installed, select one:

```sh
orca-t3-bridge init --t3-app "/Applications/T3 Code Nightly.app"
```

Custom profiles, ports and app locations are covered in
[configuration](docs/configuration.md). `doctor` checks Orca discovery; `enable`
connects the provider to T3; `sync` imports the sessions.

### 3. Open T3 on your phone

Open an imported Orca conversation and send a reply using T3's normal composer.
The reply goes to the original Orca agent. Imported history appears inside a
refresh turn with **You in Orca** and **Orca** labels. New messages use the normal
T3 chat flow.

Use `/orca-refresh` to fetch current output without sending an agent prompt.
Run `orca-t3-bridge sync` again to discover newly opened sessions.

### Optional: sync at login

```sh
orca-t3-bridge service install
orca-t3-bridge service status
```

This installs a macOS LaunchAgent. It stops after three consecutive sync failures;
if the apps were unavailable at login, open them and run
`orca-t3-bridge service start`. [Service details](docs/configuration.md#background-sync).

## Know the boundaries

- **Existing sessions only.** Create agents, change models and manage permissions in Orca.
- **Text and resource links.** Send images, audio and embedded files directly in Orca.
- **Recent history.** The default import window is 1,000 items / 1 MiB. Older history remains in Orca; its agent context is unchanged.
- **Human decisions stay human.** Supported native forms appear in T3. Rich terminal prompts and unsupported requests must be answered in Orca.
- **Explicit Stop interrupts Orca.** Disabling or closing the bridge leaves its agents running.
- **Uncertain sends require inspection.** The bridge records receipts and never automatically resends an uncertain prompt. [Recover a send](docs/troubleshooting.md#uncertain-delivery).

Discovery and refresh do not call a model. Your explicit reply can start paid work
in the existing Orca agent, subject to that agent's own provider and tool limits.
The bridge does not impose a provider-wide spending cap.

## Disconnect

```sh
orca-t3-bridge service uninstall
orca-t3-bridge disable
```

Imported history remains in T3. Preserve the bridge's state directory during
upgrades because it contains delivery receipts and synchronization metadata.
[Upgrade and removal guide](docs/configuration.md#upgrading-and-removing).

## Build and contribute

```sh
git clone https://github.com/ZipLyne-Agency/orca-t3-bridge.git
cd orca-t3-bridge
npm ci --ignore-scripts
npm run check
npm run test:package
```

Tests use fake Orca agents and temporary profiles. The optional `npm run test:t3`
checks the installed T3 server in isolation with real model providers disabled.
See [CONTRIBUTING.md](CONTRIBUTING.md) for compatibility testing and development.

## Learn more

- [Configuration and CLI](docs/configuration.md)
- [Troubleshooting and delivery recovery](docs/troubleshooting.md)
- [Architecture, data handling and limits](docs/architecture.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
This is an independent ZipLyne project, unaffiliated with the Orca and T3 Code teams.
