# Post v1 consumer activation: historical cutover

Authority: CFL FlickNote #4067, producer #4066; immutable initial contract
`ef2fa54ec90630bad5b38b2768a13b7bf543dc4c`. This document records the earlier
generic Post v1 cutover and is not evidence of deployment or live QQ/Matrix
acceptance. Its historical multi-instance assumptions are not N5 instructions.
For current N5 Shio promotion and rollback, use
[canonical environments](development-environments.md): preserve Post and keep
Keet disabled as requested. Do not invent dev or staging targets.

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
```

For optional package validation, separately run:

```sh
pnpm release:prepare "$PWD/.scratch/post-v1-consumer/artifacts" --strict
pnpm release:check
node scripts/packaged-frontend-smoke.mjs /absolute/path/to/exact-artifact.tgz
sha256sum /absolute/path/to/exact-artifact.tgz
```

Record CFL full HEAD, Post tested full HEAD, contract revision, App full pin,
native dependency pins and prepared contract/license hashes. For a packaged
artifact, also record its hash and `vendor/source.json` contract/license hashes.
The producer implementation may advance past the contract commit, but must retain
its reviewed public contract. Tests use the Node fake Post and existing fake
app-server; actual Post+CFL integration is a separate Orc-assigned probe using
owned fixtures after both Workers finish. Do not copy live credentials or
conversations for a probe. No native rebuild or npm publication is required.

For current Shio source promotion follow the candidate and rollback procedure in
[canonical environments](development-environments.md). Packaging and publishing
are optional; never link a candidate to mutable checkout dependencies. Preserve old
candidate/dependency/native bytes. Native builds are not part of this cutover.

## Historical cutover boundary

The earlier cutover used separate development and production instances and
coordinated a Matrix-to-Post ownership change. It required the operator to
identify the exact QQ/Matrix accounts and Post binding, hold dispatch during
receiver changes, avoid parallel receivers and duplicate intake, and preserve
the same workspace, native thread, durable queue and immutable receipts. Its
instance names, ports and integration choices do not describe current N5 Shio.

When inspecting any unresolved admission or send, retain the existing identity
and reconcile the outcome; do not replay old webhook bodies or retry an uncertain
send with a different request ID. Actual platform delivery and sending require
separate authorized acceptance. Current Shio's launcher, configuration and
rollback follow [canonical environments](development-environments.md), including
its authentication boundary and prohibition on full config or state restoration.
