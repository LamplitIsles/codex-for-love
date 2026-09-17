# Development-machine Partner environments

Use this document for host-local Partner installation, deployment, acceptance,
or service recovery. The enduring unit definitions belong to the Kosmos WSL
configuration; this is the operating contract for the two CFL targets.

## Canonical targets

| Target | User service | Runtime source | Configuration | Loopback port |
| --- | --- | --- | --- | ---: |
| Mika dev | `codex-for-love-dev.service` | current checkout | `~/.local/state/codex-for-love/dev/partner.toml` | 3082 |
| Shio prod | `codex-for-love-prod.service` | selected installed CLI | `~/.local/state/codex-for-love/prod/partner.toml` | 3084 |

Each configuration owns a distinct state root, workspace, projection database,
attachments, persona, and official Codex thread. Never copy state between the
two targets.

## Install and deploy dev

Build and check the checkout that the dev service will run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
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
its direct app-server command.

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

## Install and deploy prod

Production uses the published CLI in an explicit, stable prefix rather than a
checkout. Install the approved version, then validate the installed executable:

```sh
npm install --global --ignore-scripts --prefer-online --prefix /home/neil/.local/share/codex-for-love/prod-current @lamplitisles/codex-for-love@<approved-version>
/home/neil/.local/share/codex-for-love/prod-current/bin/codex-for-love --help
```

The published launcher resolves its platform-native app-server exclusively from
the main package's exact `optionalDependencies` pin. A native-only npm
publication is therefore available for a later main release but is not itself a
production deployment. Keep `codex.command` absent from the production Partner
TOML; `codex.provenance` is not a supported setting. Checkout development is
the only path that selects a direct executable path.

Point the production override at that stable executable and its fixed production
configuration:

```ini
# ~/.config/systemd/user/codex-for-love-prod.service.d/release.conf
[Service]
ExecStart=
ExecStart=/home/neil/.local/share/codex-for-love/prod-current/bin/codex-for-love serve /home/neil/.local/state/codex-for-love/prod/partner.toml
```

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
