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
markdown rendering, locale, image drafts, voice input,
relationship-history view and pure continuity/media/domain definitions. The
DSH controller and view-registry integration were removed; the page now binds
the projection to this repository's HTTP/SSE host.
The Keet message header in the Companion component
adapt `LamplitIsles/lamplit-cloudflare`'s `frontend/src/lib/companion/client/`
presentation at revision `2381cfc3e916130beb14c95c1078bd6c2479b1f3`.

Framework7 and framework7-svelte 9.2.0 (MIT, framework7io/framework7) now own
UI components, theme tokens, routing, Page/Messages/Message, Messagebar and its
attachment components, Photo Browser/Swiper and Virtual List. Message grouping
follows the official Svelte Messages demo using first/last/tail props. Message
timestamps use the official footer outside the bubble; pending status uses textFooter. CFL adapts
the 9.2.0 Svelte Input event to the detail-array shape required by Messagebar;
textarea resizing and page padding remain Framework7 capabilities. The previous SvelteKit and imported daisyUI themes are removed.
The Vite/Svelte application entry follows the Framework7 CLI 9.0.2 Svelte
starter's mount pattern without running its generator over this repository.
`@capacitor-community/media` 9.1.0 (MIT) supplies native album saving. Framework7
Touch taphold and Actions own long-press recognition and target-anchored action
popovers on mobile and desktop;
CFL wires message operations, mouse-only holds and desktop context menus, reading-focus handling and
a stationary-multitouch guard for Framework7 9.2 taphold. Official
`@capacitor/clipboard` 8.0.1 (MIT) supplies system clipboard writes in the native
shell.

The Companion typing indicator retains Framework7 Message markup. Its dot geometry
and motion are adapted from the original daisyUI 5.7.37 `loading-dots` /
`loading-sm` (MIT, saadeghi/daisyui): 20px indicator, 5px solid dots, 5px upward
travel, 1.05s cycle and 100ms stagger. The behavior is expressed as local CSS;
the daisyUI dependency and themes are not restored. Reduced motion stops the dots.

The optional TOML-configured portrait/landscape chat background, its theme-aware
overlay and keyboard-stable composition selection are original CFL additions
to the imported Companion surface. No background artwork is bundled.

The application-owned relationship validation/domain behavior is retained and
the runtime persistence is implemented in `apps/partner/runtime/store.ts`.
The store contains UI/domain metadata only. It is not an imported model
history journal.

