# Mac app development and release

The native background app lives in `macos/`. It supervises the same TypeScript bridge
used by the CLI. Configuration and receipts live outside the application bundle,
so app updates preserve them. Sparkle is pinned in SwiftPM; Node downloads are pinned
by architecture and SHA-256 in `release/runtime.json`.

## Build and check

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
swift test --package-path macos --jobs 4
bash scripts/build-macos.sh
```

The default output is `~/Assets/orca-t3-bridge/files/macos`. Set `BRIDGE_OUTPUT` to
change it. An unsigned local build uses ad hoc signing. Distribution requires
`BRIDGE_SIGNING_IDENTITY` and `BRIDGE_TEAM_ID`. Never distribute an ad hoc build.
Only bundled Node has JIT entitlements; the native supervisor does not.

## Release

Update `package.json`, `npm-shrinkwrap.json`, `release/version.json`, the changelog,
and `release/notes.md`. Increase the numeric build every release. Verify locally,
commit the scoped changes, and push a matching `v<version>` tag. Run **Release Mac
app** from GitHub Actions on main. The workflow only runs manually on main, uses a
disposable hosted Mac, and stops after its timeout. It creates a draft release,
uploads all verified assets, then publishes it as latest.

The `release` GitHub environment is limited to the `main` branch. Its encrypted secrets are: `SIGNING_P12` (base64), `SIGNING_PASSWORD`,
`NOTARY_KEY` (PEM), `NOTARY_KEY_ID`, `NOTARY_ISSUER`, and `SPARKLE_PRIVATE_KEY`.
Build and package steps run before any signing credentials are injected. The signing script creates an ephemeral keychain, restores the prior search list,
and deletes its temporary key material. The public Sparkle key is committed in
`release/sparkle-public-key.txt`; keep its private counterpart backed up in the
secret manager. Losing it breaks continuity for existing installations.

For a local release, broker those credentials into a scoped process. Provide
`NOTARY_API_KEY_FILE`, `NOTARY_KEY_ID`, `NOTARY_ISSUER`, or use `NOTARY_PROFILE`.
Sparkle uses the `agency.ziplyne.orca-t3.updates` keychain account by default;
`SPARKLE_KEY_FILE` selects a protected key file instead. Run
`python3 scripts/release-macos.py --publish` only from a clean tagged checkout.

Publication requires a higher Sparkle build number than the current release. The release fails unless Apple accepts both the app and DMG, stapling succeeds,
Gatekeeper accepts the app, and Sparkle verifies both the feed and archive.
`SHA256SUMS` covers the DMG, ZIP, and appcast. Keep notarization receipts locally.
The latest GitHub release serves the signed appcast; each enclosure points to its
immutable versioned release. Do not replace assets for a published version.

## Lifecycle and failure behavior

After the first successful connection, `SMAppService.mainApp` registers login
launch and the app saves the sync preference in UserDefaults. It uses one worker
with a shared sync lease, normal configured polling, and capped availability
backoff. Worker crashes get three recovery attempts per five-minute window before
requiring a deliberate retry. Closing stdin stops the worker if the app dies.
Quit waits for worker termination, with a forced termination deadline.

Pause stops session discovery and preserves existing T3 conversations. Sync respects deleted T3 projects and continues with other workspaces; adding the workspace in T3 again allows new sessions there. Previously deleted conversations remain deleted. Automatic
sync never sends agent prompts. A user reply still follows the existing durable
receipt and uncertain-send handling. Native controls do not bypass it.

Before shipping, check that no menu bar item appears, reopen the controls window, connect, pause/resume, app relaunch, login item
registration, and an actual Sparkle update from a lower build. A process relaunch
is evidence for app recovery; it does not prove a full computer reboot. Intel
compilation does not prove Intel runtime behavior.
