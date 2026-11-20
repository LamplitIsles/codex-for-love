# Codex for Love

Use Node 24 and the pnpm version pinned in package.json. Before frozen CFL
installation, prepare the published App contracts as described in
[contract preparation](docs/default-shared-frontend.md). CFL does not need an
App checkout, Bun, or App's own build and tests. Native acceptance consumes the separately approved
frozen artifacts as described in [submission acceptance](docs/native-durable-submissions.md).
Compiled public contracts come from the pinned App revision; the selected
frontend must match those contracts exactly. At runtime CFL downloads a
prebuilt App release; a verified cached full-SHA selection can start offline.
Task-specific implementation specs live under `.scratch/`. Work in
this checkout, without worktrees.

## Repository responsibilities

CFL owns backend orchestration, persistence, native execution integration,
consumption of App public contracts and resources, complete packaging and
deployment, including Companion integration, STT, attachments and relationship
state. lamplit-app owns shared UI implementation, visual and interaction behavior,
UI documentation and browser acceptance.

For an App pin refresh, default to the pin and necessary import attribution,
then verify the affected CFL consumption and release contracts. Reuse existing
passing evidence where unchanged and upstream UI evidence with its exact source
and artifact provenance; do not repeat unrelated checks. Add a
host integration regression only for a concrete host contract change or demonstrated
defect; existing backend fixtures remain valid. Keep task evidence in ignored
scratch and UI guides and browser matrices in App.

Official Codex app-server owns execution, model history, queue, authentication and compaction. Keep one execution owner; remove obsolete naco/DSH paths. Docker, generic migration and deployment cutover are outside this implementation; the explicitly authorized one-time converter for a user-supplied, already-compacted DSH log is the narrow exception documented by its task spec.

### Human message delivery model

Design message delivery around three internal states: sending, accepted by Codex,
and confirmed failed. Show an outgoing message immediately as a normal message;
only confirmed failure needs a failure indicator and retry or discard action.
CFL storing an input is not Codex acceptance. A lost response or timeout leaves
the outcome unknown; reconcile it without assuming failure or replaying an
unknown admission. A Codex queue acknowledgement alone does not prove that
the input was durably accepted. If stopping a turn definitively removes a queued
input before processing, treat that input as failed for retry or discard.

The originating frontend owns failed messages and retries the same message;
retain its local copy while needed to resolve delivery or until the user
discards it. After a reload during attachment upload, requiring the user to
select the original file again is acceptable. Do not add persistent CFL
failed-draft or recovery records solely to support retry. For each CFL SQLite
record, identify its necessary purpose, such as deduplication or data needed by
an active execution, and avoid duplicating Codex-owned history or queue state.
Treat this as the target model when changing delivery; existing behavior may
differ.

When an owner can browse a finite conversation-owned collection, Companion MCP must offer the Partner equivalent bounded discovery over the same membership. Material inspected with native tools must never be silently added to that collection.

For host-local Partner installation, deployment, acceptance, or recovery, read
[`docs/development-environments.md`](docs/development-environments.md) before
acting. It defines the canonical dev and production targets.

Agents may update and restart `codex-for-love-dev.service` from this checkout
whenever needed for in-scope development or UI validation. This authorization
is limited to its fixed dev configuration and port 3082; production remains
separately authorized.

Use test-owned workspaces and fake services for automated tests. Real local acceptance may use the authorized existing Codex login with Luna and a test persona; never copy credentials or existing conversations, and never send external messages as a test. Keep scratch and runtime state out of Git.

Update README for operator contracts and docs/IMPORTS.md for imported source attribution. Keep CONTEXT.md implementation-free. Preserve upstream licenses. The Owner maintains prompt semantics; the Implementation worker handles wiring and reports any needed prompt changes to the Owner.

## Standalone core workflow

Before changing the Codex release pin or verifying a CFL snapshot, read
[`skills/cfl-release/SKILL.md`](skills/cfl-release/SKILL.md).
The Woodpecker main-branch snapshot workflow publishes to Forgejo; it does not
install or deploy Shio.

- Build and publish native Codex in [`codex-build`](https://forgejo.n5.guion.io/LamplitIsles/codex-build). CFL pins and verifies its Linux x64 Forgejo Release and uses a private cache at startup.
- Prepare published contracts with `pnpm --config.verify-deps-before-run=false source:prepare` before `pnpm install --frozen-lockfile`. Choose local checks and tests for the changed behavior; build before tests that consume static artifacts. The complete `pnpm check`, `pnpm build`, and `pnpm test` sequence is available when warranted and remains part of the established CI/release gates, not a mandatory local rerun for every edit.
- Reuse relevant, attributable evidence. Do not repeat full suites, heavyweight builds, package smoke tests, or unchanged upstream tests after a passing run unless changed behavior, a failure, a concrete unresolved concern, an applicable release gate, or an explicit user request warrants it. For pin-only or documentation changes, use focused verification. Report interrupted or unrun checks accurately; a partial suite is not a full pass.
- Run the Partner with `pnpm --filter @lamplitisles/partner start -- <config.toml>` and an existing device-auth login. The installed launcher uses the release pin regardless of checkout-only executable configuration.
- Use a fresh test-owned workspace and the fake app-server for automated tests. Do not use the real Codex home, credentials or external message side effects in tests.
- The official app-server is the execution owner. Do not reintroduce naco, Bridge model transport, custom imagegen/mail/skill wrappers, Docker, generic migration or cutover code. The narrow one-time DSH compacted-log converter is an explicit current feature, not a generic migration framework.
- Keep `.scratch/`, `.lamplit/`, build output and runtime state out of Git. Preserve unrelated edits and update `docs/IMPORTS.md` when imported source attribution changes.

## Post integration

Post owns QQ/Matrix admission and wake policy. Consume the pinned v1 contract
attributed in `docs/IMPORTS.md`; coordinate public changes through both specs.
Keep one Partner/native thread and one Post MCP. Test with test-owned Post
HTTP/MCP and fake app-server fixtures; never use real platform tokens or sends.
The old Matrix configuration, environment override and webhook are retired;
retain historical Matrix provenance readers. Operator activation and rollback
follow `docs/post-v1-cutover.md`, owned by Orc after independent reviews.
