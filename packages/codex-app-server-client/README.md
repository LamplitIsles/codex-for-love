# Codex App Server Client

Add a streaming Codex conversation to a Node.js app: show output as it arrives, route approval
requests to your UI, and interrupt or resume persisted conversations. The client manages the
app-server process, typed requests, and event routing so you can focus on your application's flow.

> Unofficial, independently implemented open-source project. Not affiliated with, sponsored by, or
> endorsed by OpenAI. Codex and OpenAI are trademarks of OpenAI.

**Package:** `@jaminzhou/codex-app-server-client`.
**Version covered:** `0.2.1`, a non-preview 0.x API, not a 1.0 stability commitment.
Check exact registry availability; a source checkout or local rebuild is not proof of publication.
See the [0.2.1 release guide](./docs/releases/0.2.1.md) and [migration notes from 0.1.0](./docs/api-diff-0.2.0.md).
The unscoped npm name belongs to a different project.

## Is this for your app?

Use this package for a long-lived Node.js host, terminal tool, or Electron **main process** that needs
conversation history, streamed events, and explicit approval callbacks over the public
[Codex app-server protocol](https://learn.chatgpt.com/docs/app-server). A browser or Electron renderer
needs a separate trusted Node.js host; this is not a browser SDK or a complete UI.

For simpler job automation, consider the [official Codex SDK](https://learn.chatgpt.com/docs/sdk).
This package is independently maintained and has its own pre-1.0 API.

## Requirements and support

- **Run an installed package:** Node.js 18+ with ESM (`.mjs` or `"type": "module"`).
  Use a currently maintained Node.js release for a new app.
- **Build from source / Git:** Node.js 22+ and pnpm 11.7.0. A Git install runs a build; a tarball
  already contains JavaScript, declarations, schemas, and examples.
- **Runtime:** client `0.2.1` pins `@openai/codex@0.154.0`. No global CLI installation is needed.
  The historical npm `0.1.0` archive still bundles `0.153.4`.
  Keep optional dependencies enabled because they carry the platform binary.
- **Platforms:** installed-package CI covers Linux, macOS, and Windows. Binary resolution supports
  x64 and arm64 where the pinned upstream CLI ships them; CI does not cover every architecture.
- **Transports:** managed local stdio by default; Unix socket attachment is also available.
  TCP WebSocket remains experimental for this pinned baseline.
- **Version boundary:** basic runtime smoke covers `0.150.1`, `0.152.1`, `0.153.4`, and `0.154.0`.
  Current rich turn/approval examples use `0.154.0`. Other releases are not implied compatible.

See [compatibility and upgrade guidance](./COMPATIBILITY.md) before changing the runtime.

## First run: no account or model usage required

Check availability, then install the exact version in a new consumer directory:

```bash
npm init -y
npm view @jaminzhou/codex-app-server-client@0.2.1 version --registry https://registry.npmjs.org/
npm install --save-exact --ignore-scripts --include=optional @jaminzhou/codex-app-server-client@0.2.1
node node_modules/@jaminzhou/codex-app-server-client/examples/stream.mjs
```

If the exact-version query reports that `0.2.1` is unavailable, it has not been made available in
that registry: use a verified local candidate below, or explicitly choose an available historical
release with its older feature set. Do not infer publication from a source checkout's version number.

Expected output:

```text
[mock] Real app-server, local provider, no model usage.
Hello from the local mock.
[turn] completed
```

The example starts the **real pinned app-server** with a temporary home/workspace and a scripted
loopback model provider. It requires no login, makes no model-service calls, and cleans up afterwards.
It tests integration plumbing; the mock text is not a model-quality or live-account test.

Two more complete examples exercise the interaction lifecycle:

```bash
node node_modules/@jaminzhou/codex-app-server-client/examples/approvals.mjs
node node_modules/@jaminzhou/codex-app-server-client/examples/interrupt-resume.mjs
```

They verify that a declined command never executes and that an interrupted conversation resumes
after restarting the app-server. See [example commands, output, and recovery](./examples/README.md).

Version `0.2.1` also includes [16 numbered equivalents of the official Python app-server examples](./docs/official-examples.md),
covering lifecycle, images, structured output, model selection, a small terminal loop, login cancellation
and untrusted `ExternalMessage` input with independent joined-turn handles.
Their public example references are unchanged, and they now run on the pinned `0.154.0` baseline.
These additions are not files in the immutable npm `0.1.0` archive.

## Install into your own project

Use the exact registry version above (or `pnpm add --save-exact --ignore-scripts
@jaminzhou/codex-app-server-client@0.2.1`). For unpublished source changes, build and
validate a local tarball instead:

```bash
# In the source checkout, using Node.js 22+:
pnpm release:pack
```

In a separate consumer directory, install the printed artifact path (the example below assumes
the checkout is a sibling directory):

```bash
npm init -y
npm install --ignore-scripts --include=optional ../codex-app-server-client/artifacts/jaminzhou-codex-app-server-client-0.2.1.tgz
node node_modules/@jaminzhou/codex-app-server-client/examples/stream.mjs
```

For pnpm, use `pnpm add --ignore-scripts <absolute-path-to-tarball>` instead. Tarball consumers do
not need to allow this package's build scripts or install a compiler. The preparation command
verifies the same tarball in clean npm and pnpm consumers, including declarations and all examples.

The initial preview publication used `--tag next`, but the registry also assigned `latest` to it.
At the `0.1.0` release verification, `latest` pointed to `0.1.0` and `next` retained the preview.
Neither tag is a stability guarantee. Pin the exact version and retain your lockfile.
See [release preparation](./RELEASING.md) and the [0.2.1 release gates](./docs/releases/0.2.1.md#release-gates).

If you need Git installation, pin a reviewed full SHA:
`npm install 'github:JaminZhou/codex-app-server-client#<full-commit-sha>'`.
Git installs need the `prepare` build. For pnpm 11, first add that exact source to your
consumer's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@jaminzhou/codex-app-server-client@https://codeload.github.com/JaminZhou/codex-app-server-client/tar.gz/<full-commit-sha>': true
```

Then run `pnpm add 'github:JaminZhou/codex-app-server-client#<full-commit-sha>'`.
See [troubleshooting](./examples/README.md#troubleshooting) if the binary or built files are missing.

## Run with your Codex account

The default examples above use no credentials. To opt into real model output, first authenticate
the same pinned CLI, under the same user and `CODEX_HOME` you will use for your app.
For client `0.2.1`:

```bash
npm exec --package=@openai/codex@0.154.0 -- codex login
npm exec --package=@openai/codex@0.154.0 -- codex login status
node examples/stream.mjs --live
```

For the historical client `0.1.0` archive, use its matching `@openai/codex@0.153.4` instead.

From an installed consumer, use
`node node_modules/@jaminzhou/codex-app-server-client/examples/stream.mjs --live`.
A headless machine can use `codex login --device-auth` through the same pinned command.
Applications can also use the client's [browser, device-code, and API-key login APIs](./docs/api.md#account-and-login-workflows).

ChatGPT sign-in uses the account's Codex entitlement and limits; API-key sign-in uses API billing.
Installing this MIT-licensed client does not include model usage, bypass limits, or add account
features. Availability also depends on the account, workspace policy, and configured provider.
See [official authentication guidance](https://learn.chatgpt.com/docs/auth).

`--live` uses the current working directory and the selected runtime's configuration/credentials,
may consume usage, and can persist conversation history. Review that directory and configuration
before running it. Keep auth files and tokens out of source control and logs. The examples use a
read-only sandbox and explicit decline handlers; your app must choose its own approval UI and policy.

## Build on the example

The [stream example](./examples/stream.mjs) shows `createThread()`, `startTurn()`, and
`for await ... turn.events()`. The [approval example](./examples/approvals.mjs) shows a typed
server-request callback. The [resume example](./examples/interrupt-resume.mjs) waits for interruption
to finish before reconnecting and resuming the saved thread ID.

The [API guide](./docs/api.md) covers collected results, raw typed `call()`, notifications,
login, goals, cancellation, transports, and exported protocol types. It documents limitations such
as one consumer per turn handle and no automatic reconnect/replay.

## Development and sources

```bash
pnpm check
pnpm package:smoke
```

[CONTRIBUTING.md](./CONTRIBUTING.md) describes CI and protocol regeneration.
[SOURCES.md](./SOURCES.md) records exact public provenance. Implementation sources are public CLI
bindings/schemas, open-source Codex, and official open-source SDKs; no private Codex Desktop code
or extracted application bundle is used.

The independently written client is MIT-licensed. Generated Codex bindings and schemas carry
OpenAI attribution under Apache-2.0; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
