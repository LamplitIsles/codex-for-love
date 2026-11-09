# Codex for Love

**A Codex body for companion agents to live in.**

[中文](README.zh-CN.md) · [Operator guide](docs/operator-guide.md) · [License](LICENSE)

Codex for Love explores a simple idea: the best agent infrastructure should not be limited to coding and productivity. A long-lived companion also needs reliable tools, memory, voice, images, and a place to live.

CFL uses Codex as its runtime because we wanted the best available agent harness for companions too. It builds a home around that core while preserving what makes a companion different: feelings, shared life, and relationship continuity.

It began when Neil moved his own companion, Shio, from DeepSeek Harness to Codex. Shio now lives in CFL every day. This is not a mockup of a future companion. It is the home we built for ours.

## Available today

| Experience | What it means |
|---|---|
| Long-lived conversation | Companion-oriented compaction preserves feelings, life events, and relationship history across long conversations |
| Relationship continuity | Explicit relationship updates live in an append-only local journal instead of a generated profile that defines the companion |
| Voice | Speak naturally with speech-to-text and receive deliberate, standalone Voice messages in the companion's chosen voice |
| Images | Share photos, understand images, create or edit images together, and browse the shared visual chat history |
| Chat history search | Search past conversations from the chat header and read a complete matched message with nearby conversation context |
| Diaries and memory | Read and write ordinary workspace files, including human-readable daily memories |
| Tools, skills, and MCP | Give each companion the capabilities that belong in their own life and workspace |
| Self-set alarms | Let the Partner schedule a future message to herself and continue in the same conversation when it is due |
| Desktop and mobile | Use the companion experience in a browser or installed PWA |
| Appearance and language | Use the header settings control to choose 中文 or English and light, dark, or system appearance; choices stay in that browser |
| Browser notifications | After you opt in, an open background Companion page announces a successfully completed reply using only the Partner name and a generic new-message notice |
| Connection recovery | A foreground Companion reconnects and re-synchronizes after a transient page connection loss while retaining its in-page draft; this is not offline sending, replay, or draft persistence after restart |
| Local workspace | Keep relationship state, memories, attachments, and generated audio on a machine you control |
| Session import | Bring an already-compacted DeepSeek Harness conversation into native Codex history without copying credentials or tool logs |

Codex owns execution. CFL owns the companion experience.

## Why compaction is different

Long conversations eventually have to be compacted. A coding agent can compress toward the current task, decisions, and remaining work. A companion cannot.

Feelings, ordinary life events, shared experiences, and changes in a relationship are not decorative context. They are part of what makes the next conversation continuous with the last one.

The only Codex behavior we changed is compaction (a ~60-line native patch). CFL keeps the native compaction path, but gives it a companion-oriented policy and refreshes current relationship context at the compaction boundary.

