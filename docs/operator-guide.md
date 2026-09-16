# Codex for Love

Codex for Love is the standalone Lamplit Partner experience: the existing
Companion UI and a small Node host around the official Codex app-server. The
app-server is the only execution owner. It owns the authenticated model
thread, model history, tools, skills, execution and compaction; this
repository owns the Companion projection, relationship state, speech
transcription and workspace attachments.

## Browser appearance and language

The Companion header settings control lets an owner choose 中文 or English and
light, dark, or system appearance. These are browser-local preferences only:
they do not add TOML fields, service configuration, workspace state, or
operator recovery steps. If browser storage is unavailable, the selection still
applies for the open page but is not retained after reload.

Relationship state is an append-only workspace journal at
`.lamplit/relationship.jsonl`. The bundled `companion` MCP is its sole runtime
writer and exposes relationship updates, signatures, history, and dice. On
startup CFL refreshes its bundled Companion MCP configuration, creates or
resumes its thread, then waits briefly for that MCP to connect. `flicknote` and
`web` are optional operator integrations: their failure never prevents the
Partner from starting. This keeps the current tool catalogue out of persisted
Codex thread history without making the standalone runtime depend on the
Lamplit host ecosystem.

This checkout is a local core implementation. It does not perform generic
session migration, replace an existing Lamplit service, package Docker, or
perform a deployment cutover. It does include one explicit, one-time import
for an operator-supplied DSH log after DSH has already compacted it; that
workflow is described below.

## Requirements

- Node 24 (the root `package.json` declares `>=24`).
- pnpm 11.22.0, pinned by `packageManager`.
- Linux x64 and macOS ARM64 users can install the package with
  `npm install -g @lamplitisles/codex-for-love`. It brings the
  exact matching native app-server and code-mode host package (musl on Linux).
  Windows and Intel Macs are unsupported. macOS support requires the next
  main-package release; already-published CFL 0.1.1 is Linux-only.
- The Partner uses `@jaminzhou/codex-app-server-client` 0.2.1 for typed,
  SDK-managed stdio. The SDK is pinned to the same Codex 0.154.0 protocol
  baseline. CFL always invokes `codex.command` as a direct app-server; the SDK
  does not select a CLI fallback.
- An existing official Codex login. Run `codex login status` and complete the
  official device-auth login if necessary. The app does not read, copy, parse
  or refresh credentials itself.

## Install, check and run

The published CLI supplies and verifies its native app-server, so an installed
configuration omits `codex.command`, `codex.version`, and
`codex.provenance`:

```sh
npm install -g @lamplitisles/codex-for-love
codex-for-love serve /path/to/partner.toml
```

It never compiles or downloads native code in an install hook. The main package
pins an immutable native package version per supported platform; later CFL
application releases may keep those versions unchanged. An official Codex login remains
operator-owned.

For checkout development, retain the pinned pnpm workflow:

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Create a private configuration and persona from the examples, then start the
host with that configuration:

```sh
cp apps/partner/config.example.toml /path/to/partner.toml
cp apps/partner/persona.example.md /path/to/persona.md
# Edit partner.toml so persona points at /path/to/persona.md.
pnpm --filter @lamplitisles/partner start -- /path/to/partner.toml
```

The host binds to `127.0.0.1` and prints its URL. `state` and `workspace` are
resolved relative to the configuration file. Use a fresh workspace for a new
conversation. To create a candidate from a compacted DSH log, use the
one-time import command below instead of pointing the normal host at the DSH
log.

The equivalent direct commands are useful when diagnosing startup:

```sh
pnpm --filter @lamplitisles/partner check
pnpm --filter @lamplitisles/partner build
pnpm --filter @lamplitisles/partner cli serve /path/to/partner.toml
```

### One-time relationship journal conversion

After this change is merged and before a migrated workspace is started, an
operator may explicitly convert a legacy CFL SQLite relationship table. It
refuses an existing journal, validates and atomically writes the candidate,
checks exact record equality, and only then removes the table. Do not run it
against a live service; stop the old runtime first and retain a database backup.

```sh
pnpm --filter @lamplitisles/partner cli migrate-relationship-journal /path/to/partner.toml
```

### One-time DSH session import

Manually compact the selected DSH session, wait for its final user turn to
complete successfully, and supply the stable session log together with its
Companion state file and attachment-store root. The converter reads only those
paths. It does not read a live session, trigger compaction, call a model, switch
the active session, copy credentials, or modify its sources. Released physical v0 logs (including packed
text, reasoning and tool-call chunk rows) and logical v3 logs are supported in plain `.jsonl` or
concatenated `.jsonl.zstd` form. Packed chunk rows are counted and discarded;
they cannot affect the three migrated semantics.

