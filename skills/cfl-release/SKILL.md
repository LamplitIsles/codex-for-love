---
name: cfl-release
description: Release Codex for Love's scoped npm packages, including native-artifact provenance, tag-driven main-package publication, and installed-artifact verification. Use for CFL package releases or native-package updates; not for ordinary development builds or deployment.
---

# CFL release

The product release is three separate npm packages:

- `@lamplitisles/codex-for-love-linux-x64` (`linux` / `x64`)
- `@lamplitisles/codex-for-love-darwin-arm64` (`darwin` / `arm64`)
- `@lamplitisles/codex-for-love`, the launcher and application package

The main manifest pins an exact version of each native package. Native bytes
are immutable: publish and validate both affected native packages before a
main package can reference new versions. Never publish upstream
`@openai/codex` as part of CFL.

## Start with the release boundary

Read `AGENTS.md`, `docs/operator-guide.md`'s **Publishing the main package**
section, and the relevant release scripts before choosing commands. Keep the
checkout, package versions, and `release/codex-artifact*.json` identity
contracts aligned. A provenance release label inside a native archive is not a
Git tag.

- For an unchanged-native main release, verify the exact public native package
  bytes and provenance with `scripts/publish-preflight.mjs`, then follow the
  tag-driven main-package workflow. The tag is the main-package version source;
  the disposable staging step must not mutate the checkout or dependency pins.
- For a native update, use the `codex` fork's
  `skills/cfl-codex-native-release/SKILL.md` to create reviewed local Linux
  and macOS archives. Copy them into `.scratch/native-release-<version>/`,
  then use its three local commands: `login`, `publish <version> --linux`, and
  `publish <version> --mac`. Each publish command builds and validates only its
  selected scoped native tarball before one direct `npm publish`; it does not
  immediately query the registry after submission. The Linux and macOS packages
  are independently built and independently published. A native-only publication
  leaves the main manifest and `release/codex-artifact*.json` untouched; update
  those contracts only in the later main-package change that pins the verified
  public native versions.

## Verification and publication order

Before an external mutation, verify a clean intended source state, the target
semver/tag, npm registry availability, package `os`/`cpu`, archive integrity,
provenance, executable hashes, and the exact optional-dependency pins. Use the
existing `release:check`, `release:preflight`, and `release:smoke` paths rather
than reconstructing checks in shell one-liners.

Run an installed-artifact smoke on the matching host after every native or main
package change. A native package may be manually published only after its exact
tarball and host acceptance are verified; ask for fresh confirmation at that
upload boundary unless the user explicitly requested that exact publication.

Main-package publication is tag-driven and uses the repository's governed tag
workflow and GitHub OIDC publisher. Do not substitute a token-based local
`npm publish`, publish before native dependencies, or treat registry propagation
delay as a reason to republish an immutable version.

## Handoff

Record the immutable package/version/integrity, the fork source revision and
release tag, and the host smoke result. Release artifacts do not deploy a
Partner instance; follow `docs/development-environments.md` only when the user
also requests installation or deployment.
