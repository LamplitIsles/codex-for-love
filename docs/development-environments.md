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

As of the completed 2026-10-31 promotion, Shio runs the manually selected
Forgejo npm snapshot
`0.1.0-beta.0.snapshot.g6881b22d5eda6fdd6715867fdb6397666308adf4` from its
versioned prefix under `/home/neil/.local/share/codex-for-love/npm-releases/`.
Its Linux native package is `@lamplitisles/codex-for-love-linux-x64@0.7.0`
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

After current-head review and merge, manually select the exact Forgejo snapshot;
publication does not promote it automatically. Download its exact tarball and
verify its SHA-512 integrity against Forgejo registry metadata before installation.
Install the verified local tarball into an approved versioned npm prefix with
npmjs as the default registry and no scope override, using `--ignore-scripts` to
avoid building on the service host. A new dependency directory requires its own
concrete approval before creation. Do not overwrite an existing version prefix.
After installation, verify the package version and source identity, the manifest's
exact platform-native pin and architecture, and sharp/koffi native module loading.
Check the launcher,
`codex-app-server --version` and `codex-code-mode-host --help` without using live
conversations. Before changing the unit, verify that the candidate accepts the
existing configuration with the same path meanings and that the selected App
release's contracts match the package. Retain the exact prior unit, code, native
and dependency bytes needed for rollback, whether the prior installation is
source-based or packaged.

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
state. The exact prior unit was retained at
`/home/neil/.local/share/codex-for-love/rollback-units/shio-before-npm-50ze4gzs.service`
with mode `0600` and SHA-256
`74bfc2b86f1e62d58bd872381295caba587eb21e82f61fdece2cff28f8def9eb`;
verify it and the current unit metadata before considering rollback. An independent
checkout or build cache also requires its own concrete approval before creation.

The reviewed unit must expose curl on PATH and allow the documented GitHub
network access for uncached App releases. An omitted `frontend` selects `latest`; an explicit
full SHA pins the App. After restart, record
the resolved SHA from startup output and compare every served resource with that
revision’s cache manifest; `latest` may have advanced since review. Reload browser
pages. Preserve Post, Keet, credentials and all state unless a separately authorized
change requires otherwise. When the old and new runtime schemas differ, identify
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
update its launcher and working directory for the reviewed versioned package
prefix, preserving its existing configuration argument, pre-start gate,
environment-file references and other service behavior. The package launcher
selects its pinned native package. Its command has this form, with paths obtained
from the reviewed unit and package:

```text
<node24> <versioned-prefix>/node_modules/@lamplitisles/codex-for-love/bin/codex-for-love.mjs serve <existing-fixed-partner.toml>
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
Check authentication and public ingress protection, including unauthenticated
session rejection, without reading conversations or sending messages. Fetch
static resources only. This establishes installation and serving identity; it
does not establish resolution of historical provider 429 incidents.

If promotion fails, first inspect the fragment and drop-ins again; stop if their
bytes or metadata are unknown. Restore the saved exact prior unit bytes, and any
deliberately changed drop-in bytes, only over the known promoted artifacts, using
the retained code/native dependencies. Before any restart, verify the exact
expected current fields and reject conflicting concurrent changes. Apply only the
reviewed minimum schema-specific inverse edits in the existing TOML, preserving
relative-path meaning and preserving Post and Keet. Do not copy or restore
the full configuration, instance state, credentials or conversations as rollback.

Validate that the retained runtime accepts the resulting configuration and existing
credentials without unauthorized edits. Verify that its authentication and public
ingress protection meet the required security boundary. If compatibility, safe
field inversion or that boundary cannot be established, stop and report; do not
restart the old runtime. Otherwise, as Neil, run `systemctl --user daemon-reload`
and `systemctl --user restart codex-for-love-shio.service`, then verify the
retained runtime's actual process and native identities, readiness, selected App
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
