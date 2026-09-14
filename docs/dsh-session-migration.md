# DSH session migration notes

This migration is a semantic translation, not a copy of DSH's execution log.
The durable result keeps the conversation a person and Partner can recognize
while Codex becomes the sole owner of subsequent model history.

## Inputs and ownership

The operator supplies one stable DSH session log, Companion relationship
history, the attachment object-store root, DSH settings, and a new empty CFL
workspace. The importer never discovers or modifies live DSH state. Dry-run
performs all parsing, validation, hash checks, and avatar decoding without
creating the destination or contacting app-server.

The destination owns these migrated files:

- the native Codex rollout containing user text, separate assistant messages,
  and completed compaction boundaries;
- `.lamplit/session.sqlite`, containing relationship history and CFL projection
  metadata;
- `.lamplit/historical-media/`, containing verified historical message images;
- `.lamplit/profile/companion-avatar.png` and `user-avatar.png`, selected by
  relative paths in the Partner TOML.

## Translation rules learned from the Yuki session

Only `user/message` records whose source kind is `user` represent human input.
Plugin-injected recall, system reminders, skill instructions, and code-mode
protocol text can use the same DSH role and must be excluded by provenance.

A DSH turn can contain several finalized assistant messages. They remain
separate Codex agent messages and separate Companion bubbles; joining them
changes both pacing and meaning. Stable UUID client IDs are generated per user
message so app-server history and CFL projection can refer to the same input.

Completed compactions become native Codex compacted records. The newest compact
replacement plus later messages forms active model context, while pagination
still exposes the full translated conversation. Tool calls, tool results,
reasoning chunks, opaque protocol events, and system records are discarded.

Historical images are resolved through their `sha256:` attachment IDs, verified
against their bytes, copied once, and restored as `local_image` entries on the
original user messages. Other attachment-store objects may be copied as an
archive, but only referenced images enter history. Avatars are identity assets,
not chat attachments: they are decoded from `dsh-companion` settings into the
workspace and served through fixed application endpoints.

Relationship records retain chronological order. Their latest state is written
once into the imported active context because path-based resume does not run the
initial SessionStart hook; later compactions use the normal hook refresh path.

## Acceptance evidence

Before cutover, compare source and destination counts for human messages,
assistant messages, compactions, relationship records, and referenced images.
Confirm that no injected Hindsight or system text appears, multi-message replies
render as separate bubbles, historical images load, both avatar endpoints return
the expected bytes, and the source files remain byte-for-byte unchanged. Then
open the candidate workspace in the real Companion UI before changing either
service configuration.