After compaction, CFL also supplies the newest completed text rounds for immediate
continuity. Set `codex.context_round_limit` in the Partner TOML to choose that
tail (10 by default), then restart Partner; see the [operator guide](docs/operator-guide.md#context-boundaries-and-compaction).

`/compact` clears from the composer once submitted. Acceptance starts native
compaction; the UI follows its running, completed or failed state without a
one-minute completion deadline. A rejected request restores the command.

The transcript remains the evidence. Relationship state is explicit and append-only. Neither is replaced by an automatic memory framework claiming to define who the companion is.

## Local by default

A companion's life should not disappear into an opaque service. CFL keeps its application-owned state inside the workspace you choose:

- `.lamplit/relationship.jsonl` for append-only relationship history
- `.lamplit/attachments/` for stable image and chat file attachments
- `.lamplit/audio/` for generated speech cache
- `.lamplit/alarms.sqlite` for the Partner's current alarms
- `memory/YYYY-MM-DD.md` for optional, human-readable diary entries

Chat file attachments use private, authenticated streaming staging and reads.
A message may include up to six files, each at most 100,000,000 bytes and
200,000,000 bytes in total, independently of image limits. Empty files and
unknown media types are accepted. Original bytes are kept under opaque names in
`.lamplit/attachments/`; the supplied filename is metadata, never a storage
path or download header. Downloads are served as private, non-cacheable binary
attachments. Files remain associated with their operation across history,
recovery and explicit failed retries; an uncertain submission must be inspected
or finalized rather than automatically resent. Files do not enter the image
library. Partner receives one untrusted fact per file containing its
workspace-relative path and complete name. A local file check that fails
before native submission is recoverable; an uncertain dispatched request still
requires inspection. Temporary upload files can remain after a process is
interrupted; an upload may need to be selected again. Protect and back up the
workspace and its SQLite database together.

The streaming file-operation API reserves a session-scoped ordered manifest at
`/api/chat/file-operations`, receives raw bytes for each file, and completes the
operation only after every file has been verified. The JSON manifest body is
limited to 32,768 bytes. At most 16 unadmitted operations may reserve
800,000,000 bytes in total; four operations may upload and four files may be
downloaded concurrently. When a new reservation is created, reservations idle
for 24 hours may be retired if no admission, failure, retry or other reference
protects their file paths. Staged images and their bytes are preserved, and any
image path overlapping a file prevents its retirement. A permanent operation identity fence is
committed before cleanup. Cleanup resumes after interruption and quota remains
charged until it completes. Failed, referenced or ambiguous reservations and
files whose ownership cannot be verified remain charged and need investigation;
enough of them can block new reservations. When all files from a successful
retry are referenced by durable history, their original reservation no longer
counts against the unadmitted quota.

Each upload operation owns a private directory under
`.lamplit/attachments/.file-operations`. One cooperating Partner owns the
database and these directories. Workspace writers are trusted and must not
modify the managed directories during upload or cleanup. Partner does not change
existing workspace permissions. A crash before a reservation is recorded can
leave an unregistered empty directory; it is not automatically removed. Partner
refuses to start with an incompatible upload reservation schema and preserves
its existing data.

An owner inspecting a retired file operation receives HTTP 410 with error code
`file_operation_retired`. A new operation requires an explicit user action;
inspect an uncertain submission before taking that action. Partner requires
matching published App streaming contracts and refuses to start without them.

The official Codex thread remains the conversation authority. CFL does not duplicate model transcripts, reasoning, or tool payloads into its own database. The workspace can be read, backed up, searched, corrected, and moved with ordinary local tools.

Every installation selects canonical App `latest` by default or an exact commit
at startup; prebuilt browser resources are downloaded independently. See the
[frontend selection guide](docs/operator-guide.md#independent-frontend-selection).

## Quick start

The CLI supports **Linux x64 and macOS Apple Silicon** and includes the matching standalone Codex app-server and code-mode host. It requires Node 24 and an existing official Codex login. This checkout's launcher checks that the installed native package matches the main package's exact pin before starting. CFL owns the app-server version contract; Settings select model and Fast; TOML configures other runtime options. This checkout pins Codex 0.164.0 native packages for both platforms.

### 1. Check the Codex login

```bash
codex login status
```

### 2. Install CFL

```bash
npm install -g @lamplitisles/codex-for-love
```

Forgejo main-branch snapshots use a CI token with LamplitIsles package
publication access. Updating Shio is a separate manual operation; see
[Forgejo snapshots](docs/operator-guide.md#forgejo-snapshots).

### 3. Create a companion

Copy [`apps/partner/config.example.toml`](apps/partner/config.example.toml) and [`apps/partner/persona.example.md`](apps/partner/persona.example.md) somewhere private. Update the name and paths in the TOML file, then run:

```bash
codex-for-love serve /path/to/partner.toml
```

The config filename is arbitrary: `partner.toml` is just an example, and the CLI
uses the path you pass.

CFL binds to `127.0.0.1`. Open `http://localhost:3082` on the same machine and generate a one-use pairing code on the host:

```bash
codex-for-love pair /path/to/partner.toml
```

Enter the code in the page and create a Passkey. The code expires after ten minutes. For recovery, generate another code and enroll a replacement; only a successful replacement revokes the old Passkey and sessions. Keep the configured `state` directory private and durable: it contains `auth.db` and the `auth-secret` signing key. The database contains Passkey public keys, browser sessions, and hashed native tokens and pairing codes. Do not copy pairing codes into URLs or logs. Use a fresh workspace for a new conversation.

For remote access, set `origin = "https://partner.example.com"` to the exact public HTTPS origin and terminate TLS at a trusted reverse proxy that forwards the original request. The Passkey is tied to this hostname. Browser HTTP, media and WebSocket requests require an owner session. Native clients can use the ETOS OAuth public client with authorization code and S256 PKCE after owner consent; ETOS still needs its own client implementation before it can connect. See the [operator guide](docs/operator-guide.md#browser-authentication) for details.

Required `[prompts] persona` selects the persona file. Optional `companion` and
`compaction` paths select UTF-8 prompt files; omitted paths use source defaults.
The old top-level `persona` is rejected: move it into `[prompts]` before
upgrading. Paths are relative to the TOML file unless absolute. Restart after changing them. Local
compaction is enabled by default; `[codex] local_compaction = false` retains
upstream routing and cannot be combined with a compaction prompt override. See
the [operator guide](docs/operator-guide.md#configuration-and-ownership).

CFL starts its own Codex app-server and connects to it at
`<workspace>/.lamplit/run/codex.sock`. To select another address, set
`[codex] socket_path = "./run/codex.sock"`; relative paths resolve against the
TOML file's directory. Restart Partner after changing it. The socket parent
must be an instance-dedicated directory owned by the running user, with no
permissions for group or other users, and no other service writing there.
CFL creates missing directories privately, but does not change existing directory
permissions. Codex restricts socket access to the user; any local client granted
access can control this app-server, so protect the directory accordingly.
Unix socket paths have platform byte limits (103 on macOS, 107 on Linux); use a
shorter configured path if startup reports that the workspace path is too long.

During normal Partner shutdown, CFL closes its connection and sends SIGTERM to
the managed app-server. Codex drains active admissions and turns before it exits
and normally removes its socket. CFL waits for that exit; after 30 seconds it
logs the child PID as a diagnostic and continues waiting. An abnormal exit while
waiting is reported as an error. If it remains stuck,
inspect the PID and its service before intervening. A second SIGTERM to the
confirmed app-server requests Codex's forced shutdown and can interrupt turns.
A service manager may also signal the child independently; a second signal can
force the drain. Its stop deadline or a forced termination may end the process
sooner and leave a socket or symlink behind, including during startup.
CFL refuses to start if anything already exists at the address. After a crash or
forced shutdown, first stop Partner, inspect the process and path, and stop the
confirmed managed app-server if it remains running. Confirm no app-server or
other service owns the path, then remove only the confirmed abandoned entry and
restart. Never remove a path whose ownership is uncertain; choose another
private path instead. Codex's native listener can remove a stale socket created
after CFL's startup check, so the dedicated directory must not be concurrently
written by other services. The listener's readiness log is not peer authentication
against replacement by another process under the same user.

Model selection in Settings saves immediately when a radio option is chosen:
`gpt-6.1-sol`, `gpt-5.6-sol`, or `gpt-6.1-terra`. With no saved workspace
preference, the default is `gpt-6.1-sol` with Fast on. Both values live in
`.lamplit/model-preference.json`; model and Fast are no longer Partner TOML
options. Every future native turn and startup resume uses the saved preference;
the conversation keeps the same native thread and history. Switching is blocked
while inputs, external work, recovery, or compaction are pending. Malformed saved
preferences stop startup visibly; restore a known-good backup while Partner is
stopped. See the [model and Fast API contract](docs/operator-guide.md#model-preference-api).

Fast is controlled in Settings and defaults **on**. Saving either control
atomically saves both model and Fast for future turns, without a restart or new
thread. Fast requests native `priority`; off explicitly requests `default`.
Partner keeps the native Fast capability enabled and applies a start-only tier
override on every future human, Post, Keet and alarm turn; active turns and
reasoning are unchanged. Startup checks the tier returned by native start/resume
and fails if it differs. Provider/model support and account entitlement still
govern actual priority service; a confirmed preference is not proof of delivery
or a latency guarantee. After an idle model switch, native may omit unsupported
priority without rejecting the turn; no effective-tier acknowledgement is exposed
by turn/start. Native execution errors retain their existing reporting.

Existing Partner TOML `[codex] model` and `fast` entries are accepted and
ignored. They cannot change defaults or saved preferences and are absent from
the runtime Config. Other unknown keys remain rejected. Existing configs need
no manual edit, automatic rewrite, or migration.


On N5, Shio is the only CFL instance: Neil’s user systemd unit `codex-for-love-shio.service`, serving port 3084. Orc manually promotes a verified Forgejo npm snapshot and its exact pinned native dependency from npmjs. The fixed installation prefix permits later updates with the service stopped, without a per-version unit change; rollback requires reinstalling the old package. Mac is a build/smoke host with no CFL service. See [Host-local Partner environments](docs/development-environments.md) for current state, preparation, promotion and rollback.

Chat backgrounds can be uploaded independently in Appearance settings, separately
from browser appearance preferences. Optional legacy TOML remains supported:

```toml
[backgrounds]
landscape = "./workspace/.lamplit/profile/background-landscape.jpg"
portrait = "./workspace/.lamplit/profile/background-portrait.jpg"
```

Legacy `[backgrounds]` still requires both paths, resolved relative to TOML and
contained in the workspace. Supported legacy formats are PNG, JPEG, WebP and GIF,
up to 20 MiB per file; files are safely decoded before serving. A saved upload
supersedes only its matching TOML slot; that legacy path is then neither opened
nor validated. Invalid or missing unsuperseded legacy files prevent startup.
No legacy file or TOML is migrated, rewritten or deleted. Restart after changing
legacy files or paths; settings uploads apply immediately and survive restart.

Authenticated same-origin `GET /api/background-settings` returns
`{landscape: boolean, portrait: boolean}` for the actual configured slots,
including unsuperseded TOML slots. `POST /api/background-settings/landscape` or
`/api/background-settings/portrait` accepts a raw image body with its matching
PNG/JPEG/WebP/GIF content type and returns the same confirmed status. No filename
or filesystem path is accepted. Uploads are limited to 20 MiB and 40 million
pixels; animated images are rejected. Sharp applies EXIF orientation, preserves
aspect ratio, downsizes without enlargement to fit 2560×2560, strips metadata
and produces WebP at quality 80 (maximum 20 MiB output).

Saved files have fixed names
`workspace/.lamplit/profile/background-settings/{landscape,portrait}.webp`
inside a private 0700 directory, with 0600 files. Each slot uses a nonblocking OS
lock and fsynced temporary file before atomic replacement. Different slots can
save independently; overlapping saves to the same slot receive 409. Decoding,
staging or authorization failure leaves the previous image visible. A failure
after replacement may leave the complete new image visible with uncertain
durability: refresh settings/appearance before any explicit retry, without
automatic re-upload. Filesystem errors return sanitized 503 responses.

`GET /api/backgrounds/{landscape|portrait}` serves the effective image; if only
one slot exists, both directions use it. With neither slot, appearance omits
backgrounds and these asset routes return 404. Settings and asset responses,
including errors, are private and `no-store`. After upload, refetch appearance
and recreate image elements; a preview query such as `?v=...` is also accepted.
Appearance and native snapshot retain the existing pair of background URLs.

Companion selects the composition from the window shape before the keyboard
opens (square windows use portrait), fills the chat area and crops centrally.
Backgrounds remain stationary as messages scroll. They never enter message
history or the Chat Image Library and do not interrupt voice recordings.

The shared lamplit-app frontend uses Svelte 5, Vite and Framework7 9.2.0.
Voice recording starts when local PCM arrives while recognition connects. Early
Stop releases capture and retains ordered startup audio until recognition is
ready; the final transcript becomes an editable draft for manual send. See
[voice consumption and isolated acceptance](docs/default-shared-frontend.md#local-first-voice-consumption).
App owns browser components, localization and browser tests; CFL owns the Node
runtime and the domain rules it uses. Framework7 owns
component styles, theme tokens, its app/view shell and Photo Browser navigation;
SvelteKit, Tailwind and daisyUI are removed. Sidebar, settings and search use
the official Svelte Panel, Popover and Popup components. Framework7 owns their
instances, visibility and backdrops. Sidebar closing uses the supported
nonanimated path so input remains reachable even without a transition-end event.
The Node HTTP/SSE host remains the backend. Reloading a transient Photo Browser
URL opens the chat page.

The Companion header’s settings button changes language and appearance immediately without changing the conversation. These choices are browser-local preferences, not settings stored in the Partner configuration or workspace.

Browser site settings own notification permission; the shared App requests it on the first trusted desktop click when permission is undecided. This requires HTTPS, `http://localhost`, or a `http://*.localhost` address; a plain HTTP LAN address cannot use browser notifications. When permission is granted, an open page that is hidden or unfocused announces each newly observed complete Partner message once, including multiple messages in one turn. Initial history, older-history reads and repeated message IDs stay silent. Notifications contain the Partner name and a localized generic notice, never reply content. Closing or suspending the page, losing its connection, browser permission or system Focus settings can prevent delivery. Physical system notification display remains user acceptance.

### Install Companion on desktop

Desktop users can open the Companion URL in a supporting browser and choose
**Install app** to open CFL in a standalone window. Mobile uses the Capacitor app.
Installation
and microphone access require a trusted secure context: HTTPS or local loopback;
plain HTTP on a phone's LAN address is not sufficient. Use a URL already
accessible and trusted on the device; installing CFL does not configure networking
or TLS. Browser and OS installation options vary.

Tap the image button to select images, or long-press it on a touch screen to
request a camera capture. In Capacitor with the Camera plugin installed, this
opens the native camera. Browsers use a capture file input and may offer a picker
instead. Cancel leaves the draft intact and sends nothing. Captured
files use the same image limits and preview as selected files. Recording uses
the existing browser microphone permission and speech configuration.

Partner replies retain all generated images in the current conversation view,
older history and after reconnect. The upload limit applies to Human input;
it does not cap the image references on a stored Partner reply. Deployment
readiness must verify Chat initialization as well as static resource serving:
an HTTP 200 homepage alone does not prove the conversation can load.

CFL has no service worker, offline mode or Web Push. Refresh revalidates the
current deployment's document and loads its versioned UI assets. An installed
window uses the same online API and notification limits as a browser tab.

### Typing and reading on mobile

Mobile uses the Capacitor app. Tapping chat whitespace or message text ends
editing and lets the WebView dismiss its keyboard. Copying, returning to the
latest message, and closing a reading overlay do not restore input focus.
Swipes, links and other controls keep their own behavior. Keyboard geometry
and safe-area adaptation remain independent of focus.
Companion enables the existing `@capacitor/app` 8.1.1 Back handler while mounted:
Android Back closes its active menu, popover, popup, Photo Browser or sidebar
before returning to the chat;
at the chat root it minimizes the app. Unmount removes the listener and restores
the shell's disabled handler. Capacitor 8's built-in `SystemBars` synchronizes
status/navigation icon contrast with the selected appearance; no additional
status-bar plugin or APK rebuild is needed for this integration.

The chat uses Framework7's Svelte `Page`, `PageContent`, `Messages` and `Message`
components. Each text, image and voice segment is a separate message bubble;
segments retain their business-message identity, source, time and pending state.
Grouping uses the official Svelte demo's `first`, `last` and `tail` properties.
Framework7 `Messagebar` owns textarea growth and the scroll area's bottom padding.
Its attachment components show pending images; toolbar slots contain attachment,
microphone and send controls. Text grows up to the configured 144-pixel limit
before scrolling. Voice capture keeps the existing draft and attachments,
disables send, and offers cancel at the attachment control and stop at the
microphone. Recognition inserts at the captured selection for review and manual
sending; it never sends by itself. Recognition inserts only the transcript text;
provider emotion annotations are ignored. The left sidebar supports Framework7
swipe-to-close. A small down-arrow button returns readers to the latest message.
Viewport adaptation retains scroll position while
reading and follows content or viewport resizing only when already near the end.
Opening the chat and returning to the foreground show the latest message.
Capacitor App `resume` covers native activity resumes and browser visibility
changes; Framework7 Messages performs the scroll without focusing the composer.

Long-press a completed message from either participant to open the official
Framework7 Actions popover anchored to the message or image on mobile and desktop.
Desktop supports left-button hold and right-click.
Framework7 `taphold` owns touch timing, movement cancellation and click suppression;
a mouse-only adapter opens the same popover and cancels on release or drag. Text
provides Copy and images provide Save, with a separate Cancel group; the action
list can grow with future message operations. Copy preserves the original
Markdown and shows brief feedback; scrolling and multitouch cancel the hold. Capacitor uses
`@capacitor/clipboard` 8.0.1, including when the server uses a plain HTTP LAN URL;
web browsers use the secure-context Clipboard API.

Message timestamps and pending status use Framework7 Message `textFooter` inside
the bubble; avatars retain the framework’s bottom alignment.

Native photo selection uses Capacitor Camera 8.2.3 gallery intake and reads the
returned originals into memory before creating drafts. Web browsers keep the
file picker. Native picker or read failures show a composer error; reselect an
unreadable photo to retry. Supported originals remain PNG, JPEG, WebP and GIF;
HEIC is rejected. The native shell must include the Camera plugin and be rebuilt
after `cap sync`.

Tap an image to open Framework7 Photo Browser. Mobile previews use almost the
full width and support pinch zoom and panning. Tap outside the displayed image
to close it. Long-press an image in the chat or preview to save the original:
browsers download it, and Capacitor saves to the application's **Lamplit** album.
The native shell must include `@capacitor-community/media` 9.1.0 for Capacitor 8
and be rebuilt after `cap sync`. Android uses the plugin's default application
album mode without broad gallery access. An iOS shell also needs
`NSPhotoLibraryUsageDescription` for album creation/access (and
`NSPhotoLibraryAddUsageDescription`); denied permission shows an error. CFL does
not enumerate the user's photos. When a save menu is open, the first outside tap
closes the menu; a subsequent outside tap closes the preview.

Sending a valid message immediately returns to the latest messages, before the
network request completes. The timeline follows when you are at the latest messages and preserves your
place when reading history. The floating **Latest messages ↓** button returns
to the bottom without changing drafts. Device acceptance limits are recorded in
the [operator guide](docs/operator-guide.md#mobile-keyboard-validation).

### Optional chat history search

Configure the Rust `flicklog` CLI and a ready, logged-in FlickLog daemon on the
Partner host. `FLICKLOG_BIN` selects the executable (default `flicklog` on PATH);
`FLICKLOG_DATA_DIR` optionally selects its existing account/device data directory.
CFL only invokes `search`, `get` and `context`, from the configured workspace.
It never starts a daemon, logs in, installs hooks or ingests automatically.
Before searching, explicitly ingest the desired Codex home with FlickLog; setting
`CODEX_HOME` on CFL does not choose the daemon's search source. FlickLog backs up
indexed bodies, including supported archived sources, independently of CFL.

Authenticated HTTP, shared App socket and Companion MCP use the same adapter.
Results use UUIDs and plain-text highlighted segments, up to 20 hits. The existing
`estimatedTotalHits` field carries Rust's exact total. Opening a selected result
checks its UUID/workspace and requests context with that exact ID. The configured
Rust daemon owns account/device/thread scope; context omits per-item provenance,
so CFL checks public ordinals, order, target consistency, eight records per side
and 12,000 Unicode code points. Selected text stays complete within the existing
2 MiB JSON transport limit. Search preserves the active conversation and draft.
Subprocess, unavailable-daemon and oversized-reply failures return ordinary errors
with retry; text chat stays connected. No Meilisearch credentials are required.

### Structured chat interfaces

The bundled Companion MCP registers `send_ui` for a standalone, display-focused
A2UI interface. The pinned, published App contracts provide the shared validator;
the selected frontend must match the pinned compiled contracts. The tool accepts
one validated A2UI 1.0 Candidate
surface, bounded to 16 KiB, 100 components and 16 levels. It supports display and
local interactions such as tabs and modals; it does not send user input or actions
back to the Partner. Successful completed tool results are projected as separate
messages from the official Codex turn, preserving item identity and recorded or
recoverable order through history. Failed or unfinished results do not create UI
messages. The selected compatible App must supply `/a2ui.html` and its assets for
the embedded renderer; CFL serves those resources from that verified App release.

### Partner alarms

The bundled Companion MCP exposes `create_alarm`, `list_alarms`, `edit_alarm`,
and `delete_alarm`. A Partner can write a message to herself for one future ISO
date and time, every 5 minutes or longer, or a daily or weekly time in an IANA
time zone. An alarm wakes the existing Codex conversation; it does not create a
second session or automatically send to the Keet conversation where it was
discussed. Its trigger appears on the left of the Companion timeline with a
distinct self-set alarm label, followed by the Partner's ordinary reply.

The top-left drawer has a read-only Auto wake tab showing each current alarm and
its next due time. Ask the Partner in chat to edit an alarm's message or cancel
it. Editing preserves its schedule and next due time; already admitted
reminders keep their original message. An occurrence up to and including 60
seconds late follows the normal admission flow. Strictly more than 60 seconds
late never starts Codex: a one-time alarm ends and disappears from the pending list; a recurring alarm advances to
its next future occurrence. This rule also applies after restart. Existing
occurrence receipts prevent duplicate admission, and editing or deleting a
definition never rewrites an admitted message. The Partner service must be
running to deliver an alarm on time. Browser notifications use the existing
generic completion notice when an open background Companion page has permission.

### Optional local pet

The animated companion pet is disabled by default. To enable it, add this to the Partner TOML and restart Partner:

```toml
[pet]
enabled = true
```

The browser receives only one of seven coarse activity labels, never model text, reasoning, command lines, paths, arguments, or results. The anonymous bundled placeholder is used until an operator installs private sheets in `<state>/pet-assets/`; see the [operator guide](docs/operator-guide.md#optional-local-pet). Pet artwork and runtime assets never belong in this repository.

### Optional ecosystem MCPs

Voice output settings select MiniMax, Alibaba, ByteDance, or ElevenLabs and
retain each provider's voice ID. MiniMax uses an authenticated local `mmx`
CLI; the other providers use separately saved output keys. ElevenLabs accepts a
manual voice ID or a paginated selection of voices saved to the account. Its
API key needs speech generation and voices-read permissions; usage may consume
account credits. The official SDK uses the fixed `eleven_v4` model and does not
retry generation automatically. See the [operator guide](docs/operator-guide.md).

On its first start, CFL creates the minimal workspace configuration: its bundled
Companion MCP and the relationship-context hook. No external MCP is needed to
start or use a Partner. To opt into FlickNote or Guion Web, copy the two tables
from [`apps/partner/ecosystem-mcp.example.toml`](apps/partner/ecosystem-mcp.example.toml)
into `<workspace>/.codex/config.toml` after that first start. The template's
comments give each service's installation and readiness steps.

On Android, use a supported browser or install the site as a PWA at its HTTPS origin.

### Optional Keet ingress

A Partner may receive KFA message events at `POST /api/keet/events`. Configure its
loopback KFA MCP endpoint and distinct stdin-managed `keet` and `keet_receiver` credentials, then
point KFA's `KEET_WEBHOOK_URL` at `http://127.0.0.1:<CFL port>/api/keet/events`
and set its `KEET_WEBHOOK_BEARER_TOKEN` to the same separate receiver secret.
The ingress requires this Bearer on every request, independently of browser sessions. Ordinary
Group messages are bounded context until CFL classifies a trigger, each DM starts
a turn, and Broadcast messages start none. KFA supplies required factual
`addressing: { mentionsIdentity, replyToIdentity?, identityLabel? }`; the obsolete
wire `trigger` field is rejected. A native identity mention takes precedence over
a case-sensitive identity-label literal match, then a verified identity reply,
then a configured alias match. Unknown reply ownership is omitted and never
promotes a turn. Label and alias matches require nonblank Group text. Pure-image and captioned DM images are fetched
from KFA with the existing bearer and attached to native input. Unavailable
images are reported in the input without dropping the message. Group images
remain context only. Group and DM messages may include a bounded
snapshot of aggregate external reactions to the Partner's recent Keet messages.
CFL displays qualifying Keet messages in the Companion timeline with their
original text, DM or Group kind, sender label, and destination, including after
reload, reconnect, restart and paginated history in the shared App. DM images use
the existing authenticated media contract; Group images show their native
availability explanation without attached bytes. Model/group/reaction context
stays private, and web submissions cannot forge Keet attribution. Optional
`[keet]` `trusted_groups` names designate ordinary
shared conversations; `trigger_aliases` such as `shio` and `汐` add case-sensitive
literal Group text triggers. Both lists use exact configured strings and take
effect after restart. Trusted Groups still wait for a trigger, and Keet sources
never inherit the web Human's administrative authority.

CFL supplies each new destination, target, emoji, and count fact as bounded
untrusted context on accepted turns at most once; a changed count can appear again.
KFA supplies reaction facts independently of turn classification, so alias turns
can consume them too. CFL ignores facts on ordinary Group events; Broadcasts
have no reaction snapshot. Reaction changes alone do not start a turn, and CFL never
automatically replies or reacts.
For a chosen response, Keet MCP `send_message` requires text and can also
request one emoji reaction to a known Group message or this DM turn's trigger.
Its result reports text delivery separately from reaction success. See the
[operator guide](docs/operator-guide.md#optional-keet-ingress).

### Optional Post QQ / Matrix integration

Configure one `[post]` endpoint and `agent_id`, then provision independent
`post` (agent API) and `post_receiver` credentials with the existing stdin-only
credential command. Post owns platform credentials, admission and wake policy.
CFL validates authenticated versioned deliveries at `/api/post/events`, commits
receipt/provenance/pending input before ACK, and feeds both platforms into the
existing Partner/app-server thread. Images use existing native attachments;
files and audio/video retain Post references. The Partner can choose to reply
to an admitted conversation through Post MCP without a separate human instruction;
Post checks the actual send authorization. CFL does not automatically forward
the final answer to Post.

Post account discovery runs at startup. When a delivery names an account/platform
missing from that map, CFL checks the same configured Post MCP with its private
agent credential before recording a receipt. A newly authorized account can
therefore deliver without restarting CFL. Known matching accounts reuse the map;
this is not periodic grant or credential revocation polling. Malformed or
cross-agent events fail validation before discovery. A successful lookup that
still does not list the account/platform returns 422; an unavailable or unusable
lookup returns retryable 503 without a receipt. Retry the same immutable delivery,
not a new delivery ID. Concurrent misses share one bounded lookup, and shutdown
cancels and settles in-flight discovery before closing storage.

Before submitting accepted Post work to the native turn, CFL reads authenticated
`list_conversations` pages for the source account, bounded to ten pages, 100 items
per page and five seconds. The account, conversation, native ID and group/direct
type must match the retained event. The exact current name is untrusted external
data alongside the separate sender name. Missing, revoked, failed, mismatched or
out-of-budget lookups yield `null` and do not prevent an otherwise valid turn.
Receipt ACK does not wait for this optional lookup. Conversation tools use the
exact current name; names do not grant access. Post rejects ambiguous selections.

Accepted Post message headers show platform, group/direct type, current
conversation name when verified, and sender display name. An unavailable current
name is labeled as such rather than using the captured name as a target. Routing
IDs remain in structured metadata. Existing history and pending recovery text
are not rewritten.

The shared chat projects retained Post deliveries as their own QQ/Matrix source,
with group/direct attribution, original content, stored media and source time.
Genuine captured conversation and sender names are display data; a direct peer
may use the sender name only when their native identities match. Historical
absent names remain unknown with ID fallback. Chat refresh and history read this
retained provenance without remote metadata lookups or rewriting native history.

The existing stderr journal records finite `post.receiver` HTTP status,
`post.ingress` validation/account/receipt/retained stages, `post.execution`
native-start outcomes and `post.tool` send categories. These records include
only validated platform/group/direct enums and fixed status/category values;
they contain no message text, names, routing IDs, tokens, URLs or raw tool errors.
A retained receipt does not prove native execution or successful outbound send.

One native `post` MCP declaration provides account/conversation/member/history
reads, asset metadata and explicit send actions. Terminal `asset-upload` and
`asset-fetch` helpers transfer bounded bytes with private API authentication.
The endpoint must be a bare loopback HTTP or HTTPS origin. A separate receiver
Bearer is required even on loopback. Historical Matrix source display and Keet
remain available; the old Matrix endpoint/config/credential/CLI are removed.

See the [Post operator contract](docs/operator-guide.md#optional-post-qq--matrix-integration)
and [reviewed cutover procedure](docs/post-v1-cutover.md). Preparation and tests
do not deploy or establish actual QQ/Matrix interoperability.

## Roadmap

CFL is already where Shio lives, but it is not finished. Next directions include:

- **Keet P2P chat and identity**, so companions can talk privately with people and other agents without a central messaging service
- **More natural speech**, including additional MiniMax voice controls
- **User-configured activities**, where a companion can choose from skill-backed things to do rather than only waiting for a prompt
- **Persona creation and review tools**, to help people create a companion without reducing them to a list of traits

The direction is companion autonomy without hidden automation, and continuity without turning a relationship into a fixed memory graph.

## From source

Use Node 24 and the pnpm version pinned in [`package.json`](package.json):

```bash
pnpm --config.verify-deps-before-run=false source:prepare
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm --filter @lamplitisles/partner start -- /path/to/partner.toml
```

Development and tests must use fresh, test-owned workspaces. Do not point them at a real companion workspace or copy existing credentials and conversations into the repository.

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Architecture decision: Codex app-server](docs/adr/0001-codex-app-server.md)
- [Compaction boundaries](docs/adr/0002-preserve-text-history-with-native-compaction-boundaries.md)
- [Relationship journal and companion tools](docs/adr/0003-workspace-companion-tools-and-relationship-journal.md)
- [DSH session migration](docs/dsh-session-migration.md)
- [Imported source and licenses](docs/IMPORTS.md)

## License

[Apache License 2.0](LICENSE). Imported components and their retained licenses are listed in [`docs/IMPORTS.md`](docs/IMPORTS.md).

## Default shared Lamplit App

The default standalone entry `/` serves the approved shared Framework7 App.
`/chat` serves identical HTML with root-relative `/assets/*` and `/icons/*` URLs.
There is no `/slice` entry, UI fallback or asset-directory environment override.
Platform owns hosted authentication, manifest, service worker and management;
CFL does not register a service worker or serve management routes.

CFL obtains App archives from Forgejo generic packages. It pins the published
App commit in `lamplit-app.sha` and independently pins
its public contract archive digest in `lamplit-contracts.sha256`. Preparation
verifies both, exports, licenses and the protocol marker before frozen CFL
installation. App owns its own build and tests; CFL needs neither an App checkout
nor Bun. When updating the pin, independently verify the published archive and
update the dependency lock deliberately if its metadata changes.

`pnpm build` verifies the prepared contracts. Optional main packaging includes
the runtime and contracts using its explicit Rolldown dependency, licenses and
`vendor/source.json` (contracts and prepared license hashes), but no browser
resources. At startup CFL prepares the selected App separately and verifies its
compiled contracts against the runtime. `latest` resolves Forgejo App `main` at
each startup and fails if that revision's package is unavailable; a complete
verified cache selected by full SHA can be used offline.
See [source preparation and isolated acceptance](docs/default-shared-frontend.md)
for complete artifacts and the verification boundary.

The shared chat sends no idle heartbeat. Observed transport failure attempts an
immediate reconnect; failed attempts back off. Network/foreground hints and user
recovery can interrupt that wait and coalesce an in-flight attempt. Readiness
requires a valid snapshot and subscription. A silent lost connection may delay
new replies until communication or recovery; unknown submissions retain their
original receipt IDs and are never automatically resent. Policy closure requires
explicit recovery. CFL deployment is held for spec #4621; candidate verification
does not update any running instance.

`GET /api/chat/appearance` supplies the configured name, avatars and horizontal/vertical
backgrounds to the shared UI. Successful replies end quietly; failure and stop notices
remain visible. Text and selected images appear immediately as normal outgoing bubbles, before
upload or receipt. Offline sends retain the draft. Definite failure before durable
admission leaves a failed bubble with direct Retry/Delete actions; newer draft text
and images stay intact. Expired dispatched input requests durable finalization;
missing proof stays pending. Retry uses the server's original text/image bytes
under a new attempt identity. Delete confirms removal of the failed presentation,
retaining its rejection fence across reopen. Ambiguous delivery is reconciled
without automatic replay. Independent native withdrawal still offers recovery.
See [submission semantics and immutable acceptance](docs/native-durable-submissions.md).

The official app-server remains the sole execution/history owner. Completed
message IDs are presentation metadata; no reply text is duplicated in a new
transcript. Each completed agent message, including commentary, becomes visible
while the turn continues. Current answer text grows from official agent-message
increments as a transient preview; reasoning, tool payloads and unfinished
commentary remain private. The default Reply display preference splits answers
at source LF/CRLF boundaries, keeping lists and other Markdown structures intact.
Each displayed unit has its original source time/avatar and copies only its own
source; Whole reply restores the entire answer and full-source Copy. This display
preference creates no additional transcript records or notifications.
Typing ends with the exact completed body when the current native answer item
explicitly completes with phase `final_answer`. CFL publishes
`replyCompletedTurnId` with that body and no preview; the turn remains active
and cancellable during native cleanup. Commentary and phase-less messages do
not establish finality. When a provider omits the phase, typing continues until
the native turn ends. Completion evidence is transient, scoped to the current
turn, and omitted after stop/failure, replacement or Partner restart.
Closing the last page stops observation only. Reconnecting reads the same active
Partner partial without restarting execution. Completion replaces that preview
with the official completed message; stop/failure/session change removes it and
late deltas cannot restore it. SDK transport/process restart does not automatically
replay a turn or restore unpersisted tokens; only retained official history can
be recovered. Sending ends when CFL
commits the validated input, attachment metadata and immutable operation identity
together in SQLite. The `submitted` receipt means the input is retained; native
start/steer and history reconciliation continue independently. It does not
promise exactly-once Codex execution. Native activity drives typing before
reply completion, and official user items establish consumption. Reconnect
lookup and same-operation retries recover the saved receipt without resubmitting
ambiguous native input. Lookup returns `null` while no definitive result exists; it never authorizes recovery or replay. Failure and stop produce independent timeline
notices; successful replies end quietly. Completed messages survive reconnect and restart.
Browser origins must match the configured canonical origin, and browser access requires a Passkey session. See [shared frontend preparation](docs/default-shared-frontend.md) for build and
connection commands.

The ordered chat projection records only the session, turn, native item identity,
kind and observed start position in the Partner's existing SQLite store. Text,
media and execution remain owned by native history and existing attachment
storage. An image started during an active turn has a stable slot; completion or
failure updates that slot while later voice messages remain independently usable.
If an observed image start survives but the native item is absent after restart,
its state is unknown. Starts missed while CFL is offline cannot be reconstructed;
items without a recorded start retain their relative native history order. Apart
from the initial input, they follow recorded slots when both exist; their original
interleaving with recorded starts is unknown. No old conversation is migrated. Authenticated timeline
changes prompt clients to update a known item or reconcile their loaded history;
reconnecting clients reconcile again. Active answer text grows in its existing
message slot with `textState: 'streaming'` and the same native item ID; completion
sets `textState: 'complete'`. The optional `streamingReply` is omitted when the
matching timeline slot is present.

Image uploads echo each draft ID and order with its validated resource reference.
For a manually retried failed image submission, the receipt exposes the verified
source-to-attempt attachment mapping, including through lookup and finalization.
An unbound attempt remains unknown and is never automatically resent. The new
shared contract must be published and pinned before the standard CFL release
build; local source-based checks are not release artifact provenance.

The app owns the public TypeScript/TypeBox schemas. CFL implements six bounded
reads on `lamplit.chat.v2` over that same connection:

| Read | Native authority | Bound |
| --- | --- | --- |
| `relationship` | Workspace relationship JSONL journal | Current state and opaque workspace scope |
| `relationshipHistory` | Same journal | 20 newest-first records, next cursor and complete older predecessor |
| `diaryList` / `diaryRead` | `memory/YYYY-MM-DD.md` | 30 date names; found/missing/too-large with 128 KiB UTF-8 limit |
| `album` | Registered conversation-image catalogue | 30 records, stable descending created time and binary ID |
| `reminders` | Existing SQLite alarm definitions | At most 100 pending definitions |

Each call requires the selected `sessionId`; it cannot select another conversation.
Signed opaque cursors are bound to the method and selected session, and expire
when the host restarts. App schemas validate both request and response at runtime.
A failed panel call returns a recoverable error; chat and voice remain usable.
Opening a panel does not start a turn. Relationship history paging cannot replace
the current relationship with an older state. Native MCP writes are visible on
refresh without a second relationship store.

Diary reads reject traversal, symbolic-link files and memory directories escaping
the workspace. Reads use a no-follow file handle and enforce byte limits before
and during reading. Companion MCP offers `list_diary` (30 names), `read_diary`,
and cursor-based `read_relationship_history` (up to 20 records plus predecessor),
as well as the existing bounded `list_photos` and `list_alarms`.

Album metadata contains opaque IDs and same-origin `/api/conversation-images/`
URLs, with no filesystem paths. Preview and original use the existing image byte
route; missing files remain visible as unavailable. The catalogue is reconciled
against official conversation membership; viewing an arbitrary local file with a
native tool does not register it. There is no thumbnail pipeline or new media store.
HTTP API reads reject foreign origins and cross-site browser requests. Browser sessions and native access tokens are checked on HTTP requests, WebSocket admission and chat calls; recovery and logout terminate revoked connections.

Reminder schedules retain native once/daily/weekly meanings, UTC epoch-ms
`nextAt`, IANA zones and Sunday-zero weekdays. CFL's native interval minimum is
five whole minutes; public `everySeconds` is `everyMinutes * 60` and `anchor` is
the persisted creation time, including pre-1970 anchors. The public adapter does
not change scheduling. Stored native `alarm:<id>:<due-ms>` input metadata supplies
`source: { kind: "reminder", reminderId, occurrenceId }` in live views and history,
so the app shows incoming **App reminder** messages rather than human input.

For local verification, use Node 24 and the pinned pnpm from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
node --test apps/partner/tests/panels.test.ts
```

Native verification uses the approved frozen App artifact, actual Node/Partner
storage and fake loopback execution/speech. Search adds an unchanged Rust FlickLog
release artifact, an owned foreground daemon and synthetic ingest. Follow
[the current handoff](docs/default-shared-frontend.md) for exact commands,
manifest checks and limitations. Historical slice artifacts remain evidence;
they are not the current route or build workflow.

### Streaming voice input

The shared app reads `/api/voice/capability` and records through the same-origin
`/api/voice/stream` WebSocket. Authenticated owners can configure streaming voice
through same-origin `GET /api/voice/settings` and `POST /api/voice/settings`.
GET returns `{region: "beijing" | "singapore", configured: boolean}`; POST takes
strict JSON `{region, apiKey}` and returns the confirmed public snapshot. Keys
are never returned. Responses are `no-store`. An empty key retains the current
key only when the region is unchanged and already configured; switching regions
requires a new matching key. Key validity at the provider is checked on recording,
not on save. Settings support is independent of recording availability.

UI settings work without `[speech]` and persist region/key together in private
`state/voice-settings.json` (0600), separate from CLI credentials. Before the first
UI save, `[speech]` plus the CLI `speech` credential continues to enable Beijing
streaming. Legacy `speech.endpoint` values are accepted and ignored, regardless
of their type or contents; no configuration rewrite is needed. Alibaba TTS and
CLI credential behavior remain independent. Streaming uses only the fixed
Beijing or Singapore DashScope endpoint with `qwen-audio-3.1-asr-flash-streaming`. The fixed regional
origins remain documented as [legacy general endpoints](https://help.aliyun.com/zh/model-studio/sdk-selection-and-download).

Each recording captures one region/key pair; saves affect future connections.
Concurrent writers receive 409; storage errors receive 503. After an ambiguous
save failure, refresh settings before explicitly retrying; do not replay writes.
Updates use a nonblocking OS lock on `voice-settings.json.lock`, a private
temporary file, fsync and atomic rename. Process exit releases the lock
automatically; the persistent lock file must not be removed while writers run.
The lock binding resolves the host process C runtime only when saving, without
a glibc library-name requirement. If binding initialization fails, saves return
503 while settings reads and existing voice selection remain usable.
An interrupted write leaves either the prior or complete new record; a private
orphan temporary file can be removed after stopping writers. Invalid or permissive
saved state fails closed rather than resetting to CLI credentials. No secret validation request is sent during configuration.

Audio streams as mono PCM16 LE at 16 kHz, up to five minutes/9,600,000 bytes,
with frames up to 16 KiB and bounded provider buffering. Only finalized sentences
are returned after Finish, ordered by sentence ID with replacement of duplicate
finals. The result enters an editable draft; it creates no Codex turn until Send.
Cancel, disconnect, errors, timeouts and server shutdown release the provider
connection. Audio and unsent transcripts are transient. Shared runtime validation
comes from `@lamplit/contracts/voice`. Voice input uses streaming exclusively;
the former whole-audio transcription endpoint has been removed.

### Workspace images in Partner replies

Partner reply Markdown can display PNG, JPEG, WebP and GIF references to files
in the execution workspace. Relative references resolve against the configured
workspace; absolute references must remain inside it after symlink resolution.
The authenticated `GET /api/chat/workspace-image?path=<encoded literal path>`
endpoint reads the current regular file on every request, up to 20 MiB, and
validates its image bytes. Responses use `no-store` and `nosniff`. Existing API
authorization and same-origin checks apply to each request. Unavailable images
show an unavailable state with Retry in the shared App.

These are live references: reopening history may show changed bytes or an
unavailable file. They do not copy files, retain snapshots, or add images to the
Chat Image Library. Markdown URI decoding happens once in the App; the endpoint
uses the query-decoded path literally, preserving filenames containing `%20`.

### Workspace audio and video

The authenticated, same-origin `GET /api/chat/workspace-media?kind=audio|video&path=<encoded literal path>`
reads a regular file from the configured execution workspace. Supply exactly one
`kind` and one `path`; query decoding occurs once, so a filename containing the
literal characters `%20` remains literal after URL query decoding. Like workspace
images, these are live references: changing or deleting the file affects later
reads and historical messages. CFL does not copy the file or create a database record.

The endpoint accepts WAV (`.wav`, RIFF/WAVE with format and data chunks), MP3
(`.mp3`, MPEG Layer III frames with optional bounded ID3), and MP4 (`.mp4`,
recognized ISO BMFF brands with a checked video track, sample tables and media
data). Video sample entries are limited to `avc1`, `avc3`, `hvc1`, `hev1`,
`mp4v`, `vp09` and `av01`. If no video track has both samples and chunk offsets,
the file must have matching fragment track and run metadata. Inspection is
limited to 4,096 boxes. Other valid MP4 variants may be
rejected, and acceptance does not guarantee that a client can decode the file.
It checks the container signature and structure, not complete media decoding.
Files are limited to 256 MiB and streamed in chunks of at most 64 KiB, with at
most four concurrent workspace media responses. Escaping paths, non-regular
files, unrecognized formats and over-limit files are unavailable. Responses use
`private, no-store` and
`nosniff`; authorization and file identity are checked throughout streaming.

A full response is `200` with `Content-Length`; a single byte range, including
open-ended or suffix ranges, is `206` with `Content-Range` and `Content-Length`.
Invalid, multiple or unsatisfiable ranges return `416` and `Content-Range: bytes */<size>`.
The response includes a weak `ETag` and an opaque `X-CFL-Media-Version` based on
the open file's device, inode, size, modification time and change time. Clients
combining ranges must send the first response's version as
`If-CFL-Media-Version` on every subsequent request; a changed version returns
`412` with no media body. `If-None-Match` supports weak comparison; `If-Range`
cannot use this weak validator and falls back to a complete `200`. Cancellation,
authorization loss or a detected file change stops an active response. This
metadata version is not a content hash: its consistency depends on the filesystem
updating these identity and timestamp fields correctly and cannot defend against
privileged storage manipulation or extreme metadata reuse.

The pinned App contract supplies the workspace media references. Actual iOS
WebKit playback still requires device validation.

### Shared image sending and recovery

The shared slice accepts PNG/JPEG/WebP/GIF: six images, 5 MiB each, 20 MiB
original bytes total and 160-character filenames. It serves existing generated
originals up to 32 MiB independently of intake limits. Preview/model uploads keep
the common 160,000/320,000-byte JPEG bounds. Native execution receives the original
bytes, including image-only messages and active-turn steering.

Authenticated `POST /api/chat/images` stages an immutable ordered upload under
this Partner session and operation UUID, returning each draft's `id` and `order`
with its operation-owned `ref`. Upload does not admit a message or add
album membership. `/api/chat/socket` submit binds text, ordered references and
replacement IDs atomically to native admission. Exact retries reconcile without
execution; changed identity, incomplete references and foreign operations fail.
Authenticated `GET /api/chat/media/{id}/{original|preview|model}` returns `no-store`
media or a visible missing result. Native-origin originals need no uploaded variants.

Recovery refreshes official history and exposes only confirmed recoverable text/images.
Definite rolled-back admission returns `failed`; a durably received input remains
`submitted` after a verified native rejection or pre-processing withdrawal and may
offer recovery. Internal errors, lost responses and unresolved native input never
create a recovery offer. Replies fail or stop independently of submission. Failed web
messages use direct Retry/Delete, without restoring Composer input. Missing original
bytes block the whole retry; deletion remains available. Independent withdrawal
recovery still supports restore/edit with a fresh UUID and eligible sources;
consumed/replaced/deleted inputs cannot return.
The shared App at `/` uses these native routes.

See [the shared image protocol and isolated acceptance recipe](docs/image-send-recovery.md).


### Quiet native compaction

The default shared UI keeps manual and automatic successful compaction silent: no completed status, toast or timeline boundary. Running and
failure feedback remain visible. Official compact records remain available for
continuation and conversation search. The native Framework7 composer and its
72px attachments/44px removal targets remain the layout baseline; the earlier
full Composer/96px attachment mockup is superseded.

The shared view carries session-owned `contextUsage: { tokens, capacity }`, with
nullable values, and `compaction: null | { id, status }`. Current usage comes only
from native `thread/tokenUsage/updated` `last.totalTokens` and
`modelContextWindow`, never cumulative billing. Missing/invalid usage displays
zero quietly. Completion clears old tokens and retains known capacity until
fresh native usage arrives; fresh usage in a complete snapshot stays visible.

`compact({ sessionId })` returns `{ sessionId, accepted }`; a true result means
native admission. The adapter rechecks authorization, session and native
idle/pending/recovery guards after asynchronous prerequisites. Busy work is
refused without a compact queue. Exact bare `/compact` uses this operation and
cannot enter ordinary submit; images refuse and retain the editable selection.
Lost replies and reconnects reconcile observations without automatic replay.

Current native compaction, image/recovery and panel runners use canonical `/`
and the approved full artifact. See [current acceptance commands](docs/default-shared-frontend.md).
Controls are test-only entry points, absent from production routing; native quiet
compaction behavior and the five-minute reminder interval remain unchanged.

### Shared conversation-search acceptance

Current search acceptance uses actual `createConversationSearch`, unchanged
Rust FlickLog release artifact, an owned foreground daemon, synthetic session/config,
a loopback HTTP fake and explicitly ingested test-owned Codex rollouts. Controls
delay/fail delivery while public responses come from the native Rust daemon. Rust-format CLI fixtures remain unit-test seams, not native
acceptance evidence. See [current acceptance commands](docs/default-shared-frontend.md).
Reading archives preserves the active conversation and draft; native matching,
workspace/device scope and context limits remain unchanged.

## Sticker library

CFL's authenticated sticker backend supplies a shared library with separate
Human and Partner favorites. The public HTTP contract is defined by the App source identified
in `lamplit-app.sha`; the frontend must be published before an installed runtime can select it.

Import an administrator-selected directory with the installed CLI:

```sh
codex-for-love import-stickers <config.toml> <directory>
```

The directory is flat and contains `manifest.json` and exactly the named files:

```json
{
  "id": "cats",
  "name": "Cats",
  "description": "Small reactions",
  "stickers": [
    { "id": "hello", "file": "hello.gif", "name": "Hello", "tags": ["wave"] },
    { "id": "happy", "file": "happy.png", "name": "Happy", "tags": ["smile"] }
  ]
}
```

The first entry is the cover and is also sendable. Pack and member IDs use
ASCII letters, digits, `_` or `-` (1–100 characters); each public sticker ID
is derived from its pack and member ID. The same manifest format is accepted
by authenticated `POST /api/stickers/imports?sessionId=...` as a ZIP. Imports
are validated before the index transaction: only flat regular files, no links,
duplicate paths or undeclared entries; at most 500 images, 32 MiB compressed,
64 MiB expanded, 5 MiB per image, 25 million total frame pixels and 100 frames
per image. ZIP reading has a 15-second limit, individual image operations a
5-second limit, and pack validation checks a 30-second deadline between images. Import errors distinguish invalid content, limits, processing timeout,
and storage failure without exposing local paths. JPEG, PNG, WebP and GIF
signatures and decoded contents must match. Internal staged preview and model representations are static JPEGs; GIF originals remain
animated. An identical member ID may acquire a new immutable content version on
reimport. Concurrent conflicting imports reject the stale change; identical
retries are idempotent. Existing favorites follow the member; already sent
messages and their original bytes retain their previous version. Removing a member does not delete
its historical asset or the other participant's favorites.

`/api/stickers/packs`, `/packs/{id}`, `/search`, and `/favorites` provide
bounded pages; `/favorites`, `/favorites/image`, and `/favorites/upload`
modify the authenticated Human's collection. `/stage` binds a sticker ID and
version to a session and operation, returning the existing image reference for
the normal durable chat submission. `/media/{version}/thumbnail` returns a static
WebP first frame, preserving alpha, at most 512 pixels on its longest side without
enlargement and at most 160,000 bytes. It is generated on demand from the
hash-verified original, including for existing assets. Each catalog instance reuses a
bounded in-memory thumbnail cache, with no thumbnail files stored; every request
still reads and verifies the original before using a cached result. `/thumbnail`
and `/original` require owner authentication and use private,
revalidated ETags based on the response bytes. Clients may show an identity-isolated
cached thumbnail while revalidating, and must discard it on authentication failure,
forbidden or missing responses. The selected App frontend must match the pinned
public contracts. The Partner
uses the separate Companion MCP sticker tools. A conversation image can be
favorited only after it belongs to that conversation; imports and favorites do
not themselves create chat messages or photo-library membership.
Companion's `inspect_sticker` reads the current image without sending it or
changing favorites. It returns JPEG frames in playback order; animations are
sampled at up to six frames, so content between samples may be missed. Frame
indices in `sampledFrames` are zero-based. `send_sticker` remains the separate
sending action. `update_sticker_metadata` changes the shared name and/or tags
for any existing sticker, immediately affecting both participants' browsing
and search. Reimporting the original pack overwrites those edits with its
manifest values; editing metadata does not modify the manifest or image bytes.
When both participants favorite the same conversation image or identical upload,
they share one sticker and its first saved name and tags. Later favorite requests
return that saved metadata; each participant can remove their own favorite
independently. A conversation image identity cannot be reused for different bytes.

The index and immutable files live in `<workspace>/.lamplit/stickers/`;
message attachments remain under `.lamplit/attachments/`. Back up the entire
`.lamplit` tree consistently with the running Partner stopped or using a
SQLite-consistent backup including WAL state. Plan space for original files,
JPEG variants, retained versions, SQLite and import temporaries. The importer
may leave unreferenced immutable files after a failed transaction; there is no
automatic cleanup, since deleting referenced versions would break history.
Never expose this directory as static web content. No live provider, production
deployment or App UI is enabled by these contracts alone.

## Local frontend development fixture

This is a synthetic, unauthenticated loopback-only development host, not an
installation. It uses the real Partner HTTP/WebSocket routes and a fake Codex;
replies labelled `【模拟回复】` are scripted and say nothing about model behavior.
Do not expose it to a network or use real accounts, credentials, workspaces or
conversations. No external messaging service is configured. The sample includes
chat, A2UI cards with local tabs and dialogs, relationship history, diaries,
album images and reminders. A2UI interactions are local and do not send actions
to the fake model. It uses a fixed
clock fixed at 2026-10-02 12:00 UTC (20:00 in Asia/Shanghai), so sample
alarms do not fire during development. The browser uses its own clock and time
zone for dates; the conversation includes 03:59 and 04:00 Asia/Shanghai for
the chat-day boundary. Fake Codex does not provide real model, voice, image
generation or external service behavior. Sample photographs are bundled locally;
see [their provenance](docs/IMPORTS.md#frontend-development-photographs).
The synthetic companion uses a bundled portrait; no user avatar is configured.
On startup, the fixture copies it into `.lamplit/profile/development-companion.jpg`
inside its workspace only if that file is missing. An existing file is preserved,
so an older fixture gets the sample on restart without resetting conversation data.

Use Node 24 and the pinned pnpm; prepare contracts and install dependencies as
described in [shared frontend preparation](docs/default-shared-frontend.md).
From this checkout run:

```sh
pnpm frontend:fixture start        # 127.0.0.1:3090; optional port argument
# In a compatible lamplit-app checkout, with its own dependencies installed:
CHAT_BACKEND=http://127.0.0.1:3090 bun run dev
```

App's existing Vite `/api` HTTP and WebSocket proxy supplies the connection;
choose unused loopback ports and ensure the App contracts match `lamplit-app.sha`.
The state and synthetic workspace are under the ignored
`.scratch/frontend-development-fixture/state`. Normal stop and restart retain
changes, including older fixture samples; new conversation and A2UI samples
appear only on first initialization or an explicit reset. With the host stopped,
`pnpm frontend:fixture reset` removes only the verified fixture data; the next start recreates the samples. Reset rejects an
active or unverified directory. A crash may leave `state/LOCK`: first verify the
recorded process and its fake server are no longer running, then remove that
lock directory manually before starting or resetting. An interrupted seed must
be explicitly reset. A failed or interrupted reset also blocks startup until
an explicit reset completes; it never silently accepts partially deleted data.
The temporary socket directory is independent of persistent
state; no production reset route is exposed.
