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

As last verified on 2026-11-03, Shio still ran the manually selected
Forgejo npm snapshot
`0.1.0-beta.0.snapshot.g6881b22d5eda6fdd6715867fdb6397666308adf4` from its
versioned prefix under `/home/neil/.local/share/codex-for-love/npm-releases/`.
As of 2026-11-03, the target snapshot
`0.1.0-beta.0.snapshot.g003d7163b2877a4b612d6360f0dce83145cac369` was
preinstalled and initially verified in the fixed prefix, but had not been
activated. The fixed-prefix host unit was reviewed and merged in
`elec-debian-setup` PR #99; merging it did not change the live unit. Reinspect
actual state before activation.
The 6881 runtime's Linux native package is `@lamplitisles/codex-for-love-linux-x64@0.7.0`
from npmjs. The unit starts the package launcher with Node 24 and the existing
TOML. App is selected independently as `latest`; at promotion it resolved to
`2b6a6240536afa71f35734d27fc68810cf4a3e2a`, with all 265 served/cache resources
matching its manifest. Local and public root, unauthenticated session rejection
and auth status were checked. This did not test conversations or native business
operations. Reinspect the actual unit and drop-in metadata immediately before
promotion; do not assume an old inventory is still current.

```sh
systemctl --user show codex-for-love-shio.service \
  -p FragmentPath -p DropInPaths -p WorkingDirectory -p ExecStart -p MainPID
```

Read only the required launcher metadata. Preserve environment-file references
without displaying their contents. Keep the existing fixed TOML, state root,
workspace, credentials and conversations in place; do not copy the full TOML,
state or credentials.

## Source preparation and verification guidance

Workers prepare and verify artifacts. Orc owns independent review, governed
merge and live promotion. Use test-owned paths for automated verification.
Native builds belong to the Codex fork and follow
[the release skill](../skills/cfl-release/SKILL.md); application preparation
uses the pinned native artifact and never rebuilds native code.

For a normal full verification, use Node 24 and pinned pnpm. Prepare the verified
published contracts following [source preparation](default-shared-frontend.md),
then run the root sequence:

