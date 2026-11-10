# Manual npm trusted publishing

This is a release mechanism, not a standing authorization to publish future versions. Both
workflows use `workflow_dispatch` only. Ordinary pushes, tags, PRs, CI completion and scheduled
checks cannot publish. Neither workflow creates Git tags or GitHub Releases.

## One-time account setup

Merge and review the workflow implementation before enabling its npm trust relationship.
Creating that relationship grants the named GitHub workflow permission to publish this package;
it is a separate security-sensitive account action, not just a local configuration edit.

1. In `JaminZhou/codex-app-server-client`, create the GitHub environment `npm-publish`.
   Under deployment branches and tags, select **Selected branches and tags** and add a **branch**
   rule matching exactly `main`. Do not allow tags or other branches. Keep main's required CI,
   pull-request and conversation-resolution protections. A required environment reviewer is an
   optional additional human gate; the workflow's manual dispatch is the default release trigger.
2. In npm's settings for `@jaminzhou/codex-app-server-client`, add a GitHub Actions trusted publisher:

   | Field | Exact value |
   | --- | --- |
   | Organization or user | `JaminZhou` |
   | Repository | `codex-app-server-client` |
   | Workflow filename | `npm-publish.yml` |
   | Environment | `npm-publish` |
   | Allowed action | Permit direct `npm publish` |

   Complete npm's required security-key/2FA check yourself. Direct publishing must be selected:
   a stage-only connection still requires a maintainer's 2FA approval for every release.
   Configuration of a trusted publisher does not disable account 2FA, change maintainers or
   require storing an `NPM_TOKEN`. Leave unrelated account/token settings unchanged.
3. The publisher uses GitHub-hosted Linux, Node `22.22.2`, npm `11.6.2` and `id-token: write` only
   in its publish job. npm authenticates that job with a short-lived workflow-specific credential.
   A local `npm whoami` is not a test of this OIDC connection. npm validates the connection during
   actual publication; saving the settings does not prove the end-to-end path works.

See [npm's trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/) and
[GitHub environment deployment restrictions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Prepare, inspect, then approve

Start from a reviewed, merged, clean release revision whose `package.json` has the intended
non-preview `0.x.y` version and whose current-main CI has fully passed.

```bash
gh workflow run npm-release-candidate.yml --ref main -f version=0.2.1
```

The candidate workflow checks current-main CI, exact version and registry availability, then
runs the full local checks, runtime compatibility and drift verification. `release:pack` builds
once and tests that archive with npm and pnpm. The workflow uploads exactly the `.tgz` and
`release-evidence.json` as `npm-candidate-VERSION`, retained for 14 days. It has no OIDC publishing
permission. No real model account, OAuth enrollment or biometric acceptance runs in CI.

Inspect the successful run and retain its artifact locally. The run summary lists the exact
version, full source SHA, SHA-512 integrity, run ID and `latest` tag. Present these and the
[release acceptance boundary](./releases/0.2.1.md#release-gates) to Jamin for explicit approval.
Preparing a candidate or merging its source is not publication approval.

The previously approved local `0.2.0` archive is not automatically selected by this mechanism.
The workflow accepts only its own successful, canonical-main candidate runs. Changing source,
rebuilding or preparing another candidate requires a new identity review; never reuse approval
for a different hash. Do not overwrite or repack a locally retained approved artifact merely
to enable OIDC. The local CLI path can still publish that exact artifact after authentication.

## Publish only the selected bytes

After approval, dispatch **npm publish** on `main` with the four exact values from the candidate
summary. In the CLI, replace the uppercase placeholders; do not include them literally:

```bash
gh workflow run npm-publish.yml --ref main \
  -f version=0.2.1 \
  -f source_sha=FULL_APPROVED_SOURCE_SHA \
  -f candidate_run_id=SUCCESSFUL_CANDIDATE_RUN_ID \
  -f integrity=COMPLETE_APPROVED_SHA512_INTEGRITY
```

The workflow fails closed if main moved, the workflow revision differs from the candidate source,
current-source CI is missing/incomplete/failed/cancelled, the candidate came from a fork/PR/other
workflow, the retained artifact expired, evidence is dirty or inconsistent, or the hash differs.
It also refuses an already-existing version or a downgrade of `latest`.

The verification job repeats npm/pnpm installed-archive tests **without OIDC permission**. A fresh
publish job downloads the same immutable artifact ID, checks main/CI and the archive again, and
runs only `npm publish APPROVED_TARBALL --ignore-scripts --tag latest --access public` against the
public npm registry. It never installs the project, builds, packs or executes package examples
in the OIDC job. No long-lived publishing secret or cached project dependency tree is used.

The run then reads registry metadata, checks `latest` and all unrelated tags, compares dependencies
and integrity, and downloads the registry tarball for SHA-512 comparison. A separate job with no
OIDC permission installs the exact registry version using fresh npm and pnpm consumers, checks
their lockfile integrities, strict declarations and exports, and runs 19 local-fixture examples
plus four CLI input cases. These tests do not establish live-model or real-account acceptance.

The post-publication reader tolerates short registry visibility delays: a missing new version,
`latest` still equal to its exact pre-publication value, or a tarball HTTP 404. It makes at most
six attempts, waiting 2, 5, 10, 20 and 30 seconds between attempts. All retries are fresh GETs
requesting cache revalidation, with 30-second HTTP timeouts; they never repeat `npm publish`.
Package identity, integrity, dependencies, unrelated tags and tarball-host mismatches fail
immediately, even if `latest` is stale. An unexpected third `latest` value, malformed metadata,
authentication/service errors and network errors also fail without retry. Exhaustion explicitly
warns that publication may already have succeeded and requires registry inspection.
The publish job has a 20-minute overall timeout: the reader can consume up to 7 minutes
7 seconds of HTTP waits and backoff, so setup, artifact checks and publication need separate
headroom. This does not extend individual HTTP timeouts or permit publication retries.

## Evidence and recovery

- Preparation evidence remains `published: false`: it records preparation, not mutable status.
- `npm-publication-registry-VERSION` retains before/after registry evidence. Its receipt has
  `registryVerified: true` and `consumerVerified: false` until the consumer job succeeds.
- `npm-publication-complete-VERSION` is emitted only after both registry consumers pass. Retain
  that JSON receipt and the approved tarball outside Actions; publication artifacts expire after
  90 days. Only a fully successful run establishes completion.
- A publish timeout/error is **not** proof that nothing reached npm. The read-back step attempts
  verification even after a failed publish command. Inspect the exact registry version and run
  evidence before any retry; never blindly rerun the publish job, bump the version, unpublish,
  change tags or substitute a new archive to make a failed run green.
- If only registry-consumer verification failed, the version may already be public. Diagnose the
  failure and rerun only those failed verification jobs when appropriate, not publication.
- Main advancing or a candidate expiring requires a newly prepared, inspected and approved
  candidate. A revoked/mismatched OIDC connection requires account-side correction; do not fall
  back to a newly minted bypass-2FA token.

See [RELEASING.md](../RELEASING.md) for the retained local-tarball fallback and publication gates.
