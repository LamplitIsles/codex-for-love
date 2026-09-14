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
shape and short tagged-passage speech contracts from
`packages/dsh-speech/src/gateway.ts` and `constants.ts` at `29ed11a`.
CFL owns its TOML credentials, same-origin MP3 cache and HTTP routes. No DSH
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

The runtime targets the installed official Codex CLI/app-server `0.154.0`
over SDK-managed JSONL stdio through the pinned
`@jaminzhou/codex-app-server-client@0.2.1`. The SDK supplies typed protocol
bindings, strict boundary validation and process/RPC lifecycle management; the
configured `codex.command` remains the selected executable at runtime. The
SDK's bundled `@openai/codex@0.154.0` dependency establishes the protocol
baseline and is not silently selected in place of the configured executable.
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

The selected MCP configuration is intentionally limited to `web` (`web mcp
--provider kepos-bridge`), `project` (`project mcp`), `flicknote` (`flicknote
mcp`) and `guion-email` (`https://mail.guion.io/mcp`). The project-local Codex
overlay disables the known unselected `og`, `skill` and
`openaiDeveloperDocs` entries without changing the operator's global Codex
configuration.

## Notices

The imported LamplitIsles source described above is Apache-2.0; the repository
root [`LICENSE`](../LICENSE) supplies its terms.

Noto Sans SC is supplied through `@fontsource/noto-sans-sc` under SIL Open Font
License 1.1. The package's upstream notice remains in its installed package
metadata; release packaging must carry the corresponding font notice if this
app is bundled.

No obsolete nanocodex package artifacts, source checkout, or release claim is
part of the current application. The old artifact-preparation script was
removed with that runtime.

## Maintained Codex patches

`patches/0001-local-compaction.patch` and
`patches/0002-neutral-summary-prefix.patch` modify OpenAI Codex 0.154.0,
revision `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`, from
<https://github.com/openai/codex>. Codex is Apache-2.0 licensed; the build-owned
source retains its upstream license and notices. The patches add an explicit
local compaction override and replace the shared continuity summary prefix.
The repository stores patches and build scripts, not the upstream source tree
or compiled artifacts. The SDK remains pinned to 0.2.1 and protocol 0.154.0.
