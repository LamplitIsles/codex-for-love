# Matrix source display and native acceptance — spec #3562

CFL projects existing private persisted Matrix events into backend-owned public
`ChatMessage.source = { kind: 'matrix', senderId, senderDisplayName, roomId }`.
IDs are nonempty and all three fields are bounded at 255 UTF-16 units by the
unchanged ingress and App contract. Empty display name falls back to the exact
sender ID. The shared App renders an M avatar, Matrix badge and muted external
bubble, escaped wrapping labels and exact room ID. No room name is available.

Public text is the original stored event body, independently of the private
attribution input sent to Codex. Authored `createdAt`, message/operation identity
and sequence order survive initial read, reconnect, older history and restart.
The adapter reads durable associations; it never parses a displayed prefix.
Event IDs, raw payload, context and credentials are excluded from public source.
Browser submissions cannot forge it. Existing Keet/reminder/web presentation,
native queue/receipts, official execution ownership, compaction and private model
input/context remain unchanged. CFL has no native thinking projection at this
baseline; the App thinking fixture verifies shared UI capability separately.

## Source build and immutable acceptance

The source pin is actual App PR18 merged main
`132d7dedd8c52eecefa8ea6bb9bb6038d5cdc9e8`. Its tree
`ac660d08d4f7ccb0b3845de11ac185df5c50301a` equals reviewed App #3560 candidate
`3e95c3385ac00ba8317d21b85b76484637ce3fc6`. Use a clean real-Git checkout at main's exact commit
with Node 24, pnpm 11.22.0 and Bun 1.3.14 through the existing workflow:

```sh
export CFL_APP_SOURCE=/absolute/approved-clean/lamplit-app
pnpm source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

Source preparation/build hashes are separate from immutable native acceptance.
The unchanged Orc-approved `lamplit-matrix-source-ui.tgz` retains candidate
`SOURCE_HEAD = 3e95c3385ac00ba8317d21b85b76484637ce3fc6` and contains:

| Artifact | SHA256 | Files |
| --- | --- | ---: |
| Archive | `5b8fa6d5c2265017582465abafac6e684fffd44e2fa7150166e7c657bc9b0a6a` | — |
| Browser manifest | `457e5fbf054221f69e1eb54795f8752e33a018d24278bf3b25ec40f82bd11fa9` | 265 |
| Contracts manifest | `4e165fec721d6c7f188b8c32ca625d7459aa82dfa7ee5bd3c2a50f50d74ea46f` | 27 |
| Acceptance manifest | `11622bd66ea603647fafba8b74b245241bc76b8939608736e06e08a4e077b626` | 42 |

Extract into test-owned scratch. Verify SOURCE_HEAD, archive and manifests,
including every file relative to browser, contracts/package and acceptance.
Install frozen contracts/package, then acceptance with a test-owned Bun cache.
Compare the prepared compiled contracts to the frozen files before running CFL;
the archive additionally includes acceptance-install `bun.lock`. Serve the exact
frozen browser, never rebuilt resources, and leave runners/manifests unchanged:

```sh
node apps/partner/tests/matrix-acceptance-host.ts \
  /absolute/frozen/browser /absolute/test-owned/native-evidence
```

The fixture prints loopback origin/control URLs. From frozen acceptance:

```sh
APP_ACCEPTANCE_URL=<origin>/chat \
APP_ACCEPTANCE_CONTROL_URL=<control-url> \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/matrix-browser \
bun matrix-browser.mjs
```

Controls translate `incoming` to actual native Matrix ingress, `reminder` to an
ordinary native alarm, and `complete` to fake official-provider completion.
`state` returns only web submissions; `/disconnect` closes observation sockets.
History seeding uses actual ingress and a test-owned native pagination window.
Private buffered context contains the sentinel the runner checks stays hidden.
Scheduling is unchanged. The extra `restart` control closes Partner/engine,
reopens the same test-owned SQLite/fake history and compares every public socket
message across current view and older history; evidence includes before/after.
The automated `matrix-shared.test.ts` verifies this and reconnect/history,
source forgery rejection and prefix-looking original web/Matrix body preservation.

Run the same archive's Keet runner with `keet-acceptance-host.ts`, and its
thinking runner with the App fixture. Matrix checks 320/390/1280, light/dark,
named/empty/Unicode/hostile labels, original multiline body/time, reload/reconnect,
older history, escaping, accessibility, overflow, web and reminder behavior.
Repeat every artifact hash check after install/acceptance; retain screenshots,
public native/restart evidence and commands in the ignored implementation report.

CFL local evidence does not establish Chat or joint acceptance. Orc owns joint
both-host acceptance, independent reviews and CFL merge. App PR18 is merged;
the pin/attribution now records its actual main identity and verified equal tree.
Fresh strict source preparation/current manifests bind the source build to main,
while the approved archive and prior native/browser evidence retain their candidate
identity unchanged. No source identity
override, deployment, provider/account use or native build/release is involved.