Inspect the candidate without writing either destination first:

```sh
pnpm --filter @lamplitisles/partner cli import-session \
  /path/to/partner.toml /path/to/session.jsonl \
  /path/to/.dsh/dsh-companion/state.jsonl /path/to/attachments/v1 \
  /path/to/new-workspace /path/to/dsh/settings.yaml --dry-run
```

The dry-run reports user and Partner message counts, every completed compact
boundary, relationship records, referenced images and discarded record kinds,
plus the reduced user/Partner/compact records. It never prints opaque, tool or
reasoning payloads. A real conversion
requires an absent or empty destination and refuses to overwrite any entry:

```sh
pnpm --filter @lamplitisles/partner cli import-session \
  /path/to/partner.toml /path/to/session.jsonl \
  /path/to/.dsh/dsh-companion/state.jsonl /path/to/attachments/v1 \
  /path/to/new-workspace /path/to/dsh/settings.yaml
```

The command translates every finalized user and Partner text message and
completed compact boundary into a native Codex 0.154.0 rollout. A historical
turn superseded by a later turn may lack `turn/end`; its finalized messages are
still retained. Official pagination keeps
the complete visible conversation, while only the newest compact replacement
and its following messages form active model context. Tool calls, results,
reasoning, system records and opaque payloads are discarded.

All valid relationship records are imported chronologically into CFL state;
the latest one becomes current. Referenced images are hash-checked, copied
byte-for-byte into `<new-workspace>/.lamplit/historical-media/`, and associated
with their original user messages. The two DSH Companion avatars are decoded
from the explicit DSH settings file into `<new-workspace>/.lamplit/profile/`;
TOML stores their workspace-relative paths. Persona remains CFL-owned. Because
Codex 0.154.0 path resume does not run the SessionStart startup hook, the
converter places current relationship context directly into the initial active
history exactly once; later compact hooks refresh it normally.

On success the report identifies the native thread, rollout and workspace.
Point `workspace` at that candidate only during a later explicit cutover. If
app-server registration has begun when an unexpected failure occurs, inspect or
remove the reported isolated candidate and retry with a new destination; the
command does not claim rollback. All automated checks use temporary state and a
fake or loopback provider.

Run the isolated fixture suite with `pnpm test`. The pinned-runtime import
check additionally requires the built Codex 0.154.0 executable and still uses
only a loopback Responses provider:

```sh
CODEX_PATCHED_CODEX=/absolute/path/to/codex \
  pnpm --filter @lamplitisles/partner test:real-import
```

The broader SDK probe uses the same isolation rules:

```sh
pnpm --filter @lamplitisles/partner test:real-sdk
```

It verifies the SDK handshake and strict validation, native turn start and
steering, paginated history, interruption, dynamic tools, local image input
and ordinary resume. These probes do not establish live-account image
generation or remote compaction-result behavior.

## Configuration and ownership

`apps/partner/config.example.toml` is the complete operator-facing shape:

- `name` and `persona` select the Partner identity. The Owner-maintained
  companion base instructions are loaded from `runtime/prompts.ts`; the worker
  only assembles them with the selected persona.
- Published installs select the bundled standalone app-server and verify its
  fork release identity and both executable hashes before startup. Their
  configuration needs only `codex.model`, optional `codex.home`, and optional
  `local_compaction`; the default model is `gpt-5.6-luna`. Checkout development
  may explicitly select an app-server executable for its developer config.
  Changing `codex.model` resumes the same official thread and preserves its
  history; a new workspace is not required. Set `model_reasoning_effort` in
  the workspace's `.codex/config.toml` to choose the reasoning effort without
  changing the shared Codex-home configuration.
- `workspace` contains the ordinary working files and the application-owned
  `.lamplit/` subtree. `.lamplit/session.sqlite` contains presentation and
  relationship metadata, `.lamplit/thread.json` identifies the official
  thread, and `.lamplit/attachments/` contains stable image files. The app
  does not duplicate the official transcript or model payloads in SQLite.
  The relationship drawer also reads dated `memory/YYYY-MM-DD.md` diary files
  on demand, newest first. It is read-only, ignores other paths, and limits one
  rendered entry to 128 KiB.
- `avatars.companion` and `avatars.user` point to image files inside the
  workspace. The browser receives application URLs, never host filesystem
  paths or embedded base64 configuration.
