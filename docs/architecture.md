# How the bridge works

```text
T3 phone / desktop
        |
T3 server (your existing environment)
        |
ACP provider: orca-t3-bridge
        |
Orca local Unix socket
        |
Your existing agent and workspace
```

The bridge runs on the Mac hosting Orca and T3. Orca owns the agent process,
workspace, tools, model and permissions. T3 owns its client connection and the
imported copy of conversation history. The bridge uses ACP v1 and T3 orchestration
protocol 2. It adds no public listener or hosted service.

## Import and observation

Discovery identifies running terminals by source, host, PTY and incarnation, and
native chats by source and session ID. Workspace filters use exact absolute paths.
Imports are idempotent. Creating T3 projects supplies an empty scripts list so
imports do not inherit host automation scripts.

T3 creates the imported conversation before persisting its transcript. A reserved
`/orca-refresh` control turn hydrates history and observes existing work without
sending a prompt to Orca. History appears as **You in Orca** and **Orca** text
inside that turn. New replies use the ordinary T3 composer. The bounded history
notice appears once during import and never accompanies ordinary replies.

The adapter reads structured Claude, Codex and OpenCode transcripts where
available, with cleaned terminal output as a fallback. Its instruction adapter
removes the verified T3 runtime wrappers from explicit replies. Unknown templates
fail before delivery; updates require a fixture and compatibility check.

## Delivery and recovery

A shared SQLite lease serializes writes to a target. Each operation records an ID
and payload fingerprint before delivery. Terminal sends verify runtime identity
and a durable Orca receipt. Native mutations use the runtime fence and canonical
fingerprint. An uncertain acknowledgment blocks subsequent sends to that session
until the operator reconciles it. There is no automatic resend.

This does not provide global exactly-once delivery across independent user
messages. Repeating a message after a completed turn is a new explicit send.
[Recovery instructions](troubleshooting.md#uncertain-delivery) explain reconciliation.

## Bounds and data handling

| Control | Default |
| --- | --- |
| Catalog | 128 eligible sessions; hard ceiling 256 |
| Attached sessions | 8 per bridge process |
| Prompt | 65,536 UTF-8 bytes; terminal control characters rejected |
| History window | 1,000 items and 1 MiB |
| Observation lifetime | 1 hour; Orca continues after detachment |
| Polling | Active 1 second, idle 5 seconds, sync 15 seconds |
| Read and sync failures | Three consecutive failures, then stop |
| Delivery receipts | 20,000 entries; completed entries expire after 7 days |
| T3 authentication | Own scoped session, 1-hour expiry, revoked on close |
| T3 HTTP responses | 4 MiB normally; 16 MiB for compact bounded thread snapshots, which repeat text across projection fields |

Sync requires `settings:write` along with orchestration and provider permissions because T3 requires it when creating projects with an explicit empty scripts list. Imports keep that list empty to avoid inheriting host automation scripts. The installed-server smoke uses the same scope set as the standalone sync command.

Synchronization and refresh perform no model calls. An explicit reply can start paid work in the existing Orca agent. These controls bound the bridge's delivery and observation behavior; provider spend caps and the original agent's own tool/retry limits remain outside this package and have not been verified.

The package keeps Orca credentials in memory for local socket calls and T3 credentials in memory for its scoped connection. It stores receipt hashes, IDs and synchronization revisions rather than prompt text. T3 stores the imported conversation text in its own environment. Deleting or editing source messages cannot erase copies already imported into T3.

## Current limits

Image, audio and embedded-file forwarding are unavailable; attach them in Orca. The bridge does not change models or permission modes, create an agent, fork a session, restore a checkpoint, expose Orca's full terminal UI, or control another computer's workspace. Unknown journal content stays available in Orca.

Terminal approval screens do not have structured form metadata. The bridge reports that Orca is waiting; answer in Orca when the terminal needs a richer interaction. Native approval subjects the bridge cannot display also stay in Orca. A client declining or failing a native form leaves the request pending and reports that handoff.

History delivery and T3 persistence are separate transactions. Ordinary reconnects are deduplicated, but a process crash precisely between delivery and recording projection progress can require inspecting the imported conversation. Live conversation deletion and historical edit reconciliation are outside this first version.

History refreshes copy the current snapshot and finish even when Orca is still working. Pending native forms remain interactive until answered, cancelled, handed off or the observation deadline is reached. Cancelling a history refresh leaves the Orca agent running. Idle observers expire quietly and are renewed on the next load or prompt; renewal does not resend a prompt.

If a local refresh fails in T3, inspect its failed turn and use `/orca-refresh` there to retry the local read. Automatic sync stops on an unresolved failed refresh even if newer Orca output changes the source revision. After a successful manual recovery, resume sync. Removed projects and removed or archived threads are skipped.
