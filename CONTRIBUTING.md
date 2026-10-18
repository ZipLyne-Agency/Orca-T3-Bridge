# Contributing

Bug reports, compatibility updates and focused pull requests are welcome.
For a larger feature, open an issue to agree on the behavior first.

## Development

Use macOS and Node.js 22.18 or later:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

The test suite uses temporary fake Orca runtimes, fake messages and local sockets.
It needs no provider credentials, running agents or paid model calls. Tests cover
session identity, import projection, prompt extraction, receipts, leases,
questions, approvals, cancellation, history windows, response bounds and setup.
The package smoke installs the compiled archive into a fresh prefix and exercises
its CLI without contacting Orca or T3.

## Installed T3 compatibility smoke

Install the app versions in the README. Then run:

```sh
T3_APP_PATH="/Applications/T3 Code Nightly.app" npm run test:t3
```

This launches a temporary T3 server profile with real model providers disabled
and a fake Orca runtime. It exercises discovery, idempotent import, history,
external updates, reconnect, reply forwarding, native approvals and disabling.
It stops its server and removes its temporary profile on completion. It reads
Orca's installed metadata module from `/Applications/Orca.app` but uses a fake
profile. Failure diagnostics go to `~/Assets/orca-t3-bridge/files` or
`BRIDGE_DIAGNOSTICS_DIR`. Inspect diagnostics before sharing them.

CI runs the fixture suite and package smoke on a hosted macOS runner. The
installed-app smoke runs locally because those desktop applications are not
bundled in this repository. LaunchAgent lifecycle and phone form rendering also
need separate manual checks; fixture tests do not prove those surfaces.

## Changes and compatibility

Keep prompts, credentials and personal transcripts out of fixtures. Add a focused
regression test for a behavior change. Preserve uncertain-delivery handling and
runtime identity checks. Discovery and history refresh must never send an agent
prompt. Do not automatically approve an Orca request.

When updating the T3 instruction fixture, retain its source version and license in
`THIRD_PARTY_NOTICES.md`. Run the installed-server smoke and update the compatibility
table with observed versions. Do not widen a parser merely to suppress an error.

## Releases

Update `package.json`, `npm-shrinkwrap.json` and `CHANGELOG.md`, run checks, and
build with `npm pack --pack-destination /absolute/path/outside-the-checkout`.
Inspect archive contents for private data, compute SHA-256 checksums, and attach
the archive and `SHA256SUMS` to a GitHub release matching the package version.
Verify a fresh installation from the public download. Releases are distributed
through GitHub; an npm registry publication is not required.

Contributions are accepted under the repository's MIT license. Be respectful,
keep discussions constructive, and use private reporting for security issues.
