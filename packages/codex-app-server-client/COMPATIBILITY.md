# Compatibility and upgrades

**Client `0.2.1` bundles `@openai/codex@0.154.0`.** Its bindings and runtime
validation schemas are generated together. The immutable npm `0.1.0` and `0.1.0-preview.0`
archives still bundle `0.153.4`; reinstalling them does not apply this upgrade. Check the registry for exact-version
availability; this document is also included in local candidates. The client version and runtime version
are separate; installing a newer global CLI does not update the client's bundled runtime.

The public [app-server protocol](https://learn.chatgpt.com/docs/app-server) evolves, and its generated
experimental fields are version-sensitive. Keep both the client and your lockfile pinned. Neither
raw method coverage nor a successful basic smoke means all workflows work on an arbitrary version.

## What has actually been verified?

| Scope | Versions / environment | Evidence |
| --- | --- | --- |
| Basic initialization, thread and goal access | Exact runtimes `0.150.1`, `0.152.1`, `0.153.4`, `0.154.0` | Real isolated stdio compatibility smoke; no model calls |
| Streaming, explicit command decline, interruption and process-restart resume | Bundled `0.154.0` | Shipped examples run against the real runtime with a local mock provider |
| Official example workflows, groups 01–14 | Client `0.2.1`, bundled `0.154.0` | Real-runtime local-provider suite; [mapping and boundaries](./docs/official-examples.md), not model-quality acceptance |
| Official login/account example, group 15 | Client `0.2.1` | Strict client + scripted RPC fixture; not real OAuth or successful sign-in |
| ExternalMessage, group 16, and independent joined-turn consumers | Client `0.2.1`, bundled `0.154.0` | Real-runtime tool authority, restart/resume, active join, structured content and truncation; deterministic subscription races |
| `modelProvider/capabilities/read` response shape | Captured native `0.164.0` response and historical `0.154.0` shape | Strict validator and fake-server regression; `namespaceTools` may be absent, both other booleans remain required; not full `0.164.0` support |
| Packed ESM, declarations, schemas, and bundled binary | Node.js 18 on Linux, macOS, Windows | Installed-package CI; not every OS/architecture pairing |
| Published `0.1.0-preview.0` archive without consumer build scripts | npm and pnpm 11 consumers | Historical exact-archive verification; not evidence for new candidate bytes |
| Live account entitlement, model quality, every protocol workflow | Not established by these tests | Requires separate application-specific acceptance |

For a `0.2.1` release candidate, use `pnpm release:pack` to verify the exact chosen bytes. Until a
successful run records the selected source commit and integrity in `artifacts/release-evidence.json`,
that candidate gate is pending. Check the current PR's validation report as well; this historical
coverage table and an unchecked release checklist are not a final-candidate attestation.
Preview-version checkouts use `pnpm preview:pack` and separate preview evidence.

External messages use `turn/start.toolOutput`, already present in the pinned generated protocol.
They are not `UserInput` variants and do not require a protocol upgrade from `0.153.4`. Like the
official Python SDK feature, tool-output requests require a reported CLI version >= `0.151.0`;
unknown versions and prereleases at the minimum are rejected. The basic `0.150.1` matrix check
does not promise this newer workflow. No private checkout-schema probe or user-text fallback is used.

## How to upgrade

For the client `0.1.0` → `0.2.0` transition, read the [API and behavior migration notes](./docs/api-diff-0.2.0.md).

Consumers should install an exact reviewed client version, retain their lockfile, and run their
own conversation/approval recovery checks. Let the package supply its pinned runtime. Use
`codexPath` only for a deliberate compatibility experiment; disabling validation does not prove
the new runtime compatible.

Maintainers update the exact runtime, lockfile, public-tag provenance, generated types/schemas and
compatibility matrix together, then run the required checks described in [CONTRIBUTING.md](./CONTRIBUTING.md).
The scheduled drift alarm means an upstream stable release differs; it does not by itself mean
the current client is broken. Candidate preparation and publication are covered by [RELEASING.md](./RELEASING.md).

The detailed tables below describe this pinned public baseline, not parity with private Codex
Desktop functionality.

## Normative baseline

| Reference | Pinned baseline | How it is used |
| --- | --- | --- |
| Public Codex CLI | `codex-cli 0.154.0` / `rust-v0.154.0` | Runtime binary and public app-server behavior |
| Generated app-server TypeScript | Generated from the pinned CLI | Request, response, notification, and server-request types |
| Generated JSON Schema | Generated from the pinned CLI | Shipped schema artifacts and drift checks |
| Official Python SDK | Public source at the same Codex tag | Lifecycle, routing, error, and high-level behavior reference |

No private Codex Desktop code is a normative source or part of this package.

The `0.154.0` upgrade adds typed raw `userVerification/status`, `/enroll`, `/delete` and `/verify`
calls and the MCP `openai/userVerification` request variant. These are experimental protocol
contracts, not a built-in biometric UI or an automatic approval path. Tests use scripted RPC
responses; they do not enroll credentials, show native verification prompts or verify signatures.
New thread, MCP, configuration and quota fields are optional when the Schema permits omission.
In particular, absent/null `ordinaryUsageAllowed` is unknown, not proof of restored account access.

## Transport coverage

| Transport | Client support | Verification | Upstream status |
| --- | --- | --- | --- |
| stdio JSONL | Complete | Real pinned CLI integration test | Supported and default |
| Unix control socket | Complete for attaching to an existing server | Real pinned CLI integration test using the WebSocket Upgrade over a Unix socket | Intended for local control-plane clients |
| TCP WebSocket | Implemented with bounded resources and transport safety checks | Fake-server protocol tests and real pinned CLI integration test | Experimental and unsupported upstream |
| off | Not applicable to a client | Not applicable | Disables the server transport |

TCP WebSocket support does not turn the upstream experimental listener into a production-supported
transport. For production local rich clients, prefer stdio or the Unix control socket.

## Public protocol coverage

| Capability | Status | Evidence or boundary |
| --- | --- | --- |
| Typed client requests | Complete at the raw `call()` layer | All 162 generated client methods are mapped to generated parameter and response types |
| Notifications | Complete routing surface | Generic and generated method-scoped handlers |
| Server requests | Complete routing surface | Generic and generated method-scoped handlers with typed responses |
| Initialization lifecycle | Complete | Exactly one `initialize`, followed by `initialized`, per connection |
| Concurrent requests | Complete | UUID request IDs and response correlation independent of arrival order |
| Ordered writes and notifications | Complete | Serialized outbound writes and transport-order notification dispatch |
| W3C trace context | Complete at the JSON-RPC envelope | Outbound and inbound `traceparent` / `tracestate` preservation |
| 64-bit JSON integers | Complete at the wire layer | Safe values use `number`; unsafe integer literals and error codes round-trip as `bigint`; lossy numeric request IDs/error codes and non-finite inputs are rejected |
| Cancellation and timeout | Complete at the client request layer | Abort signals and bounded request timeouts |
| Backpressure error classification | Complete for the documented ingress error | `-32001` `Server overloaded; retry later.` maps to `AppServerBusyError` |
| Overload retry helper | Complete and opt-in | Exponential backoff with jitter; only overload-classified failures retry |
| Experimental protocol | Generated and available | Enabled by the default initialize capability; it remains version-sensitive |
| Runtime protocol validation | Complete for every generated request/notification/server-request shape and 159 of 162 client responses | Strict by default, including Rust signed/unsigned integer widths; three deprecated response types have no upstream JSON Schema |

Unknown method names bypass known-method Schema validation and remain available through generic
handlers and raw requests. This is intentional forward compatibility, not a claim that an unknown
shape has been verified. `protocolValidation: "off"` is available for deliberate version-skew
experiments.

Provider-capabilities validation uses the existing generated compatibility override to accept
responses without `namespaceTools`, while checking it as a boolean when present. Public types
expose `namespaceTools?: boolean`; callers must handle absence. The raw CLI schemas remain at
the pinned baseline, with effective runtime allowances recorded separately; see the exact
[source provenance](./SOURCES.md). No capability value is fabricated.

## Cross-version verification

The scheduled compatibility smoke covers every exact stable release in
`compatibility-matrix.json`, currently `0.150.1`, `0.152.1`, `0.153.4`, and the pinned `0.154.0`. On the minimum
supported Node.js 18 runtime it installs each CLI in isolation, starts its real stdio app-server with plugins
disabled, uses strict current-Schema validation, and exercises initialization, model and thread
listing, thread creation/read, and thread-goal access without calling a model service. The matrix is an
explicit verified window, not a compatibility claim for arbitrary older or preview releases.

Regular CI also packs and installs this client on Linux, macOS, and Windows, then initializes the
platform-specific bundled Codex app-server on Node.js 18. This checks the three operating-system
artifact paths independently; it does not extend the compatibility window beyond the exact CLI
versions listed above.

## High-level API coverage

| Area | Current high-level coverage | Raw typed fallback |
| --- | --- | --- |
| Threads | start, resume, fork, list, read, archive, unarchive, name, compact | Complete `call()` surface |
| Turns | start, steer, interrupt, event stream, collected result | Complete `call()` surface; collected and manually streamed turns are exercised through the real pinned app-server against a local mock Responses provider |
| Thread goals | get, set, clear, logical continuation stream, collected result, pause | Complete `call()` surface |
| Approvals and other server requests | Explicit typed handler registration; no implicit approval | Complete handler surface; a real pinned app-server command request is declined end to end and verified not to execute |
| Models | list | Complete `call()` surface |
| Account and login flows | API key, browser, device code, auth tokens, completion wait/cancel, account read, logout | Complete `call()` surface |
| MCP, apps, plugins, skills, config, review, processes, and remote control | No area-specific wrappers yet | Complete `call()` surface |

High-level `turn/start` and logical goal starts are serialized per thread, matching the official
Python SDK's protection against competing starts. Different threads remain concurrent. Goal
continuations preserve original notifications for generic handlers while the goal handle receives a
normalized single-turn stream.

The real-turn integration test uses an isolated temporary `CODEX_HOME`, disables managed config,
sets retries to zero, and routes the model provider exclusively to a loopback HTTP server. It
asserts the outbound Responses request as well as real `turn/started`, agent-message delta,
`item/completed`, token-usage, and `turn/completed` notifications without authenticating or
consuming model usage. A second real-runtime scenario sends a public `shell_command` model item,
handles the resulting typed `item/commandExecution/requestApproval` server request, declines it,
and verifies the command item is completed as `declined` without executing the command.

## Remaining parity work

The following items are deliberately not claimed as complete:

- response validation for the three deprecated compatibility methods whose response Schema is not
  exported upstream (`getAuthStatus`, `getConversationSummary`, and `gitDiffToRemote`);
- broader high-level operation-scope coordination outside turn and goal starts;
- automatic reconnect, replay, or idempotency policy for a dropped remote connection;
- production support for TCP WebSocket while upstream continues to label it experimental and
  unsupported.

These gaps do not reduce the generated raw protocol surface, but they matter before describing the
entire package as behaviorally complete for every rich-client workflow.
