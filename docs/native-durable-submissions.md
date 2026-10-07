# Native durable submissions — CFL spec #3437

Codex remains the execution/history owner. CFL's public adapter implements App's
`lamplit.chat.v2`, view version 2 and `/api/chat/socket`; transport stays version 1.
Receipts are `{ operationId, state: submitted|failed, messageId, turnId, error }`.
Lookup returns a receipt or `null`, meaning no definitive result. There is no old
wire fallback, `ChatMessage.delivery`, or `InputRecovery.state`.

Validated input, images and immutable identity commit atomically before native
start/steer. That admission proves `submitted`; official user items are evidence
of consumption, not a prerequisite for submission success. A rolled-back admission
may durably record `failed` without creating timeline/album membership. If failure
recording itself cannot commit, the call raises and lookup remains unresolved.
Identity/ownership/replacement conflicts raise without rewriting any original
receipt. Same ID and full content return the original result without execution.

Native invalid-request rejection or confirmed pre-processing withdrawal may add
recoverable text/images while retaining the admitted `submitted` receipt. Internal
unresolved/reconciliation, consumed-input segments and native draft bookkeeping
remain intact; ambiguous errors or missing items never create public recovery.
Reply failure/stop publish independent notices. A deliberate edited replacement
uses a new UUID and atomically retires only eligible recovery sources. Original
bytes remain available through authenticated operation-owned staging/native media.

## Separate source packaging and frozen native acceptance

The approved App commit is `3aaa48a384549f72cc417a6cb3e6108fe0999b37` (App PR16).
Use the existing pipeline with a clean real-Git snapshot at that exact commit:

```sh
export CFL_APP_SOURCE=/absolute/test-owned/lamplit-app
export BUN_INSTALL_CACHE_DIR=/absolute/test-owned/bun-cache
pnpm source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm release:prepare /absolute/test-owned/artifacts --strict
pnpm release:check
node scripts/packaged-frontend-smoke.mjs /absolute/test-owned/artifacts/<package>.tgz
```

`CFL_APP_SOURCE` applies to preparation and verification. Default adjacent-source
behavior, exact pin/clean-source checks, resource/license manifests and CLI bundle
contracts remain unchanged. Record the real Git commit/tree and source-built
`source.json`/`vendor/source.json` hashes. Source-built bundle hashes can differ
from the frozen acceptance package; keep both identities separate.

Native acceptance consumes the immutable Orc-approved App archive, never freshly
rebuilt resources or the moving adjacent tree:

| Artifact | SHA256 | Files |
| --- | --- | ---: |
| Archive | `a921c9d47f041cf6978653c5af6cda5d65a28e6cde3ceb5e91b0ecb5a5c301d1` | — |
| Browser manifest | `c926f668688238298a7e83cb81bd092ce6d1443951559df02dc3e492cd0bc58a` | 265 |
| Contracts manifest | `9f3b08860aed9f215cedf66bb2628d4145b32827948b089c42daebc91cd731e3` | 26 |
| Acceptance manifest | `a9a69d563f2ca8d61fd03e210d14a72264c5f0282cf9ddf2ef7daef25f1bd42f` | 35 |
| Packaged submission runner | `9a2a91b0d952cd5c27a88c5fe734a64df9844528aa8ca9d440936a7ef6bce118` | 1 |

Extract to a test-owned location. Check SOURCE_HEAD and every manifest entry
relative to browser, contracts/package and acceptance, before and after install
and acceptance. Install contracts/package first, then acceptance, with a test-owned
Bun cache. Do not edit any App file, DTO, runner or manifest to accommodate CFL.

```sh
node apps/partner/tests/image-send-recovery-fixture.ts /absolute/frozen/browser
```

The host prints origin/control URLs and uses actual Partner admission, SQLite,
media and socket; the official engine is fake. Timing controls hold actual RPCs or
outgoing update frames without modifying payloads. The fixture seeds a real SQLite
rollback trigger for the approved rejection captions; failed receipts/recovery are
produced by the native admission handler. Withdrawal uses a definite fake native
invalid-request before consumption. Reply completion/failure and recovery
consumption use fake official engine commands through normal reconciliation.
No manufactured public DTOs or submission rows are inserted by controls.

From the immutable extracted acceptance directory:

```sh
APP_ACCEPTANCE_URL=<origin>/ \
APP_ACCEPTANCE_CONTROL_URL=<control-url> \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/submissions \
bun optimistic-send-browser.mjs
```

Run `images-browser.mjs` with the same host; use existing Keet, text/voice, panels,
compact and search native hosts for their affected surfaces. The control route is
test-only; the submission runner accepts the printed image-control URL. Recorded
CFL-native results establish CFL local evidence only. Orc owns actual cross-repo
joint acceptance and merge. No live state, credentials, providers, external sends,
service operations, deployment or native rebuild/release belongs to this fixture.
