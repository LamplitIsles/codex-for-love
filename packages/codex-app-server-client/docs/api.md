# API guide

This guide describes the public API in the pinned runtime. Start with the [README](../README.md)
and [runnable examples](../examples/README.md) for installation, authentication, and recovery.

## Transports

The default is a managed local stdio child process:

```ts
const client = new CodexAppServerClient();
```

To attach to an app-server already listening on its local control socket:

```ts
const client = new CodexAppServerClient({
  transport: { type: "unix" },
});
```

The default socket is
`$CODEX_HOME/app-server-control/app-server-control.sock` (or the equivalent under `~/.codex`).
Pass an absolute `socketPath` to connect elsewhere. Unix mode performs the standard WebSocket HTTP
Upgrade over that socket; it does not spawn or own the app-server process.

TCP WebSocket is exposed because it is part of the public CLI, but upstream labels it experimental
and unsupported. Do not treat it as a production-supported upstream transport:

```ts
const client = new CodexAppServerClient({
  transport: {
    type: "websocket",
    url: "wss://codex-host.example/ws",
    bearerTokenEnv: "CODEX_APP_SERVER_TOKEN",
  },
});
```

The transport omits `Origin`, disables redirects and compression, bounds handshake time and inbound
payload size, and rejects plaintext `ws://` to non-loopback hosts unless
`allowInsecureRemote: true` is explicitly set. Local-process launch options are rejected when an
attach transport is selected so they cannot be silently ignored.

## Complete typed protocol access

`call()` derives its parameter type from generated `ClientRequest` bindings and its result type from the matching public Rust protocol response type:

```ts
const page = await client.call("thread/list", {
  limit: 20,
  sortDirection: "desc",
});

for (const thread of page.data) {
  console.log(thread.id);
}

// Methods whose protocol params are undefined require no second argument.
await client.call("account/logout");
```

For forward compatibility or deliberately untyped extensions, `request<T>(method, params)` remains available as a raw escape hatch.

## Runtime protocol validation

Generated Schema validation is enabled by default. Before writing, known client requests and
notifications are checked against the pinned protocol. Incoming known responses, notifications,
server requests, and typed server-request handler results are checked before they enter high-level
routing. A malformed known response or notification closes the mismatched connection instead of
letting invalid data contaminate client state.

Unknown method names remain available to generic handlers and raw `request()` calls without being
rejected, preserving a deliberate forward-compatibility path. Disable validation only for explicit
version-skew experiments:

```ts
const client = new CodexAppServerClient({
  protocolValidation: "off",
});
```

Validation preserves `bigint` values in its private comparison copy and enforces the public Rust
integer formats (`int32`, `int64`, `uint`, `uint16`, `uint32`, and `uint64`) without lossy number
conversion. Integer-valued `double` fields remain doubles across the full finite JavaScript range.
The value sent to or received from app-server remains lossless. The upstream generator does not
currently export response Schema for three deprecated compatibility methods: `getAuthStatus`,
`getConversationSummary`, and `gitDiffToRemote`. Their request parameters remain validated and
their responses remain statically typed, but their response payloads are the explicit runtime
validation exceptions reported by `protocolValidationMetadata`.

## Account and login workflows

Account methods operate on the `CODEX_HOME` used by the connected app-server. API-key login is a
single request; interactive ChatGPT login returns a live handle whose completion notification is
buffered even if it arrives before the start response:

```ts
const login = await client.loginChatGPTDeviceCode();
console.log(login.verificationUrl, login.userCode);

const completed = await login.wait({ timeoutMs: 5 * 60_000 });
if (!completed.success) throw new Error(completed.error ?? "Login failed");

const account = await client.account(true);
console.log(account.account);
```

Use `login.cancel()` to cancel that specific attempt. `loginChatGPT()` exposes the equivalent
browser flow through `authUrl`; `loginApiKey()` and `loginChatGPTAuthTokens()` cover the other
generated public login variants. Do not log API keys, access tokens, or raw auth-token parameters.

## Thread, turn, and goal handles

```ts
const thread = await client.resumeThread(savedThreadId);
const turn = await thread.startTurn("Continue from the previous result.");

for await (const notification of turn.events()) {
  if (notification.method === "item/agentMessage/delta") {
    process.stdout.write(notification.params.delta);
  }
}
```

Each turn **handle** has a single consumer. Use either `turn.events()` for manual streaming or `turn.result()` / `thread.run()` to collect the final response, completed items, final turn state, and token usage.

### Untrusted external messages

```ts
import { ExternalMessage } from "@jaminzhou/codex-app-server-client";

await thread.run("Summarize deployment notifications. Do not deploy or change files.");
const result = await thread.run(new ExternalMessage({
  toolName: "notifications",
  namespace: "slack", // Optional; omitted becomes null.
  content: "Staging health check returned HTTP 503.",
}), { turnTrigger: "slack_notification" });
```

`content` accepts text or generated `FunctionCallOutputContentItem` objects (`input_text`,
`input_image`, `input_audio`, `encrypted_content`). It is sent as `toolOutput`, with empty user
input, and remains tool-level content—not user permission, instructions or an approval. Pass an
`ExternalMessage` as the whole input to `client.startTurn()`, `thread.startTurn()` or `thread.run()`.
Mixing it with user-input arrays or passing it to `turn.steer()` is rejected. Do not also specify a
second `toolOutput` option. `turnTrigger` maps to Python's `source` and grants no additional authority.