- The optional `speech` section enables DashScope transcription. Successful
  nonempty recordings are admitted as one independent voice-marked message;
  typed text and pending images remain in the composer. Store its credential
  with `pnpm --filter @lamplitisles/partner cli credential
  /path/to/partner.toml speech --stdin`, supplying the value on stdin; do not put the
  key in TOML or command arguments.
- `speech.tts` optionally enables Alibaba or ByteDance MP3 synthesis for a
  finalized reply consisting of one short `[[tts:text]]...[[/tts:text]]`
  passage. The browser prepares it only when asked to play; text delivery is
  never delayed. Alibaba reuses `speech`; ByteDance uses the separate `tts`
  credential. Cached MP3s live under `<workspace>/.lamplit/audio/`, keyed by
  normalized passage and provider/model/voice profile, and are served only via
  same-origin audio URLs.
- Outgoing messages appear optimistically. A backend-admitted message uses its
  normal presentation immediately; only input waiting behind an active turn
  is marked as queued. Partner typing remains a separate conversation state.

Before creating the official thread, the host writes a project-local Codex
overlay under `<workspace>/.codex/config.toml`. If it is absent, CFL creates
the minimal configuration containing its installation-specific `companion` MCP
and SessionStart hook. If it already exists, CFL updates only that Companion
entry and hook, preserving every operator-provided MCP entry without disabling
or adding another service.

[`apps/partner/ecosystem-mcp.example.toml`](../apps/partner/ecosystem-mcp.example.toml)
is an optional, static template for `flicknote` and `web`. Start CFL once, then
copy those two tables into the workspace configuration to opt in. Its comments
document FlickNote's daemon prerequisite and Web's npm installation. Neither
`project` nor `guion-email` is included: Project has no supported
Codex-targeted npm installation contract, and Guion Email is not mature enough
to make part of the documented ecosystem surface.

Native Codex skill discovery remains enabled. Shell, patch, `view_image`, code
mode and configured MCPs are provided by official Codex, not reimplemented as
app-owned wrappers. A missing bundled Companion MCP is an operator-facing
startup failure; optional integration discovery and authentication failures are
reported by Codex without stopping the Partner.

## Conversation behavior

Messages are admitted once with an optimistic UI projection, then submitted
through the official turn API: `turn/start` when idle and `turn/steer` with the
required `expectedTurnId` while a regular turn is active. The Companion does
not use the app-server's durable queue APIs. Initial and restart hydration
reconciles the lightweight projection from paginated official turn data; after
that, only transcript-relevant completed items update the affected turn; the
completed-turn event always performs final authoritative reconciliation. A
transient event/projection inconsistency is logged with a bounded diagnostic
category and does not make the Partner unavailable. `storageError` means CFL
could not durably persist its own SQLite or required attachment state. Browser snapshots read
that projection plus the requested local message page, while the SSE endpoint
remains an invalidation stream rather than an execution journal:

- `GET /api/session` reads the current projection; `before` loads older pages
  and `after` reads bounded changes.
- `POST /api/messages` accepts text and up to five validated images.
- `POST /api/cancel` interrupts the active official turn. If a submitted input
  has not been acknowledged by official history, it remains visibly unresolved
  and editable; it is never silently retried.
- `POST /api/compact` requests native official compaction when no turn or
  recovery submission is active.
- `GET /api/events` invalidates the projection for browser refresh.

The session response keeps user inputs and turn replies separate. `messages`
contains input identity, source text/images, turn association, delivery state
and any local attachment error; `results` contains the canonical turn answer,
generated images and official execution status/error once per turn. A turn
with several inputs therefore has one reply, not one copied reply per input.
Replacement is delivered as a revisioned `replaced` input marker so an
incremental refresh can remove a loaded draft while rejecting an older page;
the browser retains that marker in its merge state and filters it from the
visible transcript.
Official failed/interrupted outcomes are read from Codex history/events rather
than copied into every input. SQLite retains only unresolved input bodies,
source-segment metadata, attachment metadata and application-owned facts such
as replacements or attachment materialization errors.

Follow-ups rejected definitively because the active turn is a review or compact
turn are held in FIFO order and merged into one fresh native turn when the
conversation becomes eligible. This is internal send recovery, not a deferred
queue feature. An ordinary stop restores only unacknowledged text and images to
the composer; reopening a conversation never submits a restored draft. The
next deliberate send may replace that draft's source identities, and a lost
RPC response is reconciled from official user items/history before any result
is shown as accepted.

