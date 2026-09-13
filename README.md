# Codex for Love

Codex for Love is the standalone Lamplit Partner experience: the existing
Companion UI and a small Node host around the official Codex app-server. The
app-server is the only execution owner. It owns the authenticated model
thread, model history, tools, skills, execution and compaction; this
repository owns the Companion projection, relationship state, speech
transcription and workspace attachments.

This checkout is a local core implementation. It does not migrate an old
session, replace an existing Lamplit service, package Docker, or perform a
deployment cutover.

## Requirements

- Node 24 (the root `package.json` declares `>=24`).
- pnpm 11.22.0, pinned by `packageManager`.
- Codex CLI/app-server 0.154.0 on `PATH`, or an explicit executable in the
  TOML configuration. The runtime fails at startup when that executable is
  unavailable or reports a different app-server version.
- The Partner uses `@jaminzhou/codex-app-server-client` 0.2.1 for typed,
  SDK-managed stdio. The SDK is pinned to the same Codex 0.154.0 protocol
  baseline, but the executable in `codex.command` remains the runtime
  authority; the bundled SDK executable is not selected implicitly.
- An existing official Codex login. Run `codex login status` and complete the
  official device-auth login if necessary. The app does not read, copy, parse
  or refresh credentials itself.

## Install, check and run

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
conversation; this implementation has no historical-session migration.

The equivalent direct commands are useful when diagnosing startup:

```sh
pnpm --filter @lamplitisles/partner check
pnpm --filter @lamplitisles/partner build
pnpm --filter @lamplitisles/partner cli serve /path/to/partner.toml
```

Automated tests use a test-owned temporary workspace and a schema-valid fake
app-server subprocess launched through the real SDK. They never use the real
Codex home, credentials or services:

```sh
pnpm test
```

The bounded real-runtime check is separate because it requires the installed
Codex 0.154.0 binary. It starts a test-owned loopback Responses provider and
isolates `HOME`, `CODEX_HOME`, XDG directories and the workspace; it does not
use credentials, external MCPs, paid model requests or external messages:

```sh
pnpm --filter @lamplitisles/partner test:real-sdk
```

That probe verifies the SDK handshake and strict validation, native
`turn/start`/`turn/steer`, multiple user inputs in one turn, paginated history
and items, turn interruption followed by a fresh start, an early dynamic-tool
request, and text plus `localImage` input. Fixture coverage and this isolated
probe do not establish live-account image-generation or remote
compaction-result behavior.

## Configuration and ownership

`apps/partner/config.example.toml` is the complete operator-facing shape:

- `name` and `persona` select the Partner identity. The Owner-maintained
  companion base instructions are loaded from `runtime/prompts.ts`; the worker
  only assembles them with the selected persona.
- `codex.command`, `codex.model` and `codex.version` select the official
  app-server. The supported version is currently `0.154.0`; the default model
  is `gpt-5.6-luna`. Omit `codex.home` to use the existing authorized Codex
  home, or set it to an operator-owned Codex home. The SDK owns the
  `app-server --listen stdio://` arguments and applies a strict protocol
  validator; only additional app-server flags belong in its SDK boundary.
- `workspace` contains the ordinary working files and the application-owned
  `.lamplit/` subtree. `.lamplit/session.sqlite` contains presentation and
  relationship metadata, `.lamplit/thread.json` identifies the official
  thread, and `.lamplit/attachments/` contains stable image files. The app
  does not duplicate the official transcript or model payloads in SQLite.
- The optional `speech` section enables DashScope transcription. Store its
  credential with `pnpm --filter @lamplitisles/partner cli credential
  /path/to/partner.toml speech`, supplying the value on stdin; do not put the
  key in TOML or command arguments.

Before creating the official thread, the host writes a project-local Codex
overlay under `<workspace>/.codex/config.toml`. It preserves unrelated TOML,
declares the selected MCP inventory, and disables the known host-only entries:

| MCP | Official configuration |
| --- | --- |
| `web` | `web mcp --provider kepos-bridge` |
| `project` | `project mcp` |
| `flicknote` | `flicknote mcp` |
| `guion-email` | `https://mail.guion.io/mcp` |

The mail prompt selects the intended Partner mailbox; the app does not send
test mail. Native Codex skill discovery remains enabled. Shell, patch,
`view_image`, code mode and the selected MCPs are provided by official Codex,
not reimplemented as app-owned wrappers. Discovery and authentication errors
are surfaced as failures instead of being silently replaced by another
provider.

## Conversation behavior

Messages are admitted once with an optimistic UI projection, then submitted
through the official turn API: `turn/start` when idle and `turn/steer` with the
required `expectedTurnId` while a regular turn is active. The Companion does
not use the app-server's durable queue APIs. Initial and restart hydration
reconciles the lightweight projection from paginated official turn data; after
that, lifecycle events update only the affected turn. Browser snapshots read
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

The current app calls the official `thread/compact/start` operation and
projects its lifecycle and engine-reported token observations. On the current
remote-v2 path, Codex sends the thread's base instructions plus its
`CompactionTrigger`/history flow; it does not read the separate
`compact_prompt` setting. Therefore this implementation does not claim that
the Owner's eight-section custom summary is supported by remote-v2. The
independent `compactionPrompt` artifact remains available for the Owner-held
local-routing work and is not misrepresented as a remote result here.

## Scope and safety

Use a test persona such as Mica and a fresh application workspace for local
acceptance. Never copy the real Codex home or conversation into this
repository, and never send an external message as a test. Existing Lamplit
services, Docker packaging, migration, deployment cutover and crash-recovery
fault testing are outside this core.

Source provenance and retained upstream licenses are recorded in
[`docs/IMPORTS.md`](docs/IMPORTS.md). The ownership decision is recorded in
[`docs/adr/0001-codex-app-server.md`](docs/adr/0001-codex-app-server.md).
