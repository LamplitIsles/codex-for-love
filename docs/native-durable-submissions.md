# Native-confirmed submissions — CFL spec #5707

CFL's `/api/chat/socket` consumes the published App `lamplit.chat.v2` contract.
The App immediately displays the Human's message and retains confirmed failures
locally. A receipt contains the operation ID, positive attempt number, submitted
or failed state, message and turn IDs, and error. Lookup returns the same receipt
or null when the outcome is unknown. Proven results are also pushed to subscribed
connections, even when the chat view has not changed.

A submitted receipt requires a matching user item in the native thread history.
An acknowledgement that a start or steer was queued is not sufficient. A failed
receipt requires a definite failure before dispatch or a proven native rejection;
missing history, timeout, disconnect or interruption alone remain unknown. Unknown
inputs are not automatically replayed. An explicit retry after a definite failure
uses the same operation ID and a higher persisted attempt number. CFL stores the
identity fingerprint and attempt state, not a recoverable failed message body.

Messages steer the active turn immediately. A stopped turn does not by itself prove
that an in-flight steer was discarded. When the owner cannot prove a particular
outcome, the receipt stays unknown. Attachment staging remains scoped to the owner,
session and operation, and is revalidated before dispatch or retry.

## File input representation

Human files are staged in the Partner workspace. CFL appends their ordered names
and workspace-relative paths to the same Codex user text as the Human's message:

```text
<original text>\n\nFiles (paths relative to workspace):\n<JSON array of {name,path}>
```

CFL reconstructs the exact suffix from scoped staging and input-file metadata and
verifies the complete original submission fingerprint before hiding it from the
chat projection. It does not remove a marker merely because the Human typed it.
Codex's raw history and hooks can see the paths and names. Missing historical
files are shown as missing attachments; they do not change the recorded text.

The previous server-side failed-draft, finalize, retry and deletion socket flows
are retired. Existing database records are not migrated or deleted by this change.
Historical App acceptance artifacts are attributed in [IMPORTS](IMPORTS.md); they
do not verify the current contract. Use test-owned Partner workspaces and fake
app-servers for automated tests. The separate real-native protocol probe uses a
loopback provider and requires its own resource approval.
