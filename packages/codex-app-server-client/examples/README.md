# Runnable examples

In client `0.2.0`, the three safety examples and numbered groups 01–14 and 16 use the **real bundled Codex 0.154.0 app-server**,
with a local scripted Responses provider by default. They need no account, send no requests to a
model service, and do not execute the command proposed in the approval fixture. Each gets a temporary
workspace and Codex home; both are deleted on normal exit. Group 15 instead uses a scripted login RPC
fixture, so automatic tests do not start OAuth. Installation may download npm packages.

The [official-example mapping](../docs/official-examples.md) lists all 16 groups, their assertions and
the version boundary. These numbered examples are introduced in `0.2.0`, **not present
in the already-published `0.1.0` tarball**. The commands for the three safety examples below also work
with that published release.

## Commands

From a source checkout, first use Node.js 22+ and `pnpm install --frozen-lockfile` (which builds
`dist/`). Then:

```bash
node examples/stream.mjs
node examples/approvals.mjs
node examples/interrupt-resume.mjs
node examples/01_quickstart_constructor.mjs
node examples/11_cli_mini_app.mjs --interactive
node examples/15_login_and_account.mjs
node examples/16_external_message.mjs
pnpm examples:smoke
```

From a consumer with the published package or a local tarball installed, Node.js 18+ can run the shipped files directly:

```bash
node node_modules/@jaminzhou/codex-app-server-client/examples/stream.mjs
node node_modules/@jaminzhou/codex-app-server-client/examples/approvals.mjs
node node_modules/@jaminzhou/codex-app-server-client/examples/interrupt-resume.mjs
```

You can copy the whole `examples/` directory into your app. Imports resolve the installed scoped
package, not repository source. `lib/environment.mjs` contains setup/cleanup and explicit decline
defaults; `lib/mock-provider.mjs` supplies scripted model output. The login fixture resolves the SDK's
declared WebSocket dependency through its public schema export; no direct consumer dependency is needed.

## 1. Stream a conversation

`stream.mjs` creates an ephemeral thread, streams message deltas, checks the terminal status, and
closes the process in `finally`. Expected output:

```text
[mock] Real app-server, local provider, no model usage.
Hello from the local mock.
[turn] completed
```

Each turn handle has exactly one consumer. Choose `turn.events()` for streaming or `turn.result()`
/ `thread.run()` for collection. Do not call `result()` after consuming `events()`.
An external message may join an active turn; the two handles have the same turn ID but independent
streams. See [external-message semantics](../docs/api.md#untrusted-external-messages).
An RPC timeout limits request acknowledgement, not the total time a model turn may take.

## 2. Handle an approval explicitly

`approvals.mjs` receives an actual `item/commandExecution/requestApproval` callback from the pinned
runtime and returns `{ decision: "decline" }`. The mock proposes a marker-file command. The example
verifies the resulting command item is `declined` and the marker file does not exist.

Expected output (command wrapper and temporary path vary by OS):

```text
[mock] Real app-server, local provider, no model usage.
[approval] command=... cwd=...
[approval] decision=decline
The command was declined.
[turn] completed
[verified] Declined command did not execute.
```

For an approval UI, display the command, working directory, reason, and available decisions, then
await the user's choice in the callback. Return only a valid decision offered for that request.
Do not replace the handler with unconditional acceptance. A declined action can still lead to a
successful assistant turn explaining that it was declined.

The shared setup also declines file-change requests and grants no additional permissions. Other
unhandled server requests get a method-not-found response. This illustrates a narrow example
policy, not every tool or approval type. The runtime's sandbox and workspace policies still apply.

## 3. Interrupt, restart, and resume

`interrupt-resume.mjs` uses a persisted thread (`ephemeral: false`). After the first text delta it
calls `turn.interrupt()`, continues consuming until `turn/completed`, closes the app-server, starts
a new process with the same home, and calls `resumeThread(savedThreadId)` before a new turn.

```text
[mock] Real app-server, local provider, no model usage.
Starting a long answer...
[first turn] interrupted
[resume] Same persisted thread, new app-server process.
Continued in the same thread.
[second turn] completed
```

The mock holds its first response open, so interruption is deterministic. With a live model the
turn may finish before interruption arrives; a `completed` first turn is also a valid race outcome.
Saving a thread ID is useful only with the same persisted Codex home. The default mock home is
temporary and removed on exit; a real app should store its thread IDs and retain its selected home.
Resuming does not automatically repeat the interrupted tool or turn.

## Opt into real model output

See [authentication and usage](../README.md#run-with-your-codex-account), then append `--live` to an
individual example command, such as `node examples/stream.mjs --live`. The aggregate
`pnpm examples:smoke` is mock-only and rejects arguments, including `--live`; it is never a live-account
acceptance command. An individual live example uses your working directory and selected Codex home, and may consume model
usage. Live output and whether a model requests a tool are not deterministic. No automatic test
uses `--live`; the mock checks do not verify real account entitlement or model availability.

Exception: `15_login_and_account.mjs --live` starts and immediately cancels real OAuth in an isolated
temporary home, without opening a browser, reading your existing home, or running a model. It is not
a sign-in helper or a successful-login test. See the [numbered example boundaries](../docs/official-examples.md#deliberate-boundaries)
before using live lifecycle, model-selection or interactive CLI examples.

## Troubleshooting

| Symptom | Recovery |
| --- | --- |
| npm returns 404 for the scoped package | Check `npm view @jaminzhou/codex-app-server-client@0.2.1 version --registry https://registry.npmjs.org/`. If unavailable, use a verified local candidate. Check network access; do not infer publication from a source version or substitute the unscoped package. |
| Missing `dist/index.js` after a Git install | Build from source with Node.js 22+ or allow the exact Git source's `prepare` script in pnpm. A ready-built tarball avoids this build. |
| Cannot resolve the bundled CLI | Reinstall with optional dependencies enabled (`npm install --include=optional`). Check the OS/architecture in the error. The client does not search global PATH. |
| Login required / expired credentials | Run the pinned CLI's `login status`, then `login`, as the same user with the same `CODEX_HOME`. A home change selects different credentials/history. |
| Quota, rate limit, or unavailable model | Check the account/provider's limits and model availability. The client cannot add quota. Do not retry authentication or quota failures in an unbounded loop. |
| Approval appears to hang | Register a handler before starting the turn, await a user's decision, and return a protocol-valid response. Unknown handlers do not auto-approve. |
| Need to stop model work | Call `turn.interrupt()` and await `turn/completed`. Aborting a local request or breaking the event loop alone is not a server-side stop. |
| Connection closes / timeout after submitting a turn | Inspect persisted state with `threadRead({ threadId, includeTurns: true })` after reconnect/resume. A timeout does not prove the operation was never accepted; do not blindly replay a mutating request. |
| Resume cannot find a thread | Verify the thread ID and original home. Ephemeral threads and cleaned mock homes cannot be recovered. |
| Strict protocol validation fails with a custom `codexPath` | Restore the pinned runtime; compare [verified versions](../COMPATIBILITY.md). Disabling validation does not establish compatibility. |

For application diagnostics, capture `client.onError(...)`, the terminal turn status/error, and a
redacted `client.stderrTail`. Avoid logging credentials, raw auth payloads, or private prompt data.
