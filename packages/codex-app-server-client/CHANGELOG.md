# Changelog

## 0.2.1

Maintenance release scope; check exact npm availability before installing. See the
[release guide](./docs/releases/0.2.1.md). No public API, generated protocol, runtime dependency
or transport behavior changes from `0.2.0`; the bundled Codex runtime remains `0.154.0`.

- Harden repository-only publication verification against short npm registry visibility delays:
  bounded read-only retries for a missing new version, an unchanged previous `latest` tag or a
  tarball HTTP 404. Identity, integrity and unrelated-tag mismatches still fail closed.
- Reserve 20 minutes for the publishing job, including the reader's worst-case 7m7s budget.
  This never retries `npm publish` and does not change client request retry behavior.
- Add publication read-back regression tests and update release instructions. These release
  scripts and GitHub workflows are repository tooling, not installed SDK features.
- Default initialize client-info version becomes `0.2.1`, derived from package metadata.
- A successful future full publication run is still required to verify the corrected end-to-end
  publishing path; preparing this candidate does not establish publication.

## 0.2.0

Non-preview release scope; check exact npm availability before installing. See the
[release guide](./docs/releases/0.2.0.md) and [migration notes](./docs/api-diff-0.2.0.md).

- Upgrade the exact bundled Codex runtime and generated public protocol to `0.154.0`.
  Add four raw `userVerification/*` methods (162 typed requests, 159 validated responses),
  optional rate-limit read capabilities, MCP user-verification elicitations and new thread metadata.
- Preserve twelve Schema-omittable fields in changed/new types as optional TypeScript properties
  and keep the new verification error's int64 code lossless; retain the basic
  compatibility window at `0.150.1`, `0.152.1`, `0.153.4` and `0.154.0`.
- Add high-level `ExternalMessage`, preserving untrusted tool authority through the already-generated
  `turn/start.toolOutput` field; reject mixed user input, user steering and unsupported/unknown runtimes.
- Give joining turn handles independent event streams, retained result snapshots and pending-start
  race protection. Add official example 16 and expand installed-package verification to 19 examples.
- Add 15 runnable Node equivalents of the pinned official Python app-server SDK examples, with an
  explicit upstream version boundary and no separate consumer application or blocking API.
- Expand npm/pnpm and cross-platform installed-example checks to all 19 scenarios and four CLI input
  cases. Model output remains local/scripted; login cancellation defaults to a strict RPC fixture, not OAuth.
- Bound retries for temporary-directory cleanup in npm/pnpm and Git installed-consumer smokes;
  retain both errors when the consumer and cleanup fail, and report success only after cleanup.
- Add a Windows file-sharing regression fixture and the historical `0.1.0` release record.
- Default initialize client-info version becomes `0.2.0`, derived from package metadata.
- These runtime/protocol upgrades, new client APIs and maintenance changes are not in the immutable
  npm `0.1.0` archive; install the separately verified `0.2.0` archive to obtain them.

## 0.1.0 (2026-09-09)

Published with `latest` pointing to `0.1.0`; see the [release record](./docs/releases/0.1.0.md).

- Deterministic real-runtime regression coverage for concurrent thread streams, approval-policy
  inheritance, interruption followed by another turn, and managed-process death/recovery.
- Document the published preview and explicit acceptance gates for a future `0.1.0` release.
- Prepare the first non-preview candidate with explicit `release:pack` verification and intended
  npm `latest` tag. This is still a pre-1.0 API, not a 1.0 stability guarantee.
- Raise the Vitest development dependency floor to `4.1.11` and update its lockfile graph,
  including `@vitest/mocker`, to address the redirect-mock path traversal/arbitrary-read advisory.
- No public API, protocol, runtime dependency, or transport behavior changes from `0.1.0-preview.0`;
  default initialize client-info version becomes `0.1.0`. See [API comparison](./docs/api-diff-0.1.0.md).

## 0.1.0-preview.0 (2026-09-08)

- First npm-preview preparation for the scoped, unofficial Node.js ESM client.
- Runnable streaming, command-decline, and interrupt/restart/resume examples. Default execution uses
  a real pinned runtime with a temporary home and loopback mock provider, with no model usage.
- Task-oriented onboarding, authentication/usage boundaries, troubleshooting, and a separate API guide.
- Clean npm and pnpm tarball verification with install scripts disabled and strict declaration checks.
- Explicit Node.js type reference in bundled declarations for pnpm's isolated dependency layout.
- Candidate archive, SHA-512 evidence, and a manual `next` release procedure. The exact archive
  was published and verified through fresh npm/pnpm registry consumers. The registry also assigned
  `latest` to this preview; it does not represent a stable-release promotion.

Runtime remains pinned to Codex `0.153.4`; this batch adds no protocol methods. Existing Git
consumers retain the same API and ESM imports. The default initialize client-info version now tracks
the package version rather than reporting `0.0.0`.
