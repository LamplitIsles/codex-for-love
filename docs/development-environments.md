# Development-machine Partner environments

Use this document for host-local Partner installation, deployment, acceptance,
or service recovery. The enduring unit definitions belong to the Kosmos WSL
configuration; this is the operating contract for the three CFL targets.

## Canonical targets

| Target | User service | Runtime source | Configuration | Loopback port |
| --- | --- | --- | --- | ---: |
| Mika dev | `codex-for-love-dev.service` | current checkout | `~/.local/state/codex-for-love/dev/partner.toml` | 3082 (also LAN on `192.168.1.179`) |
| Mika staging | `codex-for-love-staging.service` | candidate snapshot when overridden; otherwise checkout | `~/.local/state/codex-for-love/staging/partner.toml` | 3083 |
| Shio prod | `codex-for-love-prod.service` | verified complete artifact, installed native package | `~/.local/state/codex-for-love/prod/partner.toml` | 3084 |

Each configuration owns a distinct state root, workspace, projection database,
attachments, persona, and official Codex thread. Mika dev and staging begin
with matching profile assets and Markdown, but their state and sessions remain
separate.

The root build consumes prepared adjacent App frontend and public contracts.
Production now serves an isolated bundled runtime and frozen resources, retaining
the installed native package and its existing configuration/state. Updating this
checkout or its build output affects dev only. Staging retains its separate
candidate snapshot. New production promotion uses reviewed, verified complete
artifacts; changing this checkout does not deploy production.

## Install and deploy dev

Build and check the checkout that the dev service will run:

```sh
pnpm source:prepare
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

The dev override must execute that checkout with the fixed dev configuration:

```ini
# ~/.config/systemd/user/codex-for-love-dev.service.d/release.conf
[Service]
ExecStart=
ExecStart=/run/current-system/sw/bin/node /absolute/path/to/codex-for-love/apps/partner/runtime/cli.ts serve /home/neil/.local/state/codex-for-love/dev/partner.toml
```

CFL always invokes `codex.command` as a direct `codex-app-server`; CFL
configurations do not select an executable type. The published launcher selects
the app-server from its main-package native dependency pin; a checkout may set
its direct app-server command. CFL owns the supported app-server version in
both paths. `codex.version` is not a supported TOML field; remove it from an
existing configuration before starting the updated runtime.

Reload, restart only dev, then verify the fixed endpoint:

```sh
systemctl --user daemon-reload
systemctl --user restart codex-for-love-dev.service
systemctl --user is-active codex-for-love-dev.service
ss -ltn '( sport = :3082 )'
curl --fail http://127.0.0.1:3082/
```

Record the candidate commit and HTTP result in the task handoff. This is a
serving-readiness check: do not send a Partner message, read a conversation, or
inspect credentials.

## Staging candidate preview

The Framework7 candidate `969185407263127a177011b1cc2f5384d1c7fd88`
is deployed behind the existing Kepos URL
`http://staging-her.localhost:17480/` (Mac and Pixel 7a ACL). The direct
`http://127.0.0.1:3083/` endpoint is for publisher-local readiness checks.
Its committed Partner source and
verified build are copied to
`~/.local/share/codex-for-love/staging-candidates/<commit>/apps/partner`.
The snapshot uses the checkout's installed Node dependencies through symlinks;
it is a local preview, not a standalone release package.

`~/.config/systemd/user/codex-for-love-staging.service.d/candidate.conf`
overrides only `ExecStart` to run the candidate's `runtime/cli.ts` with the
existing staging TOML. Existing state, service credentials and configuration
stay with staging. Only the staging service is restarted. The shared checkout
build and production service are untouched.

After restarting, verify port 3083, compare the served HTML and entry assets
with the verified build, and confirm the production homepage and process are
unchanged. Do not send a message or read conversations for this readiness check.

To return staging to its configured checkout launcher, remove only the
`candidate.conf` override, reload user systemd, and restart only staging.
Retain the candidate directory while it is in use.

## Prepare and promote dev then prod

Production currently serves the unchanged `1263eb20` isolation snapshot under
`~/.local/share/codex-for-love/prod-candidates/1263eb20c9a73462ba0ad48ee068635b97af004d`.
It is independent of checkout build/dependencies. Its Sharp 0.34.5 resolves from
the stable installed prod prefix, which must remain available. Staging's existing
`9691854` snapshot remains untouched.

