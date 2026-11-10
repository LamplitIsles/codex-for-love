# Sources and provenance

This repository is an independently written client for public Codex interfaces.

## Normative public sources

- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [Open-source app-server implementation](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Open-source app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)
- [Official OpenAI Codex Python SDK](https://github.com/openai/codex/tree/main/sdk/python)
- [OpenAI Codex repository](https://github.com/openai/codex)

## Pinned protocol provenance

- CLI package: `@openai/codex@0.154.0`
- Open-source tag: `rust-v0.154.0`
- Open-source commit: `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`
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

The provider-capabilities response has one targeted wire-version allowance. At
[`0.154.0` commit `6b9826e3`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/model.rs),
`ModelProviderCapabilitiesReadResponse` declares `namespace_tools`, `image_generation`, and
`web_search` as required booleans. At
[`0.164.0` commit `6aaac694`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src/protocol/v2/model.rs),
it declares only the latter two, serialized with camelCase names. An isolated native `0.164.0`
capture returned exactly `{"id":2,"result":{"imageGeneration":true,"webSearch":true}}`.
The generator's existing optional-field maps therefore make `namespaceTools` optional in public
TypeScript and effective runtime validation, retaining its boolean constraint when present.
As with the existing compatibility allowances, raw per-method and aggregate CLI schemas retain
the pinned upstream shape; `schemas/runtime-validation.schemas.json` records the override applied
to the aggregate by the SDK validator. Both remaining booleans stay required. This verifies one
response contract, not general `0.164.0` compatibility; the generator and method map stay pinned.

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
