# Changelog

## 0.2.3 - 2026-10-21

- Run in the background without a menu bar item.
- Open controls from Applications or Spotlight to manage sync, login, and updates.
- Keep syncing when the controls window closes; login launches remain quiet.

## 0.2.2 - 2026-10-18

- Renew expired observers without resending prompts or duplicating imported history.
- Finish history refreshes while Orca is working; cancelling a refresh leaves Orca running.
- Stop repeated automatic refresh failures even when new Orca output arrives.
- Respect archived and deleted threads, and allow manual refresh recovery.

## 0.2.0 - 2026-10-18

- Add a native menu bar app with a bundled universal runtime, automatic discovery,
  connection status, pause/resume, and launch at login.
- Distribute Developer ID signed, Apple notarized DMG and ZIP downloads.
- Deliver automatic updates through Sparkle with signed feeds and archives.
- Preserve existing configuration, conversation IDs, and delivery receipts when
  moving from the CLI; prevent overlapping sync workers.
- Recover from unavailable local apps and changed automatic T3 ports, with bounded
  worker crash recovery and clean shutdown.
- Publish a responsive guide with a short explanation and full setup instructions.

## 0.1.0 - 2026-10-18

Initial public release by ZipLyne.

- Import existing Orca terminal and native chat sessions into standard T3 clients.
- Read bounded conversation history and incremental output; reply to the original agent.
- Handle supported native approvals and questions through human input forms.
- Preserve delivery receipts, runtime identity checks and explicit uncertain-send recovery.
- Discover local macOS installations with `init`; support custom app paths and profiles.
- Offer manual sync and an optional macOS login service.
- Include fixture tests, installed-T3 smoke tooling and a compiled release archive.

Verified with Orca 1.4.226 and T3 Code Nightly
0.0.46-nightly.20261014.3132. macOS only; see README for current limitations.
