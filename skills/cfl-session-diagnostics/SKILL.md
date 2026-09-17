---
name: cfl-session-diagnostics
description: Inspect a Codex for Love dev or prod session's compaction context, token timeline, and retained conversational tail when the user explicitly asks to diagnose that session.
---

# CFL session diagnostics

Diagnose the selected CFL session without altering its service, Codex thread,
workspace, or credentials. This is a human-invoked skill because inspecting a
real session can expose conversation text.

## Scope and access

Read `docs/development-environments.md` first. Identify the target (`dev` or
`prod`) from the request; do not infer one from the newest Codex session file.
Read message bodies only when the user has explicitly authorized it. Otherwise
inspect paths, event types, timestamps, counts, and byte lengths only.

The Partner TOML's `[codex].home` is the Codex history root. It may be shared
by unrelated CLI sessions, so it is not enough to choose the newest JSONL.

## Lock the correct rollout

1. Derive the target service, TOML, workspace, and port from the environment
   document. Read only the TOML's `[codex]` fields needed to obtain `home`.
2. Find the target service's live `codex-app-server` descendant. Use its open
   files to locate the rollout JSONL:

   ```sh
   lsof -p <app-server-pid> | rg '/sessions/.*/rollout-.*\.jsonl'
   ```

   This is the authoritative association. A shared `CODEX_HOME` often contains
   active, newer files for unrelated sessions.
3. If the app-server has already exited, use the target workspace's managed
   `thread.json` and the rollout `session_meta.cwd` to narrow candidates. State
   the association confidence rather than guessing.

Do not restart, pause, compact, steer, or submit to the service merely to make
the file easier to inspect.

## Build the compact timeline

For the locked rollout, extract a metadata-only sequence of:

- `compacted` records: window number, summary byte length, replacement-history
  item count, and retained-context family counts;
- `event_msg` / `token_count`: `payload.info.last_token_usage.total_tokens`;
- `token_usage_record`: `payload.usage.input_tokens` and output tokens;
- following `task_started`, `turn_context`, response-item types, and tool
  outputs.

Interpret the values by boundary, not as one running counter:

| Boundary | Meaning |
| --- | --- |
| Token count immediately after `compacted` | The compacted-history baseline, often summary-only. It is not necessarily the next model request. |
| First post-compact `token_usage_record.input_tokens` | The first actual model input, including static instructions and any hook context. |
| Later token counts in the same task | The first input plus current-turn tool results or other newly accumulated data. |

The recurrence symptom is a large post-`compacted` baseline that increases at
each window. A higher value only after a tool result is current-turn work, not
proof of historical re-injection.

## Verify the CFL tail separately

The bootstrap file is
`<workspace>/.lamplit/context-bootstrap.json`. Inspect `compact` without
printing bodies by default:

- count `Round N:` entries and its byte length; the configured default is ten
  rounds under a 4,000-token soft budget;
- then confirm an actual post-compact rollout response item contains
  `<companion-history>`.

Bootstrap availability alone does not prove that the model received the tail.
Conversely, a summary-only compact baseline is expected when the next request
shows the injected tail. Report a missing tail only if the bootstrap and the
first actual post-compact input together rule it out.

## Handoff

Report: target and rollout association, compact window/time, pre- and
post-compact baselines, first actual input, same-turn tool delta, tail round
count and injection evidence, plus the conclusion. Quote session text only as
needed to answer the user's question and only with their authorization.

If a regression is confirmed, stop after evidence collection unless the user
also asks for a fix. The likely implementation seam is CFL's bootstrap /
history hydration contract; do not restore recursive Codex replacement history
as a shortcut.
