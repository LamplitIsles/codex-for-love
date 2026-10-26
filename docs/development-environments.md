# Host-local Partner environments

Read this contract before installation, deployment, acceptance or recovery.
Merging a PR and publishing npm packages do not deploy a Partner instance.

## Current N5 target

N5 runs one CFL instance: Shio, as the **system** unit
`codex-for-love-shio.service`, running as `neil`, serving loopback port **3084**.
Use `systemctl` without `--user` for this target. There are no N5 Mika dev or
staging targets. The Mac is a native build and package-smoke host; it has no CFL
service to install, restart or promote.

At the 2026-10-26 inventory, Shio served complete candidate
`5a566957cc94f626da933f87b0a3b045e73d3d41` with native package root
`/home/neil/.local/lib/codex-for-love-linux-x64-0.6.0`. These identify the prior
rollback artifacts, not the next installation destination. Reinspect the actual
unit and drop-in metadata immediately before promotion; do not assume the current
launcher or configuration location from an old example.

```sh
systemctl show codex-for-love-shio.service \
  -p User -p FragmentPath -p DropInPaths -p ExecStart -p MainPID
```

Read only the required launcher metadata. Preserve environment-file references
without displaying their contents. Keep the existing fixed TOML, state root,
workspace, credentials and conversations in place.

## Prepare an immutable candidate

Workers prepare and verify artifacts. Orc owns independent review, governed
merge, external publication and live promotion. Work only in test-owned paths
until that handoff. Native builds belong to the Codex fork and follow
[the release skill](../skills/cfl-release/SKILL.md); application packaging consumes
its reviewed archives and never rebuilds native code.

Use Node 24, pinned pnpm and the pinned Bun toolchain. Prepare a clean App checkout
at `lamplit-app.sha` following [source preparation](default-shared-frontend.md),
then run the root sequence:

```sh
pnpm --config.verify-deps-before-run=false source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm release:prepare "$PWD/.scratch/candidate-artifacts" --strict
pnpm release:check
node scripts/packaged-frontend-smoke.mjs <exact-main-tarball>
```

The preparation command disables pnpm's automatic install-before-run only for
this bootstrap step: the generated contracts workspace must exist before frozen
installation. Keep `CFL_APP_SOURCE` set throughout when using an approved isolated
App checkout. Main publication stages its version from the release tag in a
disposable source directory; the checkout's placeholder version stays unchanged.

Record exact CFL/App source identities, tarball SHA256 and npm integrity, and
`vendor/source.json` browser/contracts/license hashes. Native package acceptance
runs on each matching host against exact tarballs in fresh test-owned prefixes.
Use `CFL_NATIVE_TARBALL` with the installed-artifact smoke before native
publication; public-registry preflight becomes possible only after both exact
native versions are public. No test uses installed service state or real login.

## Orc promotion of Shio

Only after current-head review/merge, native publication, main public-dependency
preflight and tag-driven OIDC publication, prepare the exact accepted complete
package and its matching public native dependency in a new stable prefix.
Resolve the native package relative to the installed main package and verify its
version equals that main manifest's exact optional-dependency pin. Check the
direct `bin/codex-app-server --version` and `bin/codex-code-mode-host --help`.
The ordinary Codex CLI and a TOML executable override do not select the pinned
published runtime.

Extract the exact accepted main tarball into a new stable candidate directory.
Install its declared runtime dependencies into a stable separate prefix when
using the extracted bundled runtime, and verify Sharp/Koffi loading and the
fake-engine package smoke. Keep the candidate independent of mutable checkout
build output and dependencies. Retain the prior candidate, native package and
dependency prefixes for rollback.

Before changing the launcher, preserve its exact prior drop-in bytes and record
the prior process identity and static-resource manifest. Change only the intended
Shio launcher reference to the verified candidate and matching native root,
preserving its existing configuration argument and environment-file references.
For an extracted runtime the command has this form, with paths obtained from the
actual unit rather than assumed:

```text
<node24> <candidate>/package/vendor/runtime/cli.mjs --native-package-root <verified-native-root> serve <existing-fixed-partner.toml>
```

Reload systemd and restart the same system unit; never run a parallel Partner:

```sh
sudo systemctl daemon-reload
sudo systemctl restart codex-for-love-shio.service
systemctl is-active codex-for-love-shio.service
systemctl show codex-for-love-shio.service -p MainPID -p ExecStart
ss -ltn '( sport = :3084 )'
curl --fail http://127.0.0.1:3084/
```

Budget up to 120 seconds with short readiness polls. Stop on process failure or
restart loops. Verify actual process/native executable identity and supported
version, serving readiness, and every served browser resource against the accepted
`vendor/source.json` hashes. Fetch static resources only. Do not read conversations
or send messages. This establishes installation and serving identity; it does not
establish resolution of historical provider 429 incidents.

If promotion fails, restore only the prior launcher bytes and references to the
retained code/native dependencies, reload and restart the same Shio unit, then
verify original process identity, readiness and resource hashes. Never copy or
restore instance state, credentials, configuration or conversations as rollback.

## Historical WSL targets

Earlier Kosmos WSL guidance described user units `codex-for-love-dev.service`
(Mika, 3082), `codex-for-love-staging.service` (3083), and
`codex-for-love-prod.service` (Shio, 3084), under
`~/.local/state/codex-for-love/{dev,staging,prod}/`. Those are historical targets,
not N5 deployment commands. Prior reports referring to user-unit overrides,
`prod-current` or dev-then-prod promotion apply to that WSL environment only.
The earlier dev-service authorization does not authorize inventing an N5 dev
instance. Any work on a different host must first establish its actual targets.