```sh
pnpm --config.verify-deps-before-run=false source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

The preparation command disables pnpm's automatic install-before-run only for
this bootstrap step: the generated contracts workspace must exist before frozen
installation. No App checkout or Bun is required.

Record the exact reviewed CFL main commit, App pin and prepared contract/license
hashes. Use test-owned fixtures for automated verification of the source-built
runtime, selected frontend and pinned Linux native artifact. Source deployment is
a historical or fallback path for Shio; the current path uses a manually selected
package. A fresh Mac smoke is not a blanket requirement for unchanged native packages.
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

After current-head review and merge, manually select the exact Forgejo snapshot
version from registry metadata; publication does not promote it automatically.
Download its exact tarball and verify its SHA-512 integrity against that metadata.
Keep identifiable, distinct tarballs for the candidate and previous version; do
not overwrite one tarball path and assume npm will recognize changed bytes. The
tarballs are only a few MiB, not a retained dependency tree.

Before stopping the running service, perform the unit and process baseline
inspection described below. The fixed prefix is
`/home/neil/.local/share/codex-for-love/shio`; the 003d716 candidate was already
preinstalled and initially verified there as of 2026-11-03. Recheck it before
the first transition rather than assuming it is unchanged. Creation and use of
any new dependency directory require its own concrete approval. Preserve the
existing 6881 prefix and exact old unit bytes for the first transition. For
subsequent updates, run
`systemctl --user stop codex-for-love-shio.service` and confirm it is inactive
and its process has exited before changing the in-use npm tree. Install the verified
local tarball at the same prefix, with npmjs as the default registry, no scope
override and `--ignore-scripts`, for example:

```sh
npm install --prefix /home/neil/.local/share/codex-for-love/shio --registry=https://registry.npmjs.org/ --ignore-scripts /absolute/path/to/verified-version.tgz
```

After installation, verify the package version and source identity, the manifest's
exact platform-native pin and architecture, and sharp/koffi native module loading.
Check the launcher,
`codex-app-server --version` and `codex-code-mode-host --help` without using live
conversations. Before starting, verify that the candidate accepts the
existing configuration with the same path meanings and that the selected App
release's contracts match the package. Do not start if installation or verification
fails; inspect actual state and reconcile unknown outcomes before taking further
action. Later updates replace dependencies in place: the prior complete tree is
not retained, and recovery may require network access and leave the service down.

The previous source launcher remains a fallback only after its mutable checkout,
generated contracts, licenses, dependencies and native root have been checked
against the intended source and pin. Record its exact commit, clean working-tree
status, App pin and prepared contract/license hashes, and keep those paths stable
while in use. The historical source command was:

```text
<node24> <checkout>/apps/partner/runtime/cli.ts --native-package-root <verified-native-root> serve <existing-fixed-partner.toml>
```

At the 2026-10-31 switch the retained checkout was clean at
`6881b22d5eda6fdd6715867fdb6397666308adf4`; it must be revalidated before use.
A restart of that checkout cannot restore the former `84ff` process's in-memory
state. An independent checkout or build cache also requires its own concrete
approval before creation.

The reviewed unit must expose curl on PATH and allow the documented Forgejo
network access for uncached App packages. An omitted `frontend` selects `latest`; an explicit
full SHA pins the App. After restart, record
the resolved SHA from startup output and compare every served resource with that
revision’s cache manifest; `latest` may have advanced since review. Reload browser
pages. For this transition and rollback, leave the existing TOML, its relative
path meanings, Post, Keet, credentials and data unchanged. If the candidate
cannot use the existing configuration, stop; any configuration or data change
requires separate authorization and is not part of this procedure.

Before promotion, inspect the actual unit fragment, its ownership, permissions
and any drop-ins; stop and resolve unknown or unexpected metadata, files or
overrides before proceeding. Compare the installed fragment with its known
reviewed baseline and record the prior process identity and static-resource
manifest. On the first transition, also compare the target with the reviewed
host-repository definition and preserve the exact current unit bytes in a
protected rollback location. Preserve any reviewed drop-ins unchanged and retain
their exact bytes if the change requires touching them.

For the first transition only, use the reviewed fixed-prefix unit in
`elec-debian-setup`, preserving its existing configuration argument, pre-start
gate, environment-file references and other service behavior. Later package
updates do not require a unit change or per-version unit PR. The package launcher
selects its pinned native package. Its command has this form:

```text
<node24> /home/neil/.local/share/codex-for-love/shio/node_modules/@lamplitisles/codex-for-love/bin/codex-for-love.mjs serve <existing-fixed-partner.toml>
```

For the first transition, after host-repository review and merge, install that
exact reviewed unit as Neil at the inspected fragment path. Stop Shio and confirm
it is inactive and its process has exited before replacing the unit. Verify that
the installed bytes, ownership, permissions and drop-ins still match the inspected baseline; stop on
any change or unknown artifact. Stage the reviewed file in the same directory,
verify its bytes and appropriate owner and mode, then replace the known fragment
with the staged file. Do not overwrite an unknown object. The host repository's
`scripts/n5-neil.py install` is an initial/exact-match installer: it refuses a
differing existing unit and is not the upgrade command.

After successful installation and verification, reload Neil's user manager if the
unit changed, and start the same Shio unit; never run a parallel Partner:

```sh
systemctl --user daemon-reload # only if the unit changed
systemctl --user start codex-for-love-shio.service
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
Check authentication and public ingress protection, including unauthenticated
session rejection, without reading conversations or sending messages. Fetch
static resources only. This establishes installation and serving identity; it
does not establish resolution of historical provider 429 incidents.

For the current 6881-to-003d716 transition, if a failure requires rollback,
stop and inform the user first. Do not restore the old unit, restart 6881 or
modify configuration before the user's decision. The user has declined a
frontend change for this transition. As of 2026-11-03, 6881's compiled
contracts did not match the then-current App `latest`; the older 2b6a cache
had been verified resource by resource. This rule takes precedence over the
general rollback procedure below.

If promotion fails, first inspect the service, fragment, drop-ins and installation;
stop if their state or metadata is unknown. For the first transition, restore the
saved exact prior unit bytes, and any deliberately changed drop-in bytes, only over
the known promoted artifacts, using the retained 6881 prefix. For later updates,
stop the service and reinstall the previous version's separately retained,
SHA-512-verified tarball in the fixed prefix with the same npmjs registry and
`--ignore-scripts`; verify its installed version, native pin, dependencies and
compatible App before starting. A retained tarball is not a retained complete
dependency tree: immediate or offline rollback is not guaranteed. If npm reports
no change or the installed version is unexpected, inspect and reconcile the
actual installation; do not assume replacing bytes at one tarball path forces an
install or blindly repeat. Before any restart, verify the existing configuration
and data remain unchanged; reject conflicting concurrent changes. Do not edit,
copy or restore the TOML, instance state, credentials or conversations as part
of this rollback. Any such change requires separate authorization.

Validate that the rollback runtime accepts the unchanged configuration and existing
credentials without unauthorized edits. Verify that its authentication and public
ingress protection meet the required security boundary. If compatibility or
that boundary cannot be established, stop and report; do not
restart the old runtime. Otherwise, as Neil, run `systemctl --user daemon-reload`
and `systemctl --user restart codex-for-love-shio.service`, then verify the
rollback runtime's actual process and native identities, readiness, selected App
resources and authentication/ingress with the same checks above. Restoring a unit
does not restore the old process's memory or necessarily its selected App.

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
