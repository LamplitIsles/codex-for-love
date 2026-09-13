# Use the official Codex app-server for the Partner runtime

Status: accepted for the standalone core

## Decision

Codex for Love runs one official Codex app-server process over SDK-managed
JSONL stdio. The pinned `@jaminzhou/codex-app-server-client@0.2.1` owns the
typed protocol boundary and transport lifecycle; the configured Codex
executable remains the runtime selected by the operator.
The app-server owns the authenticated model thread, model history, execution,
official tools, skill discovery, selected MCP clients and compaction. The Node
host owns only the Companion HTTP/SSE projection,
relationship state, STT adapter, image attachment files and UI metadata.

The host uses the official device-auth login already managed by Codex. It
does not parse or copy credentials, add a model Bridge/provider, replay an old
session, or maintain a second transcript. A small app-owned SQLite store keeps
message presentation metadata, unresolved-input/draft visibility, relationship
records, compact boundaries, token observations and attachment paths. Accepted
input bodies are retired after official acknowledgement; only minimal source
segment metadata is retained when a merged official user item must be projected
back to its constituent inputs. Replaced inputs and local attachment
materialization errors remain durable application facts. The Companion does not
call the app-server durable queue APIs. Official history is read through
paginated thread APIs on startup, refresh and resume.

The configured app-server is pinned to `0.154.0` and defaults to
`gpt-5.6-luna`. A project-local Codex config overlay declares the selected
`web`, `project`, `flicknote` and `guion-email` MCPs and disables the known
unselected host MCP entries. Native tools, skills and code mode remain
official; only the three relationship operations and `roll_dice` are dynamic
application tools.

Native image generation is capability-gated. The host consumes official
`imageGeneration` item lifecycle events and their saved artifacts, copies
completed PNGs into `.lamplit/attachments/`, and associates them with the
assistant turn in the Companion projection. Uploaded images use native
`localImage` inputs at stable attachment paths. There is no custom image
provider fallback.

Context bootstrap uses an application-owned, hash-verified SessionStart
`startup|compact` hook with `additionalContextLimit=0`. It injects current
relationship state once at a new context and after compaction. Post-compact
text continuity is limited to the newest five complete text rounds under a
4,000-token soft budget; tool and image payloads are excluded. The bootstrap
is metadata and historical evidence, not a new user message.

## Compaction limitation

On the current remote-v2 app-server path, base instructions are sent with the
conversation and compaction uses the official `CompactionTrigger`/history
flow. Remote-v2 does not read the separate `compact_prompt` setting, so this
core does not claim that the Owner's eight-section custom summary is a remote
feature. The independent prompt artifact is retained for the separately
Owner-held local-routing phase; no provider alias or Bridge fallback is used.

## Consequences

This gives refresh, ordinary completed-thread resume, native turn steering and
native image artifacts a single execution source of truth. The HTTP projection
keeps one canonical result per official turn while input records retain source
identity and delivery state. Revisioned replacement markers and result
revisions make incremental refresh safe against stale pages and overlapping
responses. Definitively
rejected steers can be merged for a later native start, while an ordinary stop
restores only locally unacknowledged input; neither behavior creates a durable
application queue.
It also means app-server version drift, missing native image capability,
missing selected MCP executables and official authentication failures are
startup/operator concerns and must be reported truthfully. Docker packaging,
deployment cutover, historical migration and crash-recovery fault testing are
separate work.