After review/merge, Orc synchronizes `main` through `og`, prepares clean App
source at `lamplit-app.sha`, then runs the frozen CFL sequence and strict package
checks from [source preparation](default-shared-frontend.md). Keep the verified
tarball immutable: record its SHA256, reviewed CFL commit, App commit, and the
`vendor/source.json` resource hashes. Extract that exact tarball once under
`~/.local/share/codex-for-love/candidates/<cfl-commit>/package`; install the declared
Sharp version into a separate stable candidate dependency prefix and link its
`node_modules` into the extracted package. Verify Sharp binary loading and the
fake-engine package smoke before touching a live launcher. Do not use symlinks to
this mutable checkout's dependencies.

Preserve each target's prior launcher override bytes for rollback. Update only
its ExecStart to `/run/current-system/sw/bin/node <candidate>/package/vendor/runtime/cli.mjs`
with its existing fixed TOML. For prod retain the existing `--native-package-root`
argument below and environment file; dev retains its configured direct native
command. Reload, sequentially restart the same dev service, and verify port 3082,
process identity and every served browser hash against the candidate manifest.
Only after dev readiness, perform the same operation on prod port 3084 with the
identical extracted candidate bytes. Never start a parallel instance or copy
state, conversations, workspace, configuration or credentials.

Budget up to 120 seconds with short readiness polls; the unchanged production
snapshot took about 33 seconds from service activation through all resource
hash checks during isolation. Abort early on process
failure/restart loops. An initial 10-second isolation timeout was rolled back
and the original launcher recovered; a longer controlled retry verified all 508
original static resources. HTTP readiness alone does not prove resource identity.
Fetch only static resources; do not inspect conversations or send messages.

On failure, restore that target's prior override bytes, reload and restart the
same service, then wait for original readiness and original resource hashes.
Retain prior code/assets and dependency prefixes until rollback is no longer
needed. Rollback never restores instance state. The initial isolation override
backup is in the task's local `.scratch/sha-pinned-shared-frontend/` evidence.
New feature deployment remains Orc-owned after whole-spec review/merge; merge,
local checks and the initial isolation do not establish new-feature deployment.

Reuse the installed CFL native package from the stable
`~/.local/share/codex-for-love/prod-current` prefix. Before restarting, resolve
`@lamplitisles/codex-for-love-linux-x64/package.json` relative to the installed
main package and verify its version equals the exact native pin in this
checkout's `packages/codex-for-love/package.json`. Verify the direct app-server
version and code-mode helper availability. If the pin changes, install the
matching public native package before deploying; never substitute the ordinary
Codex CLI or rebuild native artifacts as part of an application-only update.

The production override selects the verified native package root through the
existing CLI argument, preserving the production TOML without an executable
override:

```ini
# ~/.config/systemd/user/codex-for-love-prod.service.d/release.conf
[Service]
EnvironmentFile=/home/neil/.local/state/keet-mcp/gateway.env
ExecStart=
ExecStart=/run/current-system/sw/bin/node <candidate>/package/vendor/runtime/cli.mjs --native-package-root /home/neil/.local/share/codex-for-love/prod-current/lib/node_modules/@lamplitisles/codex-for-love/node_modules/@lamplitisles/codex-for-love-linux-x64 serve /home/neil/.local/state/codex-for-love/prod/partner.toml
```

Keep the native package at that root available across application deployments.
Main-package npm publication remains available for other installations and is
separate from this host's production deployment.

After an explicitly authorized production deployment, reload and verify only
the production service:

```sh
systemctl --user daemon-reload
systemctl --user restart codex-for-love-prod.service
systemctl --user is-active codex-for-love-prod.service
ss -ltn '( sport = :3084 )'
curl --fail http://127.0.0.1:3084/
```

Do not restart production during a dev rollout or replace either target's state
as a recovery shortcut.

## Kosmos follow-up

Kosmos currently requires `flicknote`, `project`, and `web` on the base
launcher's service `PATH`. That host-policy guard is outside this repository
and does not match CFL's Companion-only runtime readiness contract. A normal
Kosmos-unit rollout must remove that guard in a separate Kosmos change; a
checkout-based dev override does not prove the base launcher is fixed.

## Isolated implementation acceptance

Workers for default-shared-frontend use test-owned fixtures only; the canonical
services above are for later Owner verification. They do not restart or reconfigure
these targets. Current commands and shared/native/browser evidence boundaries are
in [default-shared-frontend.md](default-shared-frontend.md). `/` is the standalone
entry; `/chat` serves the same App. Platform owns hosted auth, manifest, service
worker and management independently. `LAMPLIT_APP_ASSETS` and `/slice` are removed.
