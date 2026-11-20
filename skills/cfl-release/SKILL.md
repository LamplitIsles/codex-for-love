---
name: cfl-release
description: Update the Codex Forgejo Release pin or verify a Codex for Love snapshot. Use for native artifact upgrades and installed-package acceptance.
---

# CFL release

CFL consumes a pinned Linux x64 Codex Release from
[`codex-build`](https://forgejo.n5.guion.io/LamplitIsles/codex-build).
Woodpecker publishes commit-identified CFL snapshots to Forgejo on pushes to
`main`. Start with the [Forgejo snapshots](../../docs/operator-guide.md#forgejo-snapshots)
operator instructions. Shio promotion is a separate operation.

## Update the native artifact

1. Inspect the exact published Release. Download the archive anonymously, verify
   its SHA-256 against the reviewed checksum, and check its app-server, helper,
   provenance and licenses. Record the upstream version and artifact digest.
2. Update the archive and file digests together with the supported Codex version.
   Refresh the SDK protocol from the matching Codex version where needed and
   update source attribution in `docs/IMPORTS.md`.
3. Verify the changed protocol and cache behavior using test-owned state.
   Cover first fetch, offline reuse and integrity failure. Use the exact
   reviewed artifact for the Linux app-server and helper smoke.

## Verify the CFL package

Prepare the [pinned App contracts](../../docs/default-shared-frontend.md) before
frozen installation. Build the checkout, stage the main artifact with
`pnpm release:prepare`, and check contents with `pnpm release:check`.
Run `pnpm release:smoke` on Linux x64 with the staged package in a test-owned
prefix, following the smoke script's documented inputs. Use the unchanged
App pin and verified Codex archive when verifying only the native change.
Record the artifact digest and which launcher, cache and native checks passed.

Use the [snapshot procedure](../../docs/operator-guide.md#forgejo-snapshots)
to verify an actual publication. Identify the exact commit and snapshot
integrity. Inspect registry state before retrying an uncertain publication.
The public npm publisher is paused. For an authorized Shio promotion, read
[the host-local environment contract](../../docs/development-environments.md).
