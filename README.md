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
| Desktop and mobile | Use the complete companion experience in a browser or installed PWA, or through the released [Lamplit Mobile](https://github.com/LamplitIsles/lamplit-mobile) Android app |
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
- `.lamplit/attachments/` for stable image attachments
- `.lamplit/audio/` for generated speech cache
- `.lamplit/alarms.sqlite` for the Partner's current alarms
- `memory/YYYY-MM-DD.md` for optional, human-readable diary entries

The official Codex thread remains the conversation authority. CFL does not duplicate model transcripts, reasoning, or tool payloads into its own database. The workspace can be read, backed up, searched, corrected, and moved with ordinary local tools.

## Quick start

The CLI supports **Linux x64 and macOS Apple Silicon** and includes the matching standalone Codex app-server and code-mode host. It requires Node 24 and an existing official Codex login. This checkout's launcher checks that the installed native package matches the main package's exact pin before starting. CFL owns the app-server version contract; TOML configures the model and runtime options. This checkout pins Codex 0.159.1 native packages for both platforms.

### 1. Check the Codex login

```bash
codex login status
```

### 2. Install CFL

```bash
npm install -g @lamplitisles/codex-for-love
```

### 3. Create a companion

Copy [`apps/partner/config.example.toml`](apps/partner/config.example.toml) and [`apps/partner/persona.example.md`](apps/partner/persona.example.md) somewhere private. Update the name and paths in the TOML file, then run:

```bash
codex-for-love serve /path/to/partner.toml
```

CFL binds to `127.0.0.1` and prints the local URL. Use a fresh workspace for a new conversation.

On this development host, Shio production runs an isolated complete application artifact with its existing installed CFL native package. Application updates promote reviewed source builds through dev then prod, independently of npm application publication. See [Development-machine Partner environments](docs/development-environments.md) for the exact service and deployment commands.

Optional chat backgrounds are configured in the Partner TOML, separately from browser appearance preferences:

```toml
[backgrounds]
landscape = "./workspace/.lamplit/profile/background-landscape.jpg"
portrait = "./workspace/.lamplit/profile/background-portrait.jpg"
```

Supply both images or omit `[backgrounds]` to keep the default appearance. Paths resolve relative to the TOML file and must stay inside the workspace. Supported formats are PNG, JPEG, WebP and GIF, up to 20 MiB per file; invalid or missing configured files prevent startup. Restart Partner after changing paths or replacing images. Companion selects the composition from the window shape before the keyboard opens (square windows use portrait), scales it to fill the chat area and crops centrally. The background stays stationary as messages scroll, with a theme-colored soft overlay; message bubbles, attachments, header, composer and drawers retain their own surfaces. Background images do not enter conversation history or the Chat Image Library.

The Companion frontend uses Svelte 5, Vite and Framework7 9.2.0. Framework7 owns
component styles, theme tokens, its app/view shell and Photo Browser navigation;
SvelteKit, Tailwind and daisyUI are removed. Sidebar, settings and search use
the official Svelte Panel, Popover and Popup components. Framework7 owns their
instances, visibility and backdrops. Sidebar closing uses the supported
nonanimated path so input remains reachable even without a transition-end event.
The Node HTTP/SSE host remains the backend. Reloading a transient Photo Browser
URL opens the chat page.

The Companion header’s settings button changes language and appearance immediately without changing the conversation. These choices are browser-local preferences, not settings stored in the Partner configuration or workspace.

Browser site settings own notification permission; Companion has no notification switch and does not request permission on sending a message. This requires HTTPS, `http://localhost`, or a `http://*.localhost` address such as `http://prod-lamplit.localhost:17480`; a plain HTTP LAN address cannot use browser notifications. When permission is granted, an open page that is hidden or unfocused announces each newly completed Partner turn once, including when a PWA window loses focus to another app. Notifications contain the Partner name and a generic new-message notice, never reply content. This is page-local browser notification rather than Web Push: closing or suspending the page, losing its connection, or denying browser permission prevents delivery, and devices do not synchronize notification or read state.

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

Install and set up `flicklog` on the Partner host to enable the search button in
the Companion header. Search runs the FlickLog CLI in the Partner's configured
workspace, using the Partner's Codex home. FlickLog owns its rebuildable index;
CFL does not copy conversation history into its own database. Results are limited
to that workspace and show highlighted excerpts. Opening a result shows the
complete message or compaction summary and nearby context in the search panel,
without changing the active conversation or draft. The shared `/` reader
uses authenticated `lamplit.chat.v1.search` and `searchRead` socket methods backed
by the same configured helper as native HTTP. FlickLog matching, ranking, its
20-hit limit and estimated total remain unchanged; only `sessions` are scanned,
never `archived_sessions`. Context keeps native source indexes, up to eight
eligible chat/summary records per side and 12,000 Unicode code points. Selected
text stays complete when its reply fits the existing 2 MiB transport limit.
The same bounded search and record-reading capability is available to the companion through Companion MCP. Without FlickLog, the chat
still works, but search requests fail normally with the existing retry UI.
Native subprocess, lookup and oversized-reply failures use ordinary RPC errors;
they do not disconnect text chat or introduce new search status categories.
For a keyed external Meilisearch instance, provide `FLICKLOG_MEILI_URL` and
either `FLICKLOG_MEILI_KEY` or a systemd credential named `flicklog-meili-key`
to the Partner service. If its executable is not on the Partner process's
`PATH`, set `FLICKLOG_BIN` to its absolute path.

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

On its first start, CFL creates the minimal workspace configuration: its bundled
Companion MCP and the relationship-context hook. No external MCP is needed to
start or use a Partner. To opt into FlickNote or Guion Web, copy the two tables
from [`apps/partner/ecosystem-mcp.example.toml`](apps/partner/ecosystem-mcp.example.toml)
into `<workspace>/.codex/config.toml` after that first start. The template's
comments give each service's installation and readiness steps.

For Android, install the latest [Lamplit Mobile release](https://github.com/LamplitIsles/lamplit-mobile/releases/latest) and point it at the HTTP(S) address where CFL is available to the device.

### Optional Keet ingress

A Partner may receive KFA message events at `POST /api/keet/events`. Configure its
loopback KFA MCP endpoint and the existing stdin-managed `keet` credential, then
point KFA's `KEET_WEBHOOK_URL` at `http://127.0.0.1:<CFL port>/api/keet/events`
without a webhook Bearer token. The ingress accepts direct loopback peers only;
do not publish this unauthenticated route through a reverse proxy. Ordinary
Group messages are bounded context until a trigger, each DM starts a turn, and
Broadcast messages start none. Pure-image and captioned DM images are fetched
from KFA with the existing bearer and attached to native input. Unavailable
images are reported in the input without dropping the message. Group images
remain context only. Qualifying Group and DM messages may include a bounded
snapshot of aggregate external reactions to the Partner's recent Keet messages.
CFL displays qualifying Keet messages in the Companion timeline with their
original text, DM or Group kind, sender label, and destination, including after
reload and restart. Optional `[keet]` `trusted_groups` names designate ordinary
shared conversations; `trigger_aliases` such as `shio` and `汐` add case-sensitive
literal Group text triggers. Both lists use exact configured strings and take
effect after restart. Trusted Groups still wait for a trigger, and Keet sources
never inherit the web Human's administrative authority.

CFL supplies each new destination, target, emoji, and count fact as bounded
untrusted context at most once; a changed count can appear again. Alias-only
triggers may have no reaction snapshot because KFA sends it only for triggers
it classified itself. Reaction changes alone do not start a turn, and CFL never
automatically replies or reacts.
For a chosen response, Keet MCP `send_message` requires text and can also
request one emoji reaction to a known Group message or this DM turn's trigger.
Its result reports text delivery separately from reaction success. See the
[operator guide](docs/operator-guide.md#optional-keet-ingress).

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
pnpm source:prepare
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

CFL records the App commit in `lamplit-app.sha`. Keep `lamplit-app` adjacent to
this checkout, with Bun 1.3.14. `pnpm source:prepare` installs App's frozen lock,
generates localization, checks/builds/tests App, then materializes its browser
and compiled public contracts together. Local preparation permits edits and
records their identity; CI and formal candidates use `pnpm source:prepare --strict`
with clean App source at the recorded SHA. Then run CFL's frozen install,
check, build and test in order. Updating the SHA requires reviewing the resulting
joint checks; no npm publication or submodule is required.

`pnpm build` verifies the prepared resources and copies the browser into
`apps/partner/build`. Main packaging includes those resources, bundled runtime
and contracts, licenses and `vendor/source.json`; the installed CLI needs no
sibling checkout. Public GitHub source is retrieved at the exact recorded SHA.
See [source preparation and isolated acceptance](docs/default-shared-frontend.md)
for complete artifacts and the verification boundary.
`GET /api/chat/appearance` supplies the configured name, avatars and horizontal/vertical
backgrounds to the shared UI. Successful replies end quietly; failure and stop notices
remain visible. In-flight sends stay visible until their native message arrives,
without showing transient recovery controls.
See [current artifact and isolated acceptance](docs/default-shared-frontend.md).

The official app-server remains the sole execution/history owner. Completed
message IDs are presentation metadata; no reply text is duplicated in a new
transcript. Each completed agent message, including commentary, becomes visible
while the turn continues; unfinished text stays hidden. Input delivery follows
the native consumption receipt. Failure and stop produce independent timeline
notices; successful replies end quietly. Completed messages survive reconnect and restart.
Browser origins must match the host; existing gateway authentication
still applies. Use an independent development instance and do not publicly expose
an unauthenticated host. See `lamplit-app/docs/integration.md` for build and
connection commands.

The app owns the public TypeScript/TypeBox schemas. CFL implements six bounded
reads on `lamplit.chat.v1` over that same connection:

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
HTTP API reads reject foreign origins and cross-site browser requests. Embedders
may supply `createWebServer(..., { authorize })`; it is checked on HTTP requests,
WebSocket admission and every chat call/delivery, including after revocation.
The standalone host retains its existing trusted gateway boundary; the callback
is not a new login or multi-tenant system.

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

Current six-suite native verification uses the single frozen #3162 artifact,
actual Node/Partner storage and fake loopback execution/speech, plus unchanged
FlickLog source and a test-owned Meilisearch index. Follow
[the current handoff](docs/default-shared-frontend.md) for exact commands,
manifest checks and limitations. Historical slice artifacts remain evidence;
they are not the current route or build workflow.

### Streaming voice input

The shared app reads `/api/voice/capability` and records through the same-origin
`/api/voice/stream` WebSocket. Enable the existing `[speech]` configuration and
CLI-managed `speech` credential; no new credential is required. Missing speech
configuration or credentials disables recording while text chat remains usable.
The existing `speech.endpoint` configures the retained batch transcription API;
streaming uses DashScope's fixed WebSocket endpoint with
`qwen-audio-3.1-asr-flash-streaming` instead.

Audio streams as mono PCM16 LE at 16 kHz, up to five minutes/9,600,000 bytes,
with frames up to 16 KiB and bounded provider buffering. Only finalized sentences
are returned after Finish, ordered by sentence ID with replacement of duplicate
finals. The result enters an editable draft; it creates no Codex turn until Send.
Cancel, disconnect, errors, timeouts and server shutdown release the provider
connection. Audio and unsent transcripts are transient. Shared runtime validation
comes from `@lamplit/contracts/voice`. The retained native UI's batch transcription
endpoint remains independent.

### Shared image sending and recovery

The shared slice accepts PNG/JPEG/WebP/GIF: five images, 5 MiB each, 20 MiB
original bytes total and 160-character filenames. It serves existing generated
originals up to 32 MiB independently of intake limits. Preview/model uploads keep
the common 160,000/320,000-byte JPEG bounds. Native execution receives the original
bytes, including image-only messages and active-turn steering.

Authenticated `POST /api/chat/images` stages an immutable ordered upload under
this Partner session and operation UUID. Upload does not admit a message or add
album membership. `/api/chat/socket` submit binds text, ordered references and
replacement IDs atomically to native admission. Exact retries reconcile without
execution; changed identity, incomplete references and foreign operations fail.
Authenticated `GET /api/chat/media/{id}/{original|preview|model}` returns `no-store`
media or a visible missing result. Native-origin originals need no uploaded variants.

Recovery refreshes official history and exposes submitted text/images. Only a
verified app-server invalid-request rejection is eligible for replacement;
internal errors, lost responses, interruptions and unresolved native input remain
uncertain. Recovery never automatically executes. Restore/edit sends a fresh UUID
and replaces only eligible sources; consumed/replaced input cannot return. Missing
originals leave text editable and require explicit removal or a new selection.
The native frontend and its private routes remain available at `/`.

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
FlickLog source, a test-owned Meilisearch process and seeded test-owned Codex
rollouts. Controls delay/fail delivery while public responses come from the native
helper and index. The fake CLI matcher remains a unit-test seam, not native
acceptance evidence. See [current acceptance commands](docs/default-shared-frontend.md).
Reading archives preserves the active conversation and draft; native matching,
workspace/device scope and context limits remain unchanged.
