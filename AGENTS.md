# Codex for Love

Use Node 24 and the pnpm version pinned in package.json for this imported SvelteKit application. Task-specific implementation specs live under `.scratch/`. Work in this checkout, without worktrees.

Official Codex app-server owns execution, model history, queue, authentication and compaction. This application owns the Companion UI, STT, attachments and relationship state. Keep one execution owner; remove obsolete naco/DSH paths. Docker, generic migration and deployment cutover are outside this implementation; the explicitly authorized one-time converter for a user-supplied, already-compacted DSH log is the narrow exception documented by its task spec.

Use test-owned workspaces and fake services for automated tests. Real local acceptance may use the authorized existing Codex login with Luna and a test persona; never copy credentials or existing conversations, and never send external messages as a test. Keep scratch and runtime state out of Git.

Update README for operator contracts and docs/IMPORTS.md for imported source attribution. Keep CONTEXT.md implementation-free. Preserve upstream licenses. The Owner maintains prompt semantics; the Implementation worker handles wiring and reports any needed prompt changes to the Owner.

## Standalone core workflow

### Local Codex build contract

- Build Linux first; macOS follows with the same native build profile and host-local cache convention. Use local builds, not an external Actions provider, for this task.
- Preserve `${XDG_CACHE_HOME:-$HOME/.cache}/lamplitisles/codex-for-love/cargo-target`. Before building, verify the pinned source, Rust toolchain, lockfile, native target and build environment against the successful build. A shared directory alone does not guarantee cache hits; keep existing artifacts until reuse is checked.
- Keep the successful low-memory profile: `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_RELEASE_INCREMENTAL=false`, `CARGO_PROFILE_RELEASE_LTO=false`, `CARGO_PROFILE_RELEASE_DEBUG=0`, `CARGO_PROFILE_RELEASE_STRIP=symbols`, `CARGO_PROFILE_RELEASE_OPT_LEVEL=1`, and `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`. Build the existing `codex-app-server` package/binary with `--locked --release`. Public Linux artifacts use explicit `--target x86_64-unknown-linux-musl` and target-specific cache output; preserve prior GNU artifacts. Native macOS builds omit `--target`. Reuse the same-version official code-mode helper rather than compiling it.
- On this Linux host, run one heavy build at a time with four Cargo jobs inside an enforced resource scope: `MemoryMax=6G`, `MemorySwapMax=512M`, `CPUQuota=400%`, and `TasksMax=256`. Verify the scope's limits before compiling; stop if enforcement is unavailable. Job count is not a memory limit.
- First inspect Cargo freshness under these parameters. If dependencies unexpectedly require widespread rebuilding, stop and report the fingerprint mismatch before continuing a long build. For unchanged fork behavior and release packaging, use lightweight artifact/provenance checks rather than rebuilding the Rust test graph. Establish appropriate resource controls on macOS before its later build.

- Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `pnpm test` from the repository root.
- Fork-native changes follow the local Codex build contract above; release packaging instead selects the exact published Linux native package pinned by the main manifest and verifies its provenance and hashes. The removed `pnpm codex:build` command is not a release path.
- Run the Partner with `pnpm --filter @lamplitisles/partner start -- <config.toml>` after configuring the official Codex 0.154.0 executable and existing device-auth login.
- Use a fresh test-owned workspace and the fake app-server for automated tests. Do not use the real Codex home, credentials or external message side effects in tests.
- The official app-server is the execution owner. Do not reintroduce naco, Bridge model transport, custom imagegen/mail/skill wrappers, Docker, generic migration or cutover code. The narrow one-time DSH compacted-log converter is an explicit current feature, not a generic migration framework.
- Keep `.scratch/`, `.lamplit/`, build output and runtime state out of Git. Preserve unrelated edits and update `docs/IMPORTS.md` when imported source attribution changes.
