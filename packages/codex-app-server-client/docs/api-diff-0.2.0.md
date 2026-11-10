# Migrating from 0.1.0 to 0.2.0

This comparison describes client `0.2.0`, not a publication-status announcement.
Baseline: the immutable npm `0.1.0` archive recorded in [its release record](./releases/0.1.0.md),
with source tree `6d55df1a3f894d408b602ba72d67ffafba3b980e` and Codex `0.153.4`.
The new client pins Codex `0.154.0`; client and runtime version numbers are independent.

## Public surface and behavior

| Surface | Change and migration impact |
| --- | --- |
| Package entry points and Node engines | Root ESM, `/protocol`, `/schemas/*` and installed Node 18+ remain; source builds still need Node 22+ and pnpm 11. Prefer maintained Node versions. |
| Root exports | Add `ExternalMessage`, `ExternalMessageOptions` and `CodexUserInput`; existing exported names remain. |
| Turn input | `CodexTurnInput` now also includes `ExternalMessage`. Existing strings and user-input objects/arrays remain accepted by start/run. `steer()` and `normalizeTurnInput()` accept only `CodexUserInput`; annotate user-only wrapper parameters with that narrower type. |
| External/tool-output input | Supply external content as the whole high-level turn input. High-level starts reject mixed user input or a second `toolOutput`. All `turn/start` tool-output calls, including raw calls and validation-off calls, require a reported runtime >= `0.151.0` and reject unknown versions or a prerelease of that minimum. |
| Joined-turn streams | Multiple returned handles for one active turn have independent consumers. Completed items, latest usage and unread events are replayed to joiners; already-consumed token deltas are not a full-history replay. Each handle still permits only one consumer. |
| Raw client methods | Add `userVerification/status`, `/enroll`, `/delete`, `/verify`; typed requests increase from 158 to 162 and validated responses from 155 to 159. The same three deprecated responses lack upstream Schema. |
| Rate limits | `account/rateLimits/read` still supports omitted params and now accepts capability options. Wire Schema also permits null through generic `request()`. Missing/null `ordinaryUsageAllowed` means unknown, not recovered account access. |
| Protocol unions | MCP elicitation adds `mode: "openai/userVerification"`; raw response items add `type: "configuration_update"`. Update exhaustive switches. An unsupported verification request must not become an automatic approval. |
| Optional metadata | New thread, MCP, quota and application-requirement fields remain optional where Schema permits omission; do not treat absence as a default or cleared state. New verification error int64 codes preserve `number \| bigint`. |
| Thread filters and metadata | Nonempty `thread/list.originators` is hosted-only and rejected by the local app-server. `daybreakEnabled` stores metadata and grants no access. |
| Review delivery | Upstream marks detached delivery deprecated; use a separate `thread/start` followed by inline review where needed. |
| Bundled runtime and defaults | `@openai/codex` changes from exact `0.153.4` to `0.154.0`. Default initialize client-info version becomes `0.2.0`; explicit client-info overrides remain supported. |
| Shipped examples | Three safety examples grow to 19 total: 18 real-runtime local-provider fixtures plus one scripted login RPC fixture, with four additional CLI input cases. |

No exported high-level name is removed, but this is not a blanket source/behavior compatibility
claim for every generated experimental type. In particular, a wrapper using the old broad turn
input type for steering should now use the explicitly user-only type:

```ts
import type { CodexTurn, CodexUserInput } from "@jaminzhou/codex-app-server-client";

function steerUser(turn: CodexTurn, input: CodexUserInput) {
  return turn.steer(input);
}
```

Do not convert `ExternalMessage` into user text to bypass the type or version guards. Its content
has tool authority and cannot grant command/file approvals. When new protocol variants are not
implemented by your application, handle them explicitly without granting permissions.

## Verification and limits

Compare the published baseline's packed `dist/index.d.ts`, `dist/protocol.d.ts`, declaration rollup,
package exports and engines with the new candidate. Re-run that comparison after any final-source
change; verify new exact candidate bytes with both npm and pnpm, not merely the source directory.
The source diff against `v0.1.0` also identifies lifecycle and protocol behavior changes above.

The basic runtime matrix covers `0.150.1`, `0.152.1`, `0.153.4`, `0.154.0`; rich examples use the
bundled `0.154.0`. Basic support for `0.150.1` does not promise ExternalMessage support.
Native verification tests check public contracts with fixtures, not biometrics, enrollment,
signature authenticity or real account eligibility. Prior live-account acceptance on `0.1.0`
does not certify changed `0.2.0` executable/runtime bytes. See [release gates](./releases/0.2.0.md#release-gates).