The compact/expanded composer interaction follows the owner-supplied Penpot
`Composer` design package dated 2026-10-02. The full old Composer/attachment mockup, including its 96px mandate, is
superseded by the native Framework7 baseline at CFL HEAD
`63616953a28158e2224aca633b639c5b27123d28` for quiet compaction (#3121).
The retained layout uses Framework7 tokens and Lucide controls; no exported design PNGs are bundled.

The drawer spacing and automatic-wake list presentation follow the owner-supplied
Penpot “新版 · 自动唤醒” designs and `LamplitIsles/lamplit-chat`
`frontend/src/lib/companion/client/WakeDrawer.svelte` / `companion.css` at
`cc91634ae3c164f4faf9233095e175a9c3c20375` (Apache-2.0). CFL retains its existing
alarm data contract and uses Framework7 List and Accordion rather than importing
the wake component or its runtime. No Penpot exports are bundled.

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

The runtime targets Codex app-server `0.159.1` over SDK-managed JSONL stdio
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
`@lamplitisles/codex-for-love-linux-x64@0.6.0` contains the Codex 0.159.1
app-server from LamplitIsles Codex fork revision
`880185c212186edc3211c02eb36c7dd7584917f7` and the matching official
Linux x64 code-mode host.
The main package's exact optional-dependency version is the only native-package
selection contract.

The macOS ARM64 package
`@lamplitisles/codex-for-love-darwin-arm64@0.6.0` contains the Codex 0.159.1
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

## Desktop installation and mobile keyboard reference

The desktop installation manifest, heart/code icons and browser file capture
are original CFL work. Native mobile camera capture uses
the official Capacitor Camera plugin. Reading actions release editable focus;
keyboard dismissal follows browser/WebView focus behavior without a Keyboard
plugin. Native Android navigation
uses Capacitor App 8.1.1 (MIT); system icon appearance uses the built-in
Capacitor 8 SystemBars API, without an additional status-bar dependency. Camera media converts into
the same File intake used by browser uploads. Keyboard layout was informed by Ahmad Shadeed's
[VirtualKeyboard article](https://ishadeed.com/article/virtual-keyboard-api/)
(FlickNote #2971), especially the CSS keyboard-height chat grid, and the
[W3C VirtualKeyboard specification](https://www.w3.org/TR/virtual-keyboard/).
No article/demo source or artwork was copied; existing upstream licenses remain.

## Shared chat contract

The new `runtime/chat.ts` adapter is original CFL integration code. It consumes
`@lamplit/contracts` from the Apache-2.0 `LamplitIsles/lamplit-app` repository.
That package uses Chord 1.0.0 for RPC and replicated presentation state and
TypeBox for runtime validation. It does not import private frontend source.
The shared frontend imports the Framework7 Companion presentation from this
repository at `17a786271f5498bf5a188f421e9ce02adf7262f9`; attribution lives in
`lamplit-app/docs/IMPORTS.md`. The existing frontend and native execution owner
remain in place during this development slice.

### Shared streaming voice relay

`apps/partner/runtime/voice.ts` adapts the bounded Qwen streaming relay from
Apache-2.0 `LamplitIsles/lamplit-chat/src/server/voice.ts` at
`0f1ad1e28b6de5b86fef1cfcb401515625e603f9`. Node `ws` supplies server-side
authorization and connection teardown in place of workerd's WebSocket transport.
The relay consumes the compiled public `@lamplit/contracts/voice` constants,
validators and types from `LamplitIsles/lamplit-app` at
`f56f1259c2af71e3c59f7cd644b2721ffd8c63a6`. It does not import private frontend
definitions. Provider sentence ordering/replacement and final-only behavior follow
the Lamplit implementation; no audio or transcript store is added.

### Shared companion panels

The six public panel reads and reminder message source consume the compiled
Apache-2.0 `@lamplit/contracts` package from `LamplitIsles/lamplit-app` reviewed
source `0075e3c0887a30a6b19f63852ab20c103f13c79e`. CFL keeps the existing portable
sibling-package dependency and imports only public package exports. Adapter,
cursor and filesystem wiring are original CFL work. `tests/panels-seed.ts`
reproduces the state, reasons, dates, filenames and original PNG bytes of that
app's `tests/panels-fixture.ts` for isolated native acceptance; native image
membership/origins and alarm schedules follow CFL's own stores. Upstream
Apache-2.0 licenses and notices remain unchanged.

### Reviewed image/recovery contract artifact

The earlier image/recovery contract was the unmodified compiled Apache-2.0
`@lamplit/contracts` package from `LamplitIsles/lamplit-app` HEAD
`ebde803fb955349c8bd05de259f13ca14b63f668` (spec #3096, reviewed handoff).
SHA256: `9d2bb7d559f064a35c5ed93a4ac265ecc6ff128b2fa70950cf701d44f5c8c737`.
The archive retains its upstream LICENSE and compiled public schemas, image HTTP
handler, WS host and voice protocol. No private app source or browser build is
copied into product source. The reviewed browser and acceptance archives are
extracted only into test-owned scratch for acceptance. CFL image staging,
projection, recovery binding and native test controls are original integration
work; existing native materialization and app-server execution remain the owners.
The Owner-approved review2 acceptance runner is from app source HEAD
`091c0def66abdb45728906785e6defd55c60d50c`; browser/contracts retain the product HEAD above.


### Reviewed quiet-compaction contract artifact

`vendor/lamplit-contracts-compact.tgz` replaces the earlier image contract with
the unchanged compiled Apache-2.0 `@lamplit/contracts` archive from reviewed
App #3119 HEAD `95f0f06fc00fd4e7fa3e664ca2b1fe12fe8d10b8`.
SHA256: `b695d821ce5a86d044be3fbc08c83562dcb5f079d10c226771e2bfa669cc55b5`.
Upstream LICENSE, TypeBox schemas, Chord host, image and voice protocols remain
in the archive. The same handoff browser and common compact/images/panels runner
bytes are extracted only into ignored test-owned scratch. CFL's Node native
adapter and fake official app-server controls are original integration work.
