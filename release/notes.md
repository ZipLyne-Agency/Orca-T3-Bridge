Fix repeated "Thread failed" notifications from background history refreshes.

Expired observers renew automatically. History refreshes finish while Orca keeps working, and cancelling a refresh leaves the original agent running. Archived and deleted threads stay excluded. An unresolved refresh failure stops automatic retries even when new output arrives.

If an old failed refresh remains, send `/orca-refresh` in that T3 thread, then resume sync from the Bridge menu. To keep a workspace only in Orca, add its exact absolute path to `excludeWorktrees` in the bridge configuration.

This update preserves your configuration, conversation mappings, and delivery receipts. The Mac app and disk image are signed and notarized, with a signed Sparkle update.
