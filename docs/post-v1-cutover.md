# Post v1 consumer activation and rollback

Authority: CFL FlickNote #4067, producer #4066; immutable initial contract
`ef2fa54ec90630bad5b38b2768a13b7bf543dc4c`. Orc owns activation after both PRs
pass independent Standards and high-risk spec review and merge. This runbook is
preparation, not evidence of deployment or live QQ/Matrix acceptance. It changes
only relevant code/config wiring; existing instance state and native threads stay
in place. Staging is outside scope.

## Prepare immutable evidence

Use Node 24, pnpm pinned in package.json and App Bun 1.3.14. Follow
[shared source preparation](default-shared-frontend.md) and
[canonical environments](development-environments.md). Work from reviewed clean
CFL main and a clean exact `lamplit-app.sha` source. For an isolated source, keep
`CFL_APP_SOURCE` set through preparation, build and packaging:

```sh
pnpm source:prepare --strict
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm release:prepare "$PWD/.scratch/post-v1-consumer/artifacts" --strict
pnpm release:check
node scripts/packaged-frontend-smoke.mjs /absolute/path/to/exact-artifact.tgz
sha256sum /absolute/path/to/exact-artifact.tgz
```

Record CFL full HEAD, Post tested full HEAD, contract revision, App full pin,
native dependency pins, artifact hash and `vendor/source.json` resource hashes.
The producer implementation may advance past the contract commit, but must retain
its reviewed public contract. Tests use the Node fake Post and existing fake
app-server; actual Post+CFL integration is a separate Orc-assigned probe using
owned fixtures after both Workers finish. Do not copy live credentials or
conversations for a probe. No App/native rebuild or npm publication is required.

Extract exactly that tarball into a stable immutable candidate. Install the
package-declared Sharp version into its separate stable dependency prefix; never
link a candidate to checkout dependencies. Verify Sharp loading, built `--help`
and fake-engine package smoke. Reuse the installed native package and verify its
version equals the main-package pin, direct app-server version is 0.159.1 and
same-version code-mode helper exists. Preserve old candidate/dependency bytes.
Native builds are not part of this cutover.

## Resolve actual ownership before changing wiring

Read only safe systemd metadata for each target (`ExecStart`, environment-file
paths, working directory, process identity); do not dump environment values,
private configuration or conversations. Expected services are
`codex-for-love-dev.service` / port 3082 and
`codex-for-love-prod.service` / port 3084, using their separate fixed TOMLs in
`~/.local/state/codex-for-love/{dev,prod}/partner.toml`. Follow current actual
launchers, not a historical candidate named in documentation. Preserve exact
prior override bytes privately and record which config keys/environment-file
references will change. Do not copy or replace instance state/workspace/thread
markers, credentials or conversations. No parallel receiver may share a workspace.

Have the operator identify the specific QQ App/account, Matrix account and exact
Post agent binding for each recipient. Post provisions its own encrypted account
credentials, API token, receiver credential and admitted scopes/wake options.
Each CFL instance requires its own recipient identity and distinct API/receiver
secrets. Human-only provisioning must supply those exact missing values; never
infer them from another account or expose them in argv/logs. Establish whether
the old Matrix gateway and environment-file owner serve other consumers. Stop
only the conflicting Matrix credential/session owner for the intended account;
never stop a shared gateway used by other consumers. Keet and Companion stay.

## Activate consumer before dispatch, dev then prod

1. Hold Post dispatch for the new receiver. Disable only the replaced instance's
   old Matrix webhook; preserve its configuration for code/config rollback.
   Do not enable dual ingestion, replay old Matrix gateway history or reclassify
   historical platform sync as live input.
2. Have the operator provision the exact Post binding with upstream account
   credentials and admitted conversation/private-sender rules, keeping its
   notification dispatch held. Ensure `/mcp` and asset API are available with
   agent authentication. Configure CFL `[post]` origin/`agent_id` and provision
   `post` / `post_receiver` through stdin. Remove only obsolete `[matrix]`, the
   `matrix` key in private CFL credentials, and Matrix-specific service environment
   references/overrides. Preserve unrelated credential keys/environment files,
   existing Keet/search settings and prod `--native-package-root`. Never print
   private files or replace the whole credentials file with a partial template.
3. Change only dev's launcher to the immutable candidate and fixed dev TOML.
   Reload user systemd and restart dev, with no other target restart. Startup
   validates Post accounts and reconciles the owned workspace MCP declarations.
   Check process identity, port 3082 and every static resource hash against the
   exact candidate, allowing up to 120 seconds with short polls. Abort on restart
   loops. HTTP/static readiness is not a message test.
4. Enable only that Post binding's dispatch to
   `http://127.0.0.1:3082/api/post/events` with its receiver secret. Use producer
   safe readiness/backlog checks and explicit authorized asset/API probes.
   Obtain user-originated QQ and Matrix marker messages in the intended scopes,
   including one usable image and one file. Verify delivery ACK/pending facts,
   exact source/reply/account identifiers, attachment availability and one existing
   Partner thread, with no duplicate input on a controlled delivery retry and no
   automatic external reply. Inspect only these explicitly authorized markers.
   If explicit send acceptance is authorized, use the native `post` MCP target
   and one stable request ID; an uncertain result requires reconciliation, never
   a new blind send. Workers do not send these real markers or replies.
5. After dev acceptance, repeat the same controlled config/launcher promotion
   for prod port 3084 using identical candidate bytes, its own separate binding
   and fixed prod TOML. Retain the installed native-package root. Verify prod
   process/static hashes and user-originated markers separately. Do not restart
   staging or treat dev evidence as production evidence.
6. Retire only the replaced per-instance Matrix credential/MCP/webhook ownership
   once both targets are accepted. Preserve historical Matrix SQLite provenance
   and all native history. Record actual Post+CFL HEADs, artifact/resource hashes,
   target readiness and marker outcomes. Missing credentials, account grants,
   human markers or actual integration evidence remain explicitly pending.

## Rollback without replay or outgoing resend

Hold the affected Post binding's notification dispatch first; preserve its durable
queue and immutable receipts. Restore that target's prior launcher bytes and
only the relevant reviewed prior configuration/environment references, reload
and restart the same service. Verify original readiness/resource hashes. Do not
restore a database snapshot, delete Post receipt/pending/source tables, roll back
conversations, change native thread identity, or copy another instance's state.
Old code leaves new versioned tables intact. Already admitted new inputs remain
part of the same native conversation. If Post is re-enabled, exact delivery IDs
remain deduplicated; held/unresolved inputs require inspection. Restore the old
Matrix owner only after confirming Post dispatch is held and duplicate live
intake cannot occur. Never replay old webhook bodies or retry an uncertain send
with a different request ID. Keep prior artifacts until the operator closes the
rollback window.
