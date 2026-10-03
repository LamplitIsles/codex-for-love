# Default shared frontend: build and isolated acceptance

CFL serves the shared Framework7 App at `/`. `/chat` serves identical HTML with
root-relative assets. Missing assets, `/slice` and management routes return 404.
The host keeps its existing native API, socket/media/voice authorization and
same-origin checks. Platform independently owns hosted auth, manifest, service
worker and management. Companion MCP configuration and execution ownership stay
unchanged. No migration, alias, old UI fallback or asset override is supported.

## Build and package

Use Node 24 and pnpm 11.22.0 from the repository root, in this order:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

The build verifies/copies the approved browser from
`vendor/lamplit-default-shared-frontend.tgz` into `apps/partner/build`.
It does not rebuild App or require an adjacent checkout. Existing main-package
preparation copies that directory to the packed CLI's `vendor/build`, bundles
runtime/MCP and retains App/CFL/SDK/font licenses and attribution. Native package
pins and engines are unchanged. To verify a local package without publication:

```sh
mkdir -p .scratch/default-shared-frontend/package-artifacts
pnpm release:prepare "$PWD/.scratch/default-shared-frontend/package-artifacts"
pnpm release:check
node scripts/packaged-frontend-smoke.mjs \
  .scratch/default-shared-frontend/package-artifacts/lamplitisles-codex-for-love-0.1.0-beta.0.tgz \
  .scratch/default-shared-frontend/frozen
```

The last command starts extracted packaged runtime with a fake official app-server
and test-owned TOML/workspace/Codex home. It verifies every served browser file,
root/hosted identity, canonical 404s and native session construction. It installs
only the declared Sharp JS dependency into a temporary directory. It does not
install or invoke a real native engine or claim native-package release validation.
Owner release/deploy workflows remain in the operator guide and
[development environments](development-environments.md); merging does not deploy.

## Current pinned artifact

App source HEAD: `bc93ad34ff89c495741b375021d2071fe76f13db`.

| Artifact | SHA256 | Files |
| --- | --- | ---: |
| Full archive | `7e472c0b9d8c79321f5457557f7667f05de22ad569e33b98ee629e113c094264` | — |
| Browser manifest | `d0e3a6af976fa1dd96939a8535ee0b57b62f5e0efce8f79f50a29ec3841e747d` | 265 |
| Contracts manifest | `786eec82bbe6678d71c186a548e738705be4d9f2f8b5d90b0f8d0f5a67865fff` | 26 |
| Acceptance manifest | `5d7d92134ec2a9415b492acfc533d5ae120374040d138b9630af9fc7d8b3bed1` | 25 |

Extract into a new test-owned scratch directory; verify archive, SOURCE_HEAD,
manifest hashes and every listed file before and after acceptance. Follow the
complete archived `acceptance/docs/default-shared-frontend.md` control handoff.
The Owner corrected the initial lockfile instruction: the archive intentionally
contains no dependency locks. Run `bun install` first in `contracts/package`,
then in `acceptance`; generated locks/node_modules belong only to the extraction.
Record their hashes and installed versions without modifying manifested files.
The existing contracts dependency is byte-identical to this archived package.

The current archive includes the corrected voice runner and the appearance/quiet
completion browser assertions. Run the archived runners directly; no runner
replacement is required. Older #3164 acceptance evidence retains its original
immutable d1e800e archive and separate voice runner in local scratch.

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

From extracted `acceptance/`, with absolute evidence paths and printed URLs:

```sh
APP_ACCEPTANCE_URL=<origin>/ \
APP_ACCEPTANCE_CONTROL_URL=<control-url> \
APP_ACCEPTANCE_EVIDENCE=<evidence>/<suite> \
APP_ACCEPTANCE_INTERVAL_SECONDS=300 bun <runner>.mjs
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
voice replacement with native image intake enabled. The local implementation report
records acceptance with logs, screenshots at 390/1280, extra image/compact 320 probes and
before/after manifests. This does not claim actual platform gateway or PWA
acceptance, physical-device keyboard/safe-area/install behavior, real providers,
production state, or NUC verification. Those remain Owner joint live/device work
after review. Workers do not merge, publish, deploy, restart or reconfigure live
services. The standalone App does not register a service worker.
