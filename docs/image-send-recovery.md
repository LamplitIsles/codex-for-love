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
- Result `{ sessionId, operationId, images: Array<{ id, order, ref: ImageRef }> }`; references have
  `attachmentId`, `name`, `mediaType`, `availability: available|missing`.
  Uploads are bound to this authenticated Partner's selected session/operation.
  Authentication is checked again inside serialized staging. Reusing an operation
  with changed image IDs, order, metadata or any variant bytes conflicts.
- WS `/api/chat/socket` submit: `{ operationId, text, images?, files? }`.
  References must match the complete staged operation. The receipt requires a
  matching native history item; uncertain results remain unknown and are not
  replayed automatically. Explicit retries after a definite failure reuse the
  operation ID and increment its persisted attempt. The frontend owns failed
  message text. See [native submissions](native-durable-submissions.md).
- `GET /api/chat/media/{attachmentId}/{original|preview|model}` authenticates
  requests reaching the server. Preview/model lookup uses staging for the selected
  session; original lookup falls back from that staging to workspace image metadata
  queried by ID. This fallback does not establish cross-thread ownership isolation.
  Originals retain a 32 MiB read bound, previews/models 160,000/320,000 bytes.
  Successful responses use `Cache-Control: private, max-age=2592000`, a strong ETag
  based on the returned bytes, variant and media type, and `nosniff`. Conditional
  requests read and validate the media and recheck authorization/session before a
  matching 304 with the same cache policy and ETag. Errors use `no-store`; missing
  originals/variants return 404. Fresh private caches may reuse bytes without a
  request, including after revocation, deletion or a same-browser account switch.
  Native/generated originals remain readable even when intake is disabled; the
  existing checks do not add image decoding or complete integrity validation.
- History and album project verified native membership and provenance. User
  image-only messages and completed agent images have real media references;
  workspace inspection and staging never add album membership.

The former server-side recovery, replacement and failed-message actions are
retired. Historical artifact identities are recorded in [IMPORTS](IMPORTS.md);
old recovery runners do not establish acceptance of the current contract.
