# Imported sources

The Framework7/Svelte chat surface under `apps/web/src/lib/companion`, supporting
client helpers, styles, localization messages, icons and app bootstrap were copied
from `LamplitIsles/codex-for-love`, branch `feat/framework7-companion`, commit
`17a786271f5498bf5a188f421e9ce02adf7262f9` on 2026-10-02 through `ssh nuc-kep`.
The frontend was subsequently synchronized with local CFL `main`, commit
`1263eb20c9a73462ba0ad48ee068635b97af004d` (Framework7 merge #57 and UI fixes #60/#62).
This includes its palette, message links, anchored long-press menus, typing motion,
settings, search presentation, reminder drawer and timeline behavior. The shared
controller, capability gates and streaming voice lifecycle remain app adaptations;
CFL's engine-specific controller and backend alarm persistence were not imported.
The source is Apache-2.0; this repository retains the Apache-2.0 license.

The engine-specific `Partner.svelte` controller was replaced with a shared
completed-message controller. Framework7 components, composer behavior, viewport
handling, Markdown and localization remain derived from that source. First-slice
presentation hides capabilities that have not yet been connected. No runtime state,
credentials, conversations or uncommitted source changes were imported.

Framework7, Svelte, Capacitor, Noto Sans SC, KaTeX, lucide-svelte and other dependencies
retain their respective upstream licenses in package distributions. Chord and
TypeBox are dependencies, not vendored source. Passkey ceremonies use the
`@simplewebauthn/browser` package under its upstream MIT license; no library
source was copied into this repository.

The streaming `voice-input.ts` lifecycle and `voice-worklet.js` were adapted from
`LamplitIsles/lamplit-chat`, commit
`8d3723e892c705960039ea77cc2d745c29d9f133` (read-only adjacent checkout), paths
`frontend/src/lib/companion/client/voice-input.ts` and `voice-worklet.js`.
`tests/voice-worklet.test.ts` derives from its `src/companion/voice-worklet.test.ts`.
That source is Apache-2.0, covered by this repository's retained Apache-2.0 license.
The adaptation uses the shared public contracts and the existing Framework7
composer instead of the imported CFL batch MediaRecorder/transcription path.
No provider keys, recordings, transcripts or runtime state were imported.

The companion-panels adaptation connects the imported relationship history, diary,
gallery, reminder drawer and native image-saving flow to app-owned public RPC
actions. It removes CFL-only JSON reads and relation readiness as a chat gate,
retains the imported visual language, and fixes Framework7 browser download
routing and signed affinity changes. No new upstream source was imported; the
source commits and license above remain the attribution authority.

`apps/web/src/lib/photo-upload.ts` adapts the browser base64/canvas JPEG preparation
from local read-only `LamplitIsles/lamplit-chat`, commit
`2c4280f6d95daa455c85c61ada7b0fc8a48dd3a1`, path
`frontend/src/lib/companion/photo-upload.ts` (Apache-2.0). It preserves original
bytes and bounded 480px preview / 1200px model JPEG variants, replacing Pi-only
hardcoded limits/DTOs with the public host-advertised contract. No native source,
configuration, state or credentials were changed/imported.

The quiet-compaction slice restores attachment presentation against read-only
`LamplitIsles/codex-for-love` at `63616953a28158e2224aca633b639c5b27123d28`,
`apps/partner/src/lib/companion/client/Companion.svelte` and `companion.css`.
An isolated test-owned copy of the native component was used for rendered comparison
with synthetic images; no other CFL features or runtime state were imported.
The complete prior Composer redesign and 96px attachment mockup are superseded.
Existing Apache-2.0 source attribution and imported dependency licenses remain.

Keet source header and K-avatar markup reuse the existing CFL-derived
`Companion.svelte` above. The muted bubble/left accent and wrapping source-header
design intent were consulted read-only in `LamplitIsles/lamplit-cloudflare` at
`e556636f8298bf575fb73408bd6bb9b304413f8b`, path
`frontend/src/lib/companion/client/companion.css` (Apache-2.0). The implementation
adapts those rules to current Framework7 components and palette tokens rather
than importing its legacy rendering framework or backend DTO. Native label limits
were observed in `src/server/keet-feed.ts` at the same commit. The Keet frozen
artifact contains app-owned compiled browser/contracts, owned fixture runners,
locked dependency metadata and existing LICENSE files; dependency licenses remain
with their packages. No conversations, credentials, runtime state or native
backend implementation were imported.

Matrix source presentation (#3560) is an app-owned extension of the existing
CFL-derived Keet/Framework7 header, avatar and palette treatment. It adds no
upstream source, native backend implementation, state or credentials; the source
commits and Apache-2.0 attribution above remain authoritative. The complete frozen
Matrix handoff includes the owned runners/fixtures and existing license files.
