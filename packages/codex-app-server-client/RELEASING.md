# Releases and candidate preparation

`0.1.0` was published on 2026-09-09; its [release record](./docs/releases/0.1.0.md) identifies the
source, immutable archive and verification scope. Do not republish this version.

The procedure below targets `0.2.1`/`latest`; it is not a claim that publication has completed.
Preparation, PR creation and merge are distinct from permission to publish. Query the exact registry
version and retained publication evidence to establish whether publication has completed.

The first preview, `@jaminzhou/codex-app-server-client@0.1.0-preview.0`, was published on
2026-09-08 using `--tag next`. The registry also assigned `latest` to that preview; attempting to
remove `latest` returned HTTP 400. Neither alias makes this a stable release. Exact-version
registry installation and downloaded-archive integrity were verified with npm and pnpm.
This repository has no push-, tag-, or schedule-triggered publishing workflow. The optional
[manual trusted-publishing workflow](./docs/trusted-publishing.md) separates candidate preparation
from publication of an explicitly approved archive. Adding these workflow files alone does not
configure npm permissions or establish that any package has been published.

The published `.0` archive is immutable. The commands below describe preparation/publication gates,
not permission to republish `.0`. Choose a new, explicitly approved version before any future
publication; local rebuilds of this checkout are development artifacts, not the published bytes.

## Version and support policy

- Client versions are independent of the Codex runtime version. Client `0.2.1` pins
  `@openai/codex@0.154.0`; the published `0.1.0` archive still bundles `0.153.4`.
  See [COMPATIBILITY.md](./COMPATIBILITY.md).
- Future previews use a new target version and increasing `preview.N` suffix. Record changes and migration notes.
  Pre-1.0 APIs and generated experimental protocol types may change; consumers should pin exact
  versions and keep their lockfiles.
- `0.2.1` is a separately reviewed non-preview candidate, still a pre-1.0 API. Preview commands use `--tag next`;
  do not deliberately promote a preview to `latest`. Always read back all registry tags: the first
  publication demonstrated that `--tag next` is not a guarantee that `latest` will be absent.
  Never reuse a published name/version or publish a stable version merely to repair tag naming.
- A runtime update is a separate compatibility change, not an automatic consequence of a newer
  npm dist-tag. Update provenance, generated artifacts, and tests together.

## Build a concrete candidate (no publication)

Use a reviewed checkout, Node.js 22+, and pnpm 11.7.0:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm compatibility:smoke
pnpm release:pack
```

`release:pack` requires a non-preview `0.x.y` version with public npm `latest` metadata.
The separate `preview:pack` command requires `0.x.y-preview.N` with `next`; mismatched commands
fail before packing. Neither command publishes or changes registry tags.

Both commands invoke `npm pack` (including the `prepare` build), check the published file
allowlist, and tests that exact archive in fresh npm and pnpm projects with install scripts
disabled. Both consumers type-check the root/protocol declarations with `skipLibCheck: false`,
load the ESM and schema exports, and execute the shipped example catalog: 18 real-runtime local-provider
scenarios, one scripted login RPC scenario and four CLI input cases. It does not authenticate with
npm, start real OAuth or model sessions, or publish.

Outputs:

- `artifacts/jaminzhou-codex-app-server-client-0.2.1.tgz`
- `artifacts/release-evidence.json`: source SHA, dirty-checkout flag, SHA-512 integrity, sizes,
  exact file list, Node version, and completed consumer checks.

Preview-version checkouts instead produce a versioned preview tarball and `preview-evidence.json`.
Retain previous approved evidence and archives before preparing a different candidate. In particular,
copy the `0.1.0` evidence into a version-specific archive before replacing `release-evidence.json`.

Artifacts are git-ignored. Both consumers and the staged evidence write must succeed before
promotion begins. Failures before promotion leave the previous verified pair untouched. During
promotion, old evidence is removed before replacing the archive, and new evidence is installed
last. An interruption or rename failure can therefore leave no evidence file: that means no
candidate is selected, even if a tarball exists. Regenerate before release; never pair a tarball
with a separately retained older evidence file. This is process-failure protection, not a claim
of power-loss durability or support for concurrent preparation in the same checkout. Inspect the
command's exit status and evidence source/hash before selecting a candidate.
For release approval, regenerate from a clean committed checkout so `sourceDirty` is `false`,
review the archive's contents/integrity and PR CI, and retain those exact bytes. Package consumers
get built ESM/declarations, schemas, examples, docs, and licenses, not source build tooling.

The normal CI runs installed npm consumers on Node.js 18 across Linux, macOS, and Windows, plus a
pnpm 11 consumer on Linux with Node.js 22. `release:pack` verifies both installers locally. These checks verify
package mechanics and simulated model workflows, not real account access, model output quality,
or all architecture combinations. Run `pnpm git:smoke` after committing to verify the committed
Git-install path; it does not test uncommitted files.

## Publication gates

Preparation can be completed without registry permissions. Publication still requires:

1. Jamin's explicit approval of the candidate version, exact tarball integrity, and intended tag
   (`latest` for `0.2.1`, `next` only for a preview).
2. An npm account authorized for `@jaminzhou` and the package name; registry 404 alone does not
   prove name ownership or publish rights.
3. npm's required authentication/2FA or an approved, main-restricted trusted-publishing setup.
4. Passing current-commit CI, reviewed changes, and a clean source commit matching the evidence.

No account setup, token creation, login, registry write, or GitHub release is implied by running
the preparation commands.

For recurring releases, prefer [GitHub Actions with npm OIDC](./docs/trusted-publishing.md):
manually prepare a candidate, approve its version/source/integrity, then manually dispatch the
separate publish workflow. The publisher downloads those retained bytes; it never rebuilds.
The local CLI procedure below remains available and requires npm's interactive authentication.

Only after approval, from the checkout whose candidate has been verified:

```bash
# Only the retained, explicitly approved 0.2.1 candidate:
npm publish /absolute/path/to/approved-0.2.1.tgz --tag latest --access public --registry https://registry.npmjs.org/ --ignore-scripts
```

Publish the inspected tarball, not a freshly rebuilt directory. Then read back the registry version,
dist-tag and `dist.integrity`, compare them with the saved evidence, install that exact registry
version into a new consumer, and repeat the examples. Record publication status separately from
the immutable archive. The packed README uses time-neutral exact-version guidance so publishing
does not require replacing the already-verified bytes. If the publish response is uncertain,
query the version before retrying.

For `0.2.1`, complete its [release gates](./docs/releases/0.2.1.md#release-gates), inspect the
[API comparison and migration notes](./docs/api-diff-0.2.0.md), retain the exact reviewed candidate,
and obtain explicit publication approval. The [0.1.0 acceptance checklist](./docs/release-readiness.md)
and [release record](./docs/releases/0.1.0.md) remain historical evidence, not a new live-account
acceptance for changed `0.2.1` bytes. Passing tests does not authorize publication or model usage.

See npm's [package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) and
[publish command](https://docs.npmjs.com/cli/v11/commands/npm-publish/) documentation.
