# Host-local Partner environments

Read this contract before installation, deployment, acceptance or recovery.
Merging a PR and publishing npm packages do not deploy a Partner instance.

## Current N5 target

N5 runs one CFL instance: Shio, as Neil's **user** systemd unit
`codex-for-love-shio.service`, serving loopback port **3084** with its existing
configuration and state. Run its `systemctl --user` commands as `neil`; in a
non-login shell set `XDG_RUNTIME_DIR=/run/user/1001` if needed. The managed unit
definition is `n5-services/user-units/codex-for-love-shio.service` in
`elec-debian-setup`. The existing privileged HOME mount and pre-start gate guard
Neil's user manager; preserve that gate. There are no N5 Mika dev or staging
targets. The Mac is a native build and package-smoke host; it has no CFL service
to install, restart or promote.

At the 2026-10-26 inventory, Shio served complete candidate
`5a566957cc94f626da933f87b0a3b045e73d3d41` with native package root
`/home/neil/.local/lib/codex-for-love-linux-x64-0.6.0`. These identify historical
artifacts, not necessarily the current rollback artifacts or the next installation
destination. Reinspect the actual unit and
drop-in metadata immediately before promotion; do not assume the current launcher
or configuration location from an old example.

```sh
systemctl --user show codex-for-love-shio.service \
  -p FragmentPath -p DropInPaths -p WorkingDirectory -p ExecStart -p MainPID
```

Read only the required launcher metadata. Preserve environment-file references
without displaying their contents. Keep the existing fixed TOML, state root,
workspace, credentials and conversations in place.

## Source preparation and verification guidance

Workers prepare and verify artifacts. Orc owns independent review, governed
merge and live promotion. Use test-owned paths for automated verification.
Native builds belong to the Codex fork and follow
[the release skill](../skills/cfl-release/SKILL.md); application preparation
uses the pinned native artifact and never rebuilds native code.

For a normal full verification, use Node 24, pinned pnpm and the pinned Bun
toolchain. Prepare a clean App checkout at `lamplit-app.sha` following
[source preparation](default-shared-frontend.md), then run the root sequence:

```sh
pnpm --config.verify-deps-before-run=false source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

The preparation command disables pnpm's automatic install-before-run only for
this bootstrap step: the generated contracts workspace must exist before frozen
installation. Keep `CFL_APP_SOURCE` set throughout when using an approved isolated
App checkout.

Record the exact reviewed CFL main commit, App pin and prepared contract/license
hashes. Use test-owned fixtures for automated verification of the source-built
runtime, selected frontend and pinned Linux native artifact. npm packaging and
publication are optional; neither is a prerequisite for deploying reviewed source
to Shio. A fresh Mac smoke is not a blanket requirement for unchanged native packages.
Mac-specific changes or a new Mac acceptance claim warrant Mac verification; an
older version's smoke does not verify a new version.

Acceptance of each changed native package runs on its matching host against the
exact tarball in a fresh test-owned prefix before native publication. Use
`CFL_NATIVE_TARBALL` with the installed-artifact smoke. For optional main-package
publication, public-registry preflight requires both exact native versions to be
public. Follow
[the release skill](../skills/cfl-release/SKILL.md) for platform-specific acceptance
details. No test uses installed service state or real login.

## Orc promotion of Shio

After current-head review and merge, this deployment uses the existing CFL main
checkout, its existing `node_modules` and generated App contracts. Record the
exact CFL commit and clean working-tree status, App pin, and prepared
contract/license hashes; verify that the generated contracts correspond to that
pin and the runtime being promoted. Reuse the existing dependencies. For this
deployment, do not install dependencies or run tests or synthetic services.

The checkout, generated resources and dependencies are mutable: later edits,
installs or preparation can change the deployed runtime without a new reviewed
commit. Keep those paths stable and protect them from changes while Shio uses
them; re-establish their source and artifact identities before every promotion or
restart. If the existing artifacts do not match the reviewed source and pin,
stop and resolve that mismatch before promotion. An independent checkout,
dependency directory or build cache requires its own concrete approval before
creation.

Use the existing verified Linux native artifact in a stable native root, checking
its package version against the candidate main manifest's exact platform pin and
checking direct `bin/codex-app-server --version` and
`bin/codex-code-mode-host --help`. Retain the prior launcher, candidate, native
root and dependency bytes needed for rollback, whether the prior installation is
source-based or packaged.

The reviewed unit must expose Bun 1.3.14, curl and tar on PATH and allow the
documented network access. An omitted `frontend` selects `latest`; an explicit
full SHA pins the App. After restart, record
the resolved SHA from startup output and compare every served resource with that
revision’s cache manifest; `latest` may have advanced since review. Reload browser
pages. Preserve Post and remove the requested Shio Keet configuration; retain
credentials and all state. When the old and new runtime schemas differ, identify
the minimum necessary field changes and their exact expected values before editing
the existing TOML in place. Preserve the meaning of relative paths. Record only
the specific non-secret fields needed for a reviewed inverse, not a full config
copy; stop if their safe inversion cannot be established.

Before changing the launcher, inspect the actual unit fragment, its ownership,
permissions and any drop-ins; stop and resolve unknown or unexpected metadata,
files or overrides before proceeding. Compare the fragment with the reviewed
host-repository definition, preserve its exact current bytes in a protected
rollback location, and record the prior process identity and static-resource
manifest. Preserve any reviewed drop-ins unchanged and retain their exact bytes
if the change requires touching them.

Coordinate a reviewed change to the managed Shio unit in `elec-debian-setup`:
update its launcher and working directory as needed for the reviewed checkout
and matching native root, preserving its existing configuration argument,
environment-file references and other service behavior. The source runtime
command has this form, with paths obtained from the actual unit and reviewed
checkout:

```text
<node24> <checkout>/apps/partner/runtime/cli.ts --native-package-root <verified-native-root> serve <existing-fixed-partner.toml>
```

After host-repository review and merge, install that exact reviewed unit as Neil
at the inspected fragment path. Before replacing it, verify that the installed bytes,
ownership, permissions and drop-ins still match the inspected baseline; stop on
any change or unknown artifact. Stage the reviewed file in the same directory,
verify its bytes and appropriate owner and mode, then replace the known fragment
with the staged file. Do not overwrite an unknown object. The host repository's
`scripts/n5-neil.py install` is an initial/exact-match installer: it refuses a
differing existing unit and is not the upgrade command.

Reload Neil's user manager and restart the same Shio unit; never run a parallel
Partner:

```sh
systemctl --user daemon-reload
systemctl --user restart codex-for-love-shio.service
systemctl --user is-active codex-for-love-shio.service
systemctl --user status codex-for-love-shio.service
systemctl --user show codex-for-love-shio.service -p MainPID -p WorkingDirectory -p ExecStart
ss -ltn '( sport = :3084 )'
curl --fail http://127.0.0.1:3084/
```

Budget up to 120 seconds with short readiness polls. Stop on process failure or
restart loops. Verify actual process/native executable identity and supported
version and serving readiness. Compare every served browser resource against the
selected resolved SHA's cache `manifest.json`, including when the selector is
omitted.
Fetch static resources only. Do not read conversations or send messages. This
establishes installation and serving identity; it does not establish resolution
of historical provider 429 incidents.

If promotion fails, first inspect the fragment and drop-ins again; stop if their
bytes or metadata are unknown. Restore the saved exact prior unit bytes, and any
deliberately changed drop-in bytes, only over the known promoted artifacts, using
the retained code/native dependencies. Before any restart, verify the exact
expected current fields and reject conflicting concurrent changes. Apply only the
reviewed minimum schema-specific inverse edits in the existing TOML, preserving
relative-path meaning and Post and keeping Keet disabled. Do not copy or restore
the full configuration, instance state, credentials or conversations as rollback.

Validate that the retained runtime accepts the resulting configuration and existing
credentials without unauthorized edits. Verify that its authentication and public
ingress protection meet the required security boundary. If compatibility, safe
field inversion or that boundary cannot be established, stop and report; do not
restart the old runtime. Otherwise, as Neil, run `systemctl --user daemon-reload`
and `systemctl --user restart codex-for-love-shio.service`, then verify original
process identity, readiness and resource hashes with the same checks above.

## Historical WSL targets

Earlier Kosmos WSL guidance described user units `codex-for-love-dev.service`
(Mika, 3082), `codex-for-love-staging.service` (3083), and
`codex-for-love-prod.service` (Shio, 3084), under
`~/.local/state/codex-for-love/{dev,staging,prod}/`. Those are historical targets,
not N5 deployment commands. Prior WSL reports referring to overrides for those
units, `prod-current` or dev-then-prod promotion apply to that WSL environment
only; they do not describe the N5 Shio user unit or its launcher.
The earlier dev-service authorization does not authorize inventing an N5 dev
instance. Any work on a different host must first establish its actual targets.
