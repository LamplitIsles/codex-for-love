# Source and license provenance

This repository is an implementation destination copied from the
LamplitIsles Companion application. Imported or adapted source is identified
here so the runtime boundary stays clear; the official Codex app-server is an
external executable and is not vendored into this repository.

## Companion UI and domain

The Svelte Companion UI and its pure client/domain modules under
`apps/partner/src/lib/companion/` were imported from
`LamplitIsles/dsh-plugins` revision `29ed11a`, primarily
`packages/dsh-companion/src`. This includes the Companion presentation,
markdown rendering, themes, locale, image drafts, voice input,
relationship-history view and pure continuity/media/domain definitions. The
DSH controller and view-registry integration were removed; the page now binds
the projection to this repository's HTTP/SSE host.

The application-owned relationship validation/domain behavior is retained and
the runtime persistence is implemented in `apps/partner/runtime/store.ts`.
The store contains UI/domain metadata only. It is not an imported model
history journal.

## Prompt and speech

`apps/partner/runtime/prompts.ts` adapts the approved Companion base prompt and
continuity prompt artifact from
`packages/dsh-companion/src/prompt.ts` and `compaction.ts` at the same
`29ed11a` revision. The Owner maintains prompt semantics. The current host
assembles the base instructions with the configured persona; it does not send
the independent compaction prompt to remote-v2, whose official path uses base
instructions plus `CompactionTrigger`/history.

`apps/partner/runtime/speech.ts` adapts the Qwen3-ASR-Flash request/response
shape and retained Alibaba/ByteDance short-audio transport contracts from
`packages/dsh-speech/src/gateway.ts` and `constants.ts` at `29ed11a`.
CFL owns MiniMax CLI dispatch, TOML credential boundaries, same-origin MP3
cache and HTTP routes. No DSH
lifecycle, settings UI, connection RPC or external messaging integration is
imported.

## Retained small core

`apps/partner/runtime/tools/dice-core.ts` preserves the host-independent dice
core from `packages/dsh-tabletop/src/core.ts` at `29ed11a`. The three
relationship tools reuse the Companion domain contracts. The app exposes only
those three relationship operations plus `roll_dice` as dynamic tools.

Image input validation/materialization and the HTTP projection are adapted to
the native Codex app-server contract. The old custom image-generation
transport, mail wrapper, QuickJS adapter, skill CLI wrapper and duplicate basic
tool modules are not part of this runtime.

## DSH compacted-log import boundary

`apps/partner/runtime/dsh-session-import.ts` is original CFL integration code,
not a copied DSH runtime or a legacy reader. Its deliberately narrow parser is
derived from the released physical v0 and logical v3 serialized envelopes,
surface replacement metadata and compact checkpoint lifecycle documented by the read-only
`lamplitisles/deepseek-harness` checkout at revision
`5dda764ed3aa172535a7967b06ff95d9cbfe536a` (`packages/core/session`,
`packages/compaction/compaction`, `packages/compaction/compaction-basic` and
`packages/session/session-persistence-jsonl`). It admits only released physical
version 0 and logical version 3, validates and discards the three known packed
assistant chunk row types, folds the effective surface and correlates
`source.kind=plugin`/`source.plugin=compact` with its committed
start/summary/replacement/end lifecycle. No DSH source, session database,
credentials, transcript reader or migration framework is vendored here. The
adapter translates every visible user/assistant text record and every completed
compact boundary directly into the pinned native rollout projections. It
discards tool, reasoning, system and opaque records. Companion relationship
history is imported into CFL state, and source-session-referenced images are
verified, copied byte-for-byte into the workspace media library, and restored
on their original visible user messages. The compact replacement history stays
text-only, so these historical images are not active model inputs; no DSH
runtime or ongoing reader remains.

Released physical v0 assistant final-message `sourceEventSeqs` may cite earlier
packed chunk provenance. The adapter validates ordering and then discards that
provenance with the chunks; logical v3 keeps its separate final-message contract.

## External official runtime

The runtime targets Codex app-server `0.156.1` over SDK-managed JSONL stdio
through `@jaminzhou/codex-app-server-client` pinned to immutable source revision
`56ab11736036d6a5c3dd6e150498dec2d95b2bf5` of
`lamplitisles/codex-app-server-client`. The SDK supplies typed protocol
bindings, strict boundary validation and process/RPC lifecycle management. The
published CFL package vendors that pinned SDK revision and supplies an explicit
LamplitIsles standalone app-server binary, so end-user installation does not
clone the SDK or select its bundled official CLI fallback.
The runtime relies on the operator's existing official device-auth login for
model transport and uses official native tools, skill discovery, selected MCP
clients, history and compaction. The Companion does not use the official
durable queue APIs. No Codex source checkout, provider
token, Bridge model transport, OAuth parser, or compatibility adapter is
copied into this repository.

The SDK is independently authored by JaminZhou under the MIT License; its
generated protocol bindings and JSON Schema are derived from OpenAI Codex
`0.154.0` (`rust-v0.154.0`, commit
`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`) under Apache-2.0. The applicable
license copies are retained in
[`licenses/jaminzhou-codex-app-server-client-MIT.txt`](../licenses/jaminzhou-codex-app-server-client-MIT.txt)
and [`licenses/openai-codex-generated-Apache-2.0.txt`](../licenses/openai-codex-generated-Apache-2.0.txt).

CFL configures only its bundled Companion MCP and SessionStart hook. FlickNote
and Web are optional operator-provided MCPs documented in a static template;
CFL does not inject, disable, or require any external MCP configuration.

## Notices

The imported LamplitIsles source described above is Apache-2.0; the repository
root [`LICENSE`](../LICENSE) supplies its terms.

Noto Sans SC is supplied through `@fontsource/noto-sans-sc` under SIL Open Font
License 1.1. Release preparation copies its upstream `LICENSE` verbatim to
`vendor/licenses/NotoSansSC-OFL-1.1.txt` in the packed main package. The same
directory retains the SDK MIT and generated Codex Apache-2.0 license texts from
the repository's `licenses/` directory.

No obsolete nanocodex package artifacts, source checkout, or release claim is
part of the current application. The old artifact-preparation script was
removed with that runtime.

## Native release artifact

The Linux x64 native npm package
`@lamplitisles/codex-for-love-linux-x64@0.5.0` contains the Codex 0.156.1
app-server from LamplitIsles Codex fork revision
`7b9e86ff857c321d49372f8ecee02f0c3f6e863c` and the matching official
Linux x64 code-mode host.
The main package's exact optional-dependency version is the only native-package
selection contract.

The macOS ARM64 package
`@lamplitisles/codex-for-love-darwin-arm64@0.5.0` contains the Codex 0.156.1
app-server from the same fork revision and the matching official macOS ARM64
code-mode host. The package retains the same Codex Apache-2.0
license and upstream notice.

## npm publication workflow

`.github/workflows/publish.yml` and the narrow `scripts/release-*.mjs` helpers
adapt the OIDC publication sequence from `LamplitIsles/dsh-plugins`: strict
semver release authority, frozen Node/pnpm setup, immutable tarball comparison,
and provenance publication. CFL deliberately
uses one tag-authoritative main package rather than DSH's main-push change
detection and package matrix. It has no DSH runtime dependency, native Rust
build, GitHub Release, npm token fallback, or automatic native publication.
