# Official example alignment

Groups 01–15 follow the public [Python app-server SDK examples at Codex 0.153.4](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/sdk/python/examples),
the original example-alignment baseline. This checkout now runs those examples on Codex `0.154.0`.
Group 16 follows the newer public Python
SDK [ExternalMessage change](https://github.com/openai/codex/commit/1a4096e273e80da30947e57fdfa45be92858ca91),
using protocol fields already present in that runtime. These are independently written Node.js
equivalents of those workflows, not a Python API port or a separate consumer application.

These examples are included in **client `0.2.0`**; check exact registry availability before installing.
The immutable npm `0.1.0` archive contains the three earlier safety examples, not these 16 numbered
files or the high-level `ExternalMessage` API. A verified local candidate also includes them;
do not expect a reinstall of `0.1.0` to add them.

## Mapping and observable checks

Official directory names match the numbered Node filenames below. Python's `async.py` is the
reference except group 09, which has only `sync.py`. Node uses promises/async iterators throughout;
adding a blocking Python-style API is not required to demonstrate the same workflow.

| Official group / Node entry point | Demonstrated workflow and default check |
| --- | --- |
| [01_quickstart_constructor](../examples/01_quickstart_constructor.mjs) | Connect, initialization metadata, create thread, collect text/items/status |
| [02_turn_run](../examples/02_turn_run.mjs) | Explicit turn handle, matching IDs, collected result and usage snapshots |
| [03_turn_stream_events](../examples/03_turn_stream_events.mjs) | Started/delta/completed events, terminal status, completed-item text fallback |
| [04_models_and_metadata](../examples/04_models_and_metadata.mjs) | Server/platform metadata and paginated model listing |
| [05_existing_thread](../examples/05_existing_thread.mjs) | Resume the same persisted thread; next provider request retains prior input |
| [06_thread_lifecycle_and_controls](../examples/06_thread_lifecycle_and_controls.mjs) | Read/list/name/archive/unarchive/resume/fork/compact; assert IDs, history and completion |
| [07_image_and_text](../examples/07_image_and_text.mjs) | Generated PNG as a data URL plus text; provider receives an encoded image |
| [08_local_image_and_text](../examples/08_local_image_and_text.mjs) | Temporary PNG as local-image input; provider receives it and local file is cleaned up |
| [09_async_parity](../examples/09_async_parity.mjs) | Thread/turn/result workflow through Node's native async API, no duplicate sync API |
| [10_error_handling_and_retry](../examples/10_error_handling_and_retry.mjs) | Typed overload/RPC errors and bounded retry of a rejected start acknowledgement |
| [11_cli_mini_app](../examples/11_cli_mini_app.mjs) | A single-thread terminal loop, streamed replies/usage, blank lines, `/exit`, `/quit`, EOF |
| [12_turn_params_kitchen_sink](../examples/12_turn_params_kitchen_sink.mjs) | Structured output, personality and reasoning summary; validate JSON shape and outbound schema |
| [13_model_select_and_turn_params](../examples/13_model_select_and_turn_params.mjs) | Filter hidden/upgraded models, select advertised effort, run plain/structured turns with options |
| [14_turn_controls](../examples/14_turn_controls.mjs) | Steer an active held stream, then interrupt a separate turn and drain terminal events |
| [15_login_and_account](../examples/15_login_and_account.mjs) | Start/cancel/wait/read account through the real client and a scripted RPC server |
| [16_external_message](../examples/16_external_message.mjs) | Authorized user task followed by untrusted tool-level content; verify it never becomes a user/developer message |

## Deliberate boundaries

- Groups 01–14, 16 and the existing `stream`, `approvals`, `interrupt-resume` examples use the real
  bundled app-server with isolated temporary homes and a local scripted Responses provider.
  Successful model output is a fixture: this does not establish model quality, vision accuracy,
  account entitlement, or availability of a model on a real account.
- Group 15 defaults to a **scripted WebSocket RPC server**, not a real app-server or OAuth service.
  It exercises strict protocol validation, the public login handle and early completion buffering
  without reading credentials or starting authentication. Its `--live` mode starts and immediately
  cancels real OAuth in a separate temporary home; it does not open a browser or sign in, and is
  excluded from all automatic tests. Cancellation is not evidence of successful authentication.
- Group 10 injects one typed overload **before** submitting its mock turn. Only explicitly rejected
  start requests are retried, up to three attempts; result collection is outside the retry block.
  It does not retry unknown-outcome timeouts, accepted turns, auth failures or arbitrary errors.
- Group 13 mirrors the official lexical/advertised-upgrade heuristic, not a model-quality or cost
  ranking. It selects the highest advertised reasoning effort; the runtime may normalize that value
  for its provider wire protocol. `--live` can therefore be expensive. No hard-coded model entitlement
  or model-name ordering beyond the official example's heuristic is promised.
- `compact()` acknowledges scheduling. Group 06 additionally waits for `item/completed` with
  `contextCompaction`; it does not mistake the acknowledgement or the legacy `thread/compacted`
  notification name for completion on this runtime.
- With a live provider, a turn may finish before steering/interruption arrives. Group 14 exposes
  that race; default held-stream fixtures require steering to apply and interruption to complete.
  Approval handlers remain explicit declines, not unconditional permission grants.

`ExternalMessage` is a high-level SDK wrapper, **not a new `UserInput` variant**. It uses
`turn/start` with `input: []` and `toolOutput: { name, namespace, output }`, already generated in
`0.153.4`. The previous inference that this feature required a protocol upgrade was incorrect.
No runtime or generated-protocol upgrade was needed to add ExternalMessage. The separate `0.154.0`
baseline upgrade tracks other upstream protocol changes, not a new requirement for this feature.

The official minimum is CLI `0.151.0`; tool-output requests reject unknown/older reported versions
and prereleases of that minimum, even with Schema checks off. Actual external-message integration
was initially verified on `0.153.4` and is reverified on the bundled `0.154.0`. Text and structured function-output content retain tool
authority through restart/resume and runtime truncation. External messages cannot be mixed into
user-input lists, sent through `steer()`, or used as an approval grant. Python's `source` option is
the existing Node `turnTrigger` option; it is metadata, not authority, and is ignored on active-turn joins.

If a regular turn is active, `startTurn(new ExternalMessage(...))` can return another handle to the
same turn ID. Each handle has one independent consumer. Late joins receive completed-item/latest-usage
snapshots plus unread events; consumed transient deltas are released. A pending start retains events
until its reply arrives, even if the original handle already finished. Returning from one iterator
does not cancel another iterator or the server turn. Routing uses both thread and turn IDs so forked
history cannot cross streams when it reuses a historical turn ID. The regression suite covers these races, failure
fan-out, and cleanup; it does not claim that scripted model output proves prompt-injection resistance.

## Run and verify

From a built source checkout:

```bash
node examples/01_quickstart_constructor.mjs
node examples/11_cli_mini_app.mjs --interactive
node examples/15_login_and_account.mjs
node examples/16_external_message.mjs
pnpm examples:smoke
pnpm package:smoke
node scripts/package-smoke.mjs --pnpm
```

The suite runs all 19 files plus four piped CLI cases (exit, quit, EOF and empty input).
Installed-package verification copies the **shipped** examples into fresh npm/pnpm consumers and
checks their catalog, ESM/schema imports, strict declarations and runtime binary. Platform CI runs
the npm package suite on Linux/macOS/Windows, with an additional pnpm consumer on Linux.

No automatic check uses `--live`; the aggregate `pnpm examples:smoke` explicitly rejects all arguments.
Only individual example commands accept `--live`. In groups 01–14 and 16, it uses the selected existing Codex home and
working directory; lifecycle examples create/persist their own threads and the mini CLI can keep
running until you exit. Non-interactive mock runs have a 45-second per-example deadline; interactive
input and live turns have no imposed total deadline. The smoke runner bounds every child process,
including piped interactive cases, to 60 seconds. Review the example before opting in. See [commands and recovery](../examples/README.md)
for setup and the authentication/cleanup boundaries.
