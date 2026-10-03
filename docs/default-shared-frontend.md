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

## Approved artifact

App source HEAD: `d1e800e72807d52ea14eed59d13a3cef6a43fd09`.

| Artifact | SHA256 | Files |
| --- | --- | ---: |
| Full archive | `eef50394bba2452f6daf1a8a052db3a35e68ed049bab480616602496aaca227e` | — |
| Browser manifest | `8e83a3f3f69e79b9a8e169432190863b7f890270ac580a200cbb1c9ac8571d68` | 265 |
| Contracts manifest | `5964aecc3c1caa3a0d4c8dd5532fe287ce08d564199796be81563b46d9d9a022` | 24 |
| Acceptance manifest | `25f667fd6def71c2cb7f788dc02350027dc9b6a404fbc1fbe826b2555b673bb3` | 25 |

Extract into a new test-owned scratch directory; verify archive, SOURCE_HEAD,
manifest hashes and every listed file before and after acceptance. Follow the
complete archived `acceptance/docs/default-shared-frontend.md` control handoff.
The Owner corrected the initial lockfile instruction: the archive intentionally
contains no dependency locks. Run `bun install` first in `contracts/package`,
then in `acceptance`; generated locks/node_modules belong only to the extraction.
Record their hashes and installed versions without modifying manifested files.
The existing contracts dependency is byte-identical to this archived package.

The Owner-approved voice replacement is `voice-browser-eca3279.mjs`, from App
HEAD `eca32794e90ba4f00c1895e3fc2125da57b3d973`, SHA256
`0eed2c7c66929cc8b5e86e55a010fda49d14a293dc3860fda8a0e0e0e1628fc0`.
Copy it beside the original runner in the extraction; never overwrite parent
manifested files. Verify its hash before/after and run this version for voice.
It targets cancellation by accessible action name while retaining native idle
image capability and every PCM/cancellation/draft assertion. Other runners and
all browser/contracts bytes remain the parent artifact.

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

Use `browser`, `voice-browser-eca3279`, `images-browser`, `compact-browser` or
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
