# Troubleshooting

Start with `orca-t3-bridge --version` and `orca-t3-bridge doctor`. Check the tested
app versions in the README before upgrading either app.

| Symptom | Next step |
| --- | --- |
| `init` asks for an app | Supply `--t3-app` explicitly; it will not guess between stable and nightly |
| `init` asks for a URL | Open T3, or provide its real origin with `--t3-url` and matching `--t3-base-dir` |
| Configuration already exists | Edit that file or choose another `--config`; initialization never overwrites it |
| Orca unavailable | Open Orca and check `orca.appPath` and optional `orca.userDataPath` |
| Durable delivery unavailable | Use a compatible Orca version advertising `terminal.prompt-delivery.v1` |
| No sessions imported | Confirm an Orca agent is running and check exact workspace include/exclude paths |
| Provider ID already owned | Choose a separate `t3.instanceId`; the bridge will not replace another command |
| History stops updating | Open the failed turn, use `/orca-refresh`, and check service status/logs |
| Showing recent Orca history | Only the T3 display window is bounded; older context remains with Orca |
| Runtime instructions unsupported | T3's instruction template changed; use the tested version or report compatibility details |
| Native form unsupported | Answer that request in Orca, then refresh in T3 |
| Service stopped | Fix the connection or compatibility issue, then run `service start` |

## Uncertain delivery

If the bridge loses acknowledgment, it cannot assume the prompt failed. It records
an `unknown` receipt and blocks further sends to that target. Inspect the original
Orca conversation before repeating anything.

```sh
orca-t3-bridge receipts list
orca-t3-bridge receipts resolve --operation OPERATION_ID --outcome accepted
```

Use `accepted` when Orca received the prompt. Use `rejected` only when you have
established it did not. Resolution sends nothing. A live connection holding the
receipt must finish before resolution. These commands work without a running Orca.
Do not erase the state directory as a workaround.

If the output read failed after acceptance, refresh to retrieve the reply. Avoid
sending the same message again just because the client displayed an error: a new
explicit message is a new send.

## Reporting a bug

Include bridge, Node, macOS, T3 and Orca versions, the failing command, a sanitized
error and reproduction steps in a [GitHub issue](https://github.com/ZipLyne-Agency/orca-t3-bridge/issues/new/choose).
Remove tokens, private project names, local paths and conversation text. Do not
attach app databases, runtime metadata, complete logs or your private config.
Security reports belong in [private vulnerability reporting](https://github.com/ZipLyne-Agency/orca-t3-bridge/security/advisories/new).
