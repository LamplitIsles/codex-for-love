# Shared image protocol and native acceptance

Spec #3098 integrates the reviewed app #3096 without replacing the native UI.
The official app-server remains the single execution/history owner. The native
Partner owns local staging, attachment identity and admission. No deployment,
Rust build, native release, external provider or production state is involved.

## Public contract

- `POST /api/chat/images`: JSON `{ sessionId, operationId, images }`; each ordered
  image has `id`, contiguous `order`, `name`, `mediaType`, and base64
  `original`, `preview`, `model`. The shared validator enforces signatures,
  strict encoding, unique IDs and a 36,000,000-byte streamed body ceiling.
  CFL additionally enforces five originals, 5 MiB each, 20 MiB total and native
  160-character filenames. Names cannot contain path separators/control characters.
- Result `{ sessionId, operationId, images: ImageRef[] }`; references have
  `attachmentId`, `name`, `mediaType`, `availability: available|missing`.
  Uploads are bound to this authenticated Partner's selected session/operation.
  Authentication is checked again inside serialized staging. Reusing an operation
  with changed image IDs, order, metadata or any variant bytes conflicts.
- WS `/api/chat/socket` submit: `{ operationId, text, images?, replacementSourceIds? }`.
  Empty text is allowed with images. Immutable identity includes reference order
  and replacements. Every supplied reference must match the whole staged operation.
  Originals are revalidated and re-hashed before admission. Uploads alone do not
  create messages, execution or album membership. Admission/replacement facts
  commit together in the existing native SQLite store before execution.
- `GET /api/chat/media/{attachmentId}/{original|preview|model}` authenticates each
  request. Native stored metadata or operation-owned staging determines ownership;
  opaque ID knowledge is insufficient. Originals retain a finite 32 MiB read bound,
  previews/models 160,000/320,000 bytes. Responses are `no-store` and `nosniff`;
  unavailable originals/variants return 404. Native/generated originals remain
  readable even when intake is disabled; no decoder dependency was added.
- History and album project verified native membership and provenance. User
  image-only messages and completed agent images have real media references;
  workspace inspection and staging never add album membership.

`view.recovery` has at most 20 `{ sourceId, operationId, text, images, state,
replacementEligible }` entries, including native-frontend inputs. Native history
is refreshed before projection and replacement validation. Durable invalid-request
rejection proves eligibility; generic internal errors and unresolved inputs remain
`uncertain` and ineligible. Receipt consumption uses actual native user items.
No absence of an item, turn completion or disconnect is converted to unconsumption.
Inspection never executes; same-operation retries reconcile before checking an
already-replaced source. A fresh edited resend cannot resurrect consumed/replaced
input. Native manual recovery remains available through its existing private routes.

## Reviewed artifacts

Consume the Owner-approved `artifacts-review2` handoff: browser/contracts retain
product HEAD `ebde803fb955349c8bd05de259f13ca14b63f668`; the runner is from
`091c0def66abdb45728906785e6defd55c60d50c`. Authoritative spec #3098 records
Owner approval; preserve the immutable identity JSON's original review label.

| Archive | SHA256 |
| --- | --- |
| Browser | `e5ebff9c7abdec06652673f51f5d6037dd2a59f99bb35a8e2226dcd451150f03` |
| Contracts | `9d2bb7d559f064a35c5ed93a4ac265ecc6ff128b2fa70950cf701d44f5c8c737` |
| Acceptance | `a755b0d535b8a5c6075ae64efbf85ec3775a26892c0a765052ff08e7e98ee5cc` |

Acceptance manifest SHA256: `f8356d5c863c12a93c3f86ac14737accb39f3d633ba67004a7f6ce528d805698`.

The contracts tarball is installed through pnpm's file dependency. Preserve the
exact archive and LICENSE; never rebuild, fork or refreeze the contracts/browser/runner.
Copy handoff archives, identity and manifests to `.scratch/image-send-recovery/review2/artifacts`.
Extract browser, contracts and acceptance into sibling test-owned folders, verify
archive/manifest hashes from identity and every extracted file, then install runtime
dependencies in extracted `contracts/package` and `acceptance` as documented by
the archived README. These installs are dependency-only, not source builds.

## Isolated verification

For product changes, run the full repository sequence with pinned Node 24/pnpm 11.22:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
node --test apps/partner/tests/image-send-recovery.test.ts
```

For runner-only verification, retain reviewed product checks and start a fresh fixture:

```sh
IMAGE_FIXTURE_EVIDENCE="$PWD/.scratch/image-send-recovery/review2/native-evidence" \
  node apps/partner/tests/image-send-recovery-fixture.ts \
  .scratch/image-send-recovery/review2/browser 19871 19872
```

The fixture creates its own temporary workspace, SQLite database, Codex home,
fictional persona and fake official app-server. The selected host/control ports
must be unused; neither canonical services nor credentials are read/restarted.
In a second terminal run the exact extracted runner:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:19871/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:19872/__test/image-send-recovery \
APP_ACCEPTANCE_EVIDENCE="$PWD/.scratch/image-send-recovery/review2/evidence" \
  node .scratch/image-send-recovery/review2/acceptance/images-browser.mjs
node .scratch/image-send-recovery/review2/acceptance/route-lifecycle-browser.mjs
```

Controls are **test infrastructure only**, in a separate loopback server. Reset
clears only that fixture's state. `mode` drives explicit fake-server rejection,
consumption or ambiguous internal failure; `unconsumed` uses a verified rejection
and is projected truthfully as rejected. `nativeRecovery` appends native-origin
sources through real native admission. `consume` appends actual official user
items; `complete` emits a completed agent image/reply; `history` appends 32 completed
native replies. `missing` removes only recovery originals; storage controls inject
failure/unavailability without admission. Results read actual submissions,
execution records, native recovery/history and album. Native evidence captures
original bytes read by the fake official server for start/steer, independently
of HTTP upload. Stop the fixture with SIGINT/SIGTERM to remove its own workspace.

Retain the previous shared text/streaming-voice/four-panel actual-host runner and
native tests. Compare extracted manifests again after acceptance, and record logs,
artifact identity, screenshots, byte evidence and commit/LOC coverage in untracked
`.scratch/image-send-recovery/implementation-report.md`. Keep the PR open for Owner
whole-spec review and both backends' joint user acceptance; do not merge or deploy.

## Current default frontend acceptance

The historical artifact identities above remain evidence. For canonical-root
verification use the approved #3162 full artifact and
[default shared frontend](default-shared-frontend.md), including all six native
suites and route lifecycle. The native fixture serves the extracted browser at
`/`; product builds/package preparation include that same approved App by default.