Uploaded image bytes are validated, materialized once below
`.lamplit/attachments/`, and sent as native `localImage` input with the exact
stable path. The visible message contains only the user text and attachment
preview. Native image creation/editing is enabled only when the app-server
advertises `imageGeneration`; completed native `imageGeneration` items are
read from their official `savedPath` (or bounded native PNG result), copied
content-addressably into the workspace attachment directory, and associated
with the official image item. The assistant turn then exposes the attachment
through `/api/images/<sha256>`. Later projections and normal restarts reuse
that saved association and attachment metadata without rereading the official
source artifact. A later edit can use an uploaded path or the official native
image tool's prior-generated image inputs; tool logs, paths and base64 are
never rendered as chat text.

The project-local hook and MCP overlay is loaded only when official Codex
trusts the workspace project. Use a trusted workspace (the repository itself
is trusted in the documented local setup), or trust a separate workspace in
the official Codex configuration before starting the Companion there.

If an image artifact is unavailable, invalid or too large, the turn remains
truthfully failed and the snapshot reports the storage error. There is no
Bridge/custom image provider fallback. Image creation/editing is covered by a
fixture and must also be checked with bounded real acceptance before any
review.

## Context boundaries and compaction

The host creates one owned `SessionStart` hook with matcher `startup|compact`,
discovers its official hash through `hooks/list`, and trusts only that exact
project declaration through `config/batchWrite`. The startup hook injects
current relationship state once for a new context. The compact hook injects
refreshed state plus the newest complete conversational rounds, capped at
five rounds and a 4,000-token soft budget. Tool calls, reasoning output and
non-text image payloads are excluded, while text from a mixed text/image user
message is retained; role labels identify historical excerpts as evidence,
not new requests. An ordinary turn or resume does not repeat the bootstrap.

The app calls the official `thread/compact/start` operation and projects its
lifecycle and engine-reported token observations. The patched Codex build can
route manual and automatic compaction through the official local summarizer,
which consumes the Owner-authored `compactionPrompt`. Enable it explicitly:

```toml
[codex]
local_compaction = true
```

The host verifies the artifact hash, exact fork revision and helper hash before
SDK startup, and sets the override on both thread start and resume.
The local summary uses a neutral continuity prefix; builtin OpenAI provider
identity is unchanged. Without the override, upstream routing remains active;
remote-v2 does not consume `compact_prompt`.

An imported candidate uses the same owned hook declaration. Codex 0.154.0 path
resume does not execute the SessionStart startup hook, so conversion writes the
current relationship state once into active history and marks startup bootstrap
complete. The imported checkpoint is already in official history. A later
ordinary resume repeats neither relationship state nor the checkpoint.

## Scope and safety

Use a test persona such as Mica and a fresh application workspace for local
acceptance. Never copy the real Codex home or conversation into this
repository, and never send an external message as a test. The one-time DSH
import is limited to a user-supplied, already-compacted released physical v0 or logical v3 log;
generic
migration, existing Lamplit services, Docker packaging, deployment cutover
and crash-recovery fault testing are outside this core.

Source provenance and retained upstream licenses are recorded in
[`IMPORTS.md`](IMPORTS.md). The ownership decision is recorded in
[`adr/0001-codex-app-server.md`](adr/0001-codex-app-server.md).

## Publishing the main package

`release/codex-artifact.json` and `release/codex-artifact-darwin-arm64.json`
are the immutable identity contracts for the already-published Linux and Mac
native packages: fork revision, provenance, and both executable hashes.
Main-package CI downloads both exact npm packages and checks
those values before building CFL; it never compiles Rust or downloads a Codex
GitHub Release.

After a reviewed commit is on `main`, publish a CFL main release by pushing one
strict semver tag through the governed Git workflow, for example
`v0.1.0-beta.1` or `v0.1.0`. The tag is the only main-package version source.
The workflow stages a disposable manifest at that version, leaving the checkout,
lockfile, and native dependency pin unchanged. Prerelease tags use npm's `beta`
dist-tag; stable tags use `latest`. The OIDC workflow verifies its packed
tarball, performs an isolated installed-runtime HTTP smoke check, publishes
with provenance, and checks registry propagation. It safely skips an existing
version only when its immutable npm integrity matches the staged tarball.

Do not use `git push` directly for this governed release operation. After the
required review, use the repository's `og` tag-push workflow. The Trusted
Publisher setup is a separate human-only `.scratch` wizard; no npm token or
GitHub secret is used by this repository.
