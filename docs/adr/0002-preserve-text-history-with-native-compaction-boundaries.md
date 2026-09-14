# Preserve migrated text history with native compaction boundaries

Status: accepted

A one-time DSH migration preserves every user and Partner text message in the native Codex conversation history while mapping each completed checkpoint to a real Codex compacted replacement history. A version-pinned translator writes the minimal official rollout envelopes for user text, assistant text and compact boundaries, then asks app-server to validate and register the file through path resume; CFL does not write Codex SQLite or add an import API patch. This keeps old text available for human review without returning it to the Partner's active context; tool, reasoning, system and opaque records are discarded. Relationship history is converted into CFL state, while source-session-referenced images are copied into the historical media library and restored as attachments on their original visible user messages. Compacted replacement history remains text-only, so those images do not become active model inputs.

Codex 0.154.0 path resume does not execute the SessionStart startup hook. The translator therefore appends the current imported relationship state to the initial active history once and marks startup bootstrap complete; future native compaction continues to receive refreshed state through the normal compact hook.
