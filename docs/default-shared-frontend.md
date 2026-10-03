# Default shared frontend: build and isolated acceptance

CFL serves the shared Framework7 App at `/`. `/chat` serves identical HTML with
root-relative assets. Missing assets, `/slice` and management routes return 404.
The host keeps its existing native API, socket/media/voice authorization and
same-origin checks. Platform independently owns hosted auth, manifest, service
worker and management. Companion MCP configuration and execution ownership stay
unchanged. No migration, alias, old UI fallback or asset override is supported.

## Source preparation and complete artifacts

Keep `codex-for-love/` and `lamplit-app/` adjacent. CFL uses Node 24 and pinned
pnpm; App uses Bun 1.3.14. `lamplit-app.sha` contains one full commit SHA.
Public `https://github.com/LamplitIsles/lamplit-app` serves the initial recorded
commit and tree matching registered Forgejo source. CI uses that public repository
and exact SHA, without additional credentials. Future pin changes must also be
reachable there; following latest main is not the formal source contract.

```sh
pnpm source:prepare
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

Preparation runs App frozen install, existing Paraglide generation, check, build
and test. It materializes browser and compiled public package exports into
ignored `.generated/shared-app`. CFL has no local browser source, translation
catalogs or browser compiler. `pnpm check` uses TypeScript for the remaining
runtime and native test fixtures. That contracts package is a declared pnpm
workspace dependency with its own domain dependencies; frozen CFL installation
requires preparation first. No dependency version/lock rewriting is needed in CI.
The normal build verifies prepared hashes and source identity before copying
resources into `apps/partner/build`. Preparation also copies App’s LICENSE,
IMPORTS and the upstream Noto Sans SC OFL from App’s frozen installed font
dependency; their hashes are verified alongside browser and contracts resources.
Source edits after preparation require
preparing again. Local App edits are allowed and recorded, including a dirty
marker/diff fingerprint; local candidates are not formal deployment artifacts.

For CI and deployment, use `pnpm source:prepare --strict`: source must be clean
at the recorded pin. Keep it clean through build and packaging. To update the
pin, review the new App commit, change `lamplit-app.sha`, prepare, and run the same
frozen sequence. Dependency changes may require a deliberate pnpm lock update in
the PR, never an ad hoc frozen-install fix in CI.

```sh
mkdir -p .scratch/sha-pinned-shared-frontend/artifacts
pnpm release:prepare "$PWD/.scratch/sha-pinned-shared-frontend/artifacts" --strict
pnpm release:check
node scripts/packaged-frontend-smoke.mjs \
  .scratch/sha-pinned-shared-frontend/artifacts/lamplitisles-codex-for-love-0.1.0-beta.0.tgz
```

Packaging verifies the current build rather than rebuilding it. It includes
browser resources, runtime/MCP/public contracts bundled with CFL’s explicit
Rolldown dependency, helper, licenses and
`vendor/source.json` (actual App/CFL identity, pin and browser/contracts/prepared-license hashes). Runtime
requires only its declared installed Sharp dependency and supported native package;
it does not require either source checkout. The fake-engine smoke extracts to a
test-owned location, installs only Sharp there, verifies every served browser
file, root/chat identity, canonical 404s and native session construction.

`check.yml` runs source preparation and the frozen CFL sequence, then complete
artifact/package smoke without publication. The optional tag publication workflow
uses the same preparation and retains reviewed-main/tag, native pin, npm environment
and OIDC guards. Local execution is not evidence of hosted Actions success.

## Native source acceptance

Browser runners and UI-only assertions live in App; obsolete CFL browser-copy
runners have been removed. CFL retains the native acceptance hosts and native
unit/integration tests. Use the unchanged App runners from `lamplit-app/tests/`,
with its frozen
installed dependencies, and `apps/partner/build` produced above. The existing
native hosts below use a fake official engine and test-owned state. Record source
identities and resource hashes around acceptance; never use real conversations,
providers or installed service state as fixtures.

## Actual native fixtures

From the repository root, start a fixture using the extracted `browser` directory:

```sh
node apps/partner/tests/text-voice-acceptance-host.ts <browser>
node apps/partner/tests/panels-acceptance-host.ts <browser> <evidence>
IMAGE_FIXTURE_EVIDENCE=<evidence> \
  node apps/partner/tests/image-send-recovery-fixture.ts <browser>
COMPACT_FIXTURE_EVIDENCE=<evidence> \
  node apps/partner/tests/quiet-compaction-fixture.ts <browser>
CFL_ACCEPTANCE_FLICKLOG_SOURCE=<unchanged-flicklog-checkout>/src/cli.ts \
CFL_ACCEPTANCE_MEILISEARCH_BIN=<test-owned-meilisearch-binary> \
  node apps/partner/tests/conversation-search-acceptance-host.ts <browser> <evidence>
```

Each host prints its origin/control URL; stop it after its suite to remove only
its temporary state. Text/voice share one host: run them sequentially because
reset replaces fixture state. Every public request reaches actual Node/Partner,
Chord, native storage and adapters. Controls only seed/reset fixture data,
observe transport, configure fake execution/speech, or delay/fail delivery.
Search uses the unchanged FlickLog CLI and real test-owned Meilisearch index,
never the unit-test fake matcher. Supply a downloaded test-owned binary; do not
invoke an installed service executable or FlickLog setup. The fixture binds a
fresh loopback port and gives Meilisearch a synthetic key, private DB path and
isolated environment. Native matching/context semantics remain unchanged.

From adjacent `lamplit-app/`, with absolute evidence paths and printed URLs:

```sh
APP_ACCEPTANCE_URL=<origin>/ \
APP_ACCEPTANCE_CONTROL_URL=<control-url> \
APP_ACCEPTANCE_EVIDENCE=<evidence>/<suite> \
APP_ACCEPTANCE_INTERVAL_SECONDS=300 bun tests/<runner>.mjs
```

Use `browser`, `voice-browser`, `images-browser`, `compact-browser` or
`search-browser` with the corresponding control URL. Text/voice control URLs end
in `/__test/text` and `/__test/voice`. Panels uses `panels-browser.mjs` with no
control URL and CFL's native five-minute interval (`300`). The additional isolated
lifecycle check is `bun route-lifecycle-browser.mjs`.

Text tests completed reply, offline/reconnect, reload, stop, explicit pending-send
retry without duplicate execution, links/menus and preferences. Voice checks real
browser AudioWorklet PCM/capture resources through the authenticated native relay.
Panels/images verify actual metadata/media bytes and native membership; compaction
keeps successful manual/automatic completion quiet. Search checks native indexing,
Chinese/English hits, summaries, distinct repeated records/context, safe text,
failure/retry and stale response isolation. No browser public-result stubs or
mock native backend are used. Image delivery-delay probes fetch genuine native
responses and wait for route teardown; the isolated lifecycle test is separate.

## Verification boundary

All six native suites passed at 390/1280 under spec #3164, including the approved
voice replacement with native image intake enabled. The historical local implementation report
records acceptance with logs, screenshots at 390/1280, extra image/compact 320 probes and
before/after manifests. This does not claim actual platform gateway or PWA
acceptance, physical-device keyboard/safe-area/install behavior, real providers,
production state, or NUC verification. Those remain Owner joint live/device work
after review. Workers do not merge, publish, deploy, restart or reconfigure live
services. The standalone App does not register a service worker.