An external message can join an active regular turn. The returned handle then has the **same turn
ID**, but its own event consumer, so both handles can independently call `result()`. Joining replays
completed items, latest usage and unread events; historical consumed token deltas are not retained.
Early completion before the joining RPC response is preserved. An iterator's `return()` releases
that reader only; `interrupt()` requests a server-side interruption visible to every handle.

Tool-output requests require a reported CLI version of at least `0.151.0`. Unknown versions and
prereleases at the minimum are rejected before submission, including raw `call("turn/start", ...)`
and `protocolValidation: "off"`; disabling shape checks cannot establish this semantic capability.
Client `0.2.0` bundles the verified `0.154.0` runtime (the original implementation was verified on `0.153.4`).
This API is introduced in `0.2.0`, not present in npm `0.1.0`.

### Goals

Persisted thread goals are also available at both the raw typed layer and through `CodexThread`:

```ts
const thread = await client.resumeThread(savedThreadId);
const goal = await thread.startGoal("Keep fixing failures until every quality gate passes", {
  tokenBudget: 200_000,
});

const result = await goal.result();
console.log(result.finalResponse);
```

`startGoal()` requires an idle, persisted thread. It replaces the stored goal, waits for the
runtime-generated first turn, and represents later automatic physical turns as a single logical
turn whose ID is the first physical turn ID. Intermediate `turn/started` and `turn/completed`
notifications are suppressed from that logical stream, while ordinary notification handlers still
receive the original physical events. Terminal goal states (`paused`, `blocked`, `usageLimited`,
`budgetLimited`, and `complete`) end the logical stream after the active physical turn finishes.
Call `goal.pause()` to update the stored goal and interrupt the current physical turn on a
best-effort basis.

## Typed notifications and server requests

Handlers can be registered before or after `connect()`:

```ts
client.onNotification("turn/completed", ({ threadId, turn }) => {
  console.log(threadId, turn.status);
});

client.onServerRequest("item/fileChange/requestApproval", async (params) => {
  console.log(params.itemId, params.reason);
  return { decision: "decline" };
});

client.onError((error) => {
  console.error("handler error", error);
});
```

Unhandled server requests receive JSON-RPC method-not-found. The client does not auto-approve commands or file changes.

## Cancellation, timeouts, and retry

```ts
import { retryOnAppServerOverload } from "@jaminzhou/codex-app-server-client";

const controller = new AbortController();

const thread = await retryOnAppServerOverload(
  () =>
    client.call(
      "thread/read",
      { threadId: savedThreadId, includeTurns: true },
      { signal: controller.signal, timeoutMs: 10_000 },
    ),
  { maxAttempts: 3 },
);
```

Only overload-classified JSON-RPC failures are retried. Invalid requests, invalid params, authentication failures, and application errors are not retried automatically.

W3C trace context can be attached to any request:

```ts
await client.call(
  "thread/read",
  { threadId: savedThreadId },
  {
    trace: {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  },
);
```

## Protocol exports

```ts
import type {
  ServerNotification,
  v2,
} from "@jaminzhou/codex-app-server-client/protocol";

import { protocolMetadata } from "@jaminzhou/codex-app-server-client/protocol";
```

JSON Schema artifacts are included under `schemas/` in the package.

The generated Rust 64-bit integer fields are normalized to `number | bigint` to match the JSONL
transport: safe integer literals remain numbers, while larger integer literals are parsed and
serialized losslessly as bigints. Pass integer values outside the safe `number` range as `bigint`
before JavaScript rounds them; once a value is a `number`, the transport cannot distinguish an
already-rounded integer from a valid integer-valued double such as `1e16`. Non-finite numbers are
rejected instead of being silently converted to `null`, and custom numeric request IDs follow the
upstream signed 64-bit integer contract; fractional or out-of-range IDs are rejected before they can
break response correlation. JSON-RPC error codes follow the same signed 64-bit normalization, so
large valid codes remain `bigint` instead of being rejected or rounded. Finite double-valued protocol
fields remain supported across their full JavaScript range.

The generated surface includes experimental methods and fields so rich clients can opt in through `InitializeCapabilities.experimentalApi`. Experimental APIs can change between Codex CLI releases; pin the client version and run compatibility tests before upgrading.

See [COMPATIBILITY.md](../COMPATIBILITY.md) for the verified transport and protocol matrix, plus the
remaining high-level parity work.

## CLI resolution

By default the client resolves this dependency chain:

```text
@jaminzhou/codex-app-server-client
└── @openai/codex (exact version)
    └── platform-specific Codex binary
```

It does not search the global `PATH`. To override this intentionally:

```ts
const client = new CodexAppServerClient({
  codexPath: "/absolute/path/to/codex",
});
```

For an explicit standalone app-server executable, also set `codexExecutableType: "app-server"`.
The default `"cli"` mode inserts the `app-server` subcommand; standalone mode passes `--listen
stdio://` directly. Standalone mode requires `codexPath`. These process-launch options apply only
to managed stdio, and do not establish compatibility with another runtime version.
