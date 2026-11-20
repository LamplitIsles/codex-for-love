# Sources and provenance

This repository is an independently written client for public Codex interfaces.

## Normative public sources

- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [Open-source app-server implementation](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Open-source app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)
- [Official OpenAI Codex Python SDK](https://github.com/openai/codex/tree/main/sdk/python)
- [OpenAI Codex repository](https://github.com/openai/codex)

## Pinned protocol provenance

- CLI package: `@openai/codex@0.170.0`
- Open-source tag: `rust-v0.170.0`
- Open-source commit: `29eb79e9866b3262a777fdf8195c1b9e63684c91`
- Method-map source: `codex-rs/app-server-protocol/src/protocol/common.rs`

The CLI generates `src/generated/protocol/` and `schemas/`. A deterministic post-generation
normalization changes Rust 64-bit integer TypeScript fields from `bigint` to `number | bigint`,
matching the lossless JSONL runtime representation. The public Rust `client_request_definitions!`
and `server_request_definitions!` tables supply method-to-response associations recorded in
`protocol-methods.json`. Generation verifies that these tables exactly match the CLI-generated
request unions and that every response type exists.

Runtime validation compiles the pinned aggregate Schema plus generated standalone server-response
Schema. Unknown method names remain forward-compatible. The generator records the three deprecated
client responses for which the upstream CLI exports TypeScript but no JSON Schema, so that boundary
cannot silently regress into a claim of complete runtime coverage.

The prior 0.154.0 schema required a `namespaceTools` capability that the
native 0.164.0 response omitted. The 0.170.0 schema declares only
`imageGeneration` and `webSearch`; the historical override was removed.
CFL's isolated native 0.170.0 loopback and strict validation checks cover its
own usage, including the audio file ID and GCP request variants. They do not
claim compatibility with every protocol workflow.

The generated protocol bindings and Schema retain their OpenAI Codex attribution and Apache-2.0
licensing through `THIRD_PARTY_NOTICES.md` and the bundled license copy under
`THIRD_PARTY_LICENSES/`. The independent client implementation remains MIT-licensed.

The Python SDK is used as a behavioral reference for transport closure, request routing, early
notification buffering, interactive login handles, initialization, typed error mapping, overload
retry, per-thread start coordination, thread/turn handles, logical thread-goal routing, and result
collection. Its public local Responses-provider test pattern is also a normative reference for
no-usage end-to-end testing. The TypeScript implementation and Node test fixture are written
independently for Node streams, promises, and HTTP.

The numbered Node examples retain the 15 public Python example groups at `rust-v0.153.4` plus
the public [ExternalMessage and independent subscription change](https://github.com/openai/codex/commit/1a4096e273e80da30947e57fdfa45be92858ca91)
for group 16 and its high-level behavior. The existing `0.153.4` `turn/start.toolOutput` protocol
already preserved the tool-authority boundary; ExternalMessage itself did not require a
generated-protocol upgrade. The current examples are also verified against `0.154.0`.
See [the exact source, mapping and intentional differences](./docs/official-examples.md).
No claim of parity with newer upstream examples or Python's blocking API is implied.

## Explicit exclusions

The private Codex Desktop `AppServerConnection` implementation, code extracted from the Desktop `app.asar` bundle, private symbols, and private service behavior are not included in or used as implementation source for this repository.

Behavioral parity means parity within the public `codex app-server` protocol surface, not reproduction of private Desktop implementation details.
