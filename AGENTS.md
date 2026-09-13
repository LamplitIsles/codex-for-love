# Codex for Love

Use Node 24 and the pnpm version pinned in package.json for this imported SvelteKit application. The current implementation spec is under `.scratch/codex-core/`. Work in this checkout, without worktrees.

Official Codex app-server owns execution, model history, queue, authentication and compaction. This application owns the Companion UI, STT, attachments and relationship state. Keep one execution owner; remove obsolete naco/DSH paths. Docker, migration and deployment cutover are outside this implementation.

Use test-owned workspaces and fake services for automated tests. Real local acceptance may use the authorized existing Codex login with Luna and a test persona; never copy credentials or existing conversations, and never send external messages as a test. Keep scratch and runtime state out of Git.

Update README for operator contracts and docs/IMPORTS.md for imported source attribution. Keep CONTEXT.md implementation-free. Preserve upstream licenses. The Owner maintains prompt semantics; the Implementation worker handles wiring and reports any needed prompt changes to the Owner.

## Standalone core workflow

- Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `pnpm test` from the repository root.
- For maintained Codex patches or custom compaction, follow README’s build and artifact-selection instructions; the pinned baseline is Codex 0.154.0. Use `pnpm run codex:build` for the resource-limited local build and verify the selected artifact with the isolated `test:real-sdk` probe before live acceptance.
- Run the Partner with `pnpm --filter @lamplitisles/partner start -- <config.toml>` after configuring the official Codex 0.154.0 executable and existing device-auth login.
- Use a fresh test-owned workspace and the fake app-server for automated tests. Do not use the real Codex home, credentials or external message side effects in tests.
- The official app-server is the execution owner. Do not reintroduce naco, Bridge model transport, custom imagegen/mail/skill wrappers, Docker, migration or cutover code.
- Keep `.scratch/`, `.lamplit/`, build output and runtime state out of Git. Preserve unrelated edits and update `docs/IMPORTS.md` when imported source attribution changes.
