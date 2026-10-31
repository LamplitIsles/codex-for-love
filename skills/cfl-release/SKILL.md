---
name: cfl-release
description: Release Codex for Love's scoped npm packages, including native-package pins, tag-driven main-package publication, and installed-artifact verification. Use for CFL package releases or native-package updates; not for ordinary development builds or deployment.
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
checkout and exact package versions aligned. The main manifest's native pins
are the installed-runtime selection contract.

- For an unchanged-native main release, verify the exact public native package
  metadata with `scripts/publish-preflight.mjs`, then follow the tag-driven
  main-package workflow. The tag is the main-package version source; the
  disposable staging step must not mutate the checkout or dependency pins.
- For a native update, use the `codex` fork's
  `skills/cfl-codex-native-release/SKILL.md` to create reviewed local Linux
  and macOS archives. Copy them into `.scratch/native-release-<version>/`,
  then use this skill’s existing
  `scripts/publish-native-wizard.sh`. Run `prepare <version> --linux` and
  `prepare <version> --mac` to retain exact tarballs in the input directory’s
  `tarballs/` (or `CFL_NATIVE_OUTPUT_DIR`). `CFL_NATIVE_INPUT_DIR` selects the
  reviewed archives. Preparation reports SHA256 and npm integrity, refuses
  conflicting existing bytes, and does not authenticate or publish.
  The original `login`, `publish <version> --linux`, and
  `publish <version> --mac` commands remain available. Each publish command builds and validates only its
  selected scoped native tarball before one direct `npm publish`; it does not
  immediately query the registry after submission. The Linux and macOS packages
  are independently built and independently published. A native-only publication
  leaves the main manifest untouched, so it is not a production deployment. In
  the later main-package change, pin the public native versions before the
  tag-driven main release; the installed launcher resolves those pins and does
  not use a production Partner TOML executable override.

## Verification and publication order

Before an external mutation, verify a clean intended source state, the target
semver/tag, npm registry availability, package `os`/`cpu`, and the exact
optional-dependency pins. Use the existing `release:check`, `release:preflight`,
and `release:smoke` paths rather than reconstructing checks in shell one-liners.

For an unchanged-native main-package release, run the Linux
installed-artifact smoke; a fresh Mac smoke is not a blanket requirement. Verify
Mac-specific changes on Mac before claiming acceptance there; a smoke of an
older main package does not verify the new version. For each changed native
package, verify its exact tarball on its matching host before publication. Ask
for fresh confirmation at a native upload boundary unless the user explicitly
requested that exact publication.

Shio source deployment does not require npm publication. Follow
`docs/development-environments.md` for that separate workflow.

Main-package publication is tag-driven and uses the repository's governed tag
workflow and GitHub OIDC publisher. Do not substitute a token-based local
`npm publish`, publish before native dependencies, or treat registry propagation
delay as a reason to republish an immutable version.

For native acceptance before publication, set `CFL_ARTIFACT_DIR` to the prepared
main artifact directory and `CFL_NATIVE_TARBALL` to the matching prepared native
tgz, then run `pnpm release:smoke` on each changed package's matching host in a
fresh test-owned prefix. For an unchanged-native main release, the
tag-driven workflow runs the Linux installed-artifact smoke. The smoke verifies
the exact package pin/platform and executable version before replacing only its
temporary native executable with the fake engine. A local tarball cannot be used
with `CFL_PUBLIC_SMOKE=1`.

Orc publishes the exact retained and host-accepted native tarballs with
`npm publish <exact-native.tgz> --access public --tag latest --registry https://registry.npmjs.org`.
Recheck immutable version availability immediately before that submission;
never repack accepted bytes or overwrite an occupied version. After both native
versions are public, run `pnpm release:preflight v<main-version>` and follow the
existing tag/OIDC main workflow. Publication and live promotion remain Orc-owned.
The absent `release/` directory held obsolete metadata, deliberately removed when
the main optional-dependency pin became authoritative; do not restore it.

## Handoff

Record the immutable package/version/integrity and the host smoke result.
Release artifacts do not deploy a Partner instance; follow
`docs/development-environments.md` only when the user also requests installation
or deployment.
