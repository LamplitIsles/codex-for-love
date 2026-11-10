import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";

// Resolve the SDK's own declared ws dependency through its public schema export. This also
// works when examples are copied into a pnpm consumer without a direct ws dependency.
const require = createRequire(import.meta.url);
const packageRequire = createRequire(require.resolve(
  "@jaminzhou/codex-app-server-client/schemas/runtime-validation.schemas.json",
));

export async function startLoginFixture() {
  const { WebSocketServer } = packageRequire("ws");
  const messages = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    if (message.id === undefined) return;
    const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
    switch (message.method) {
      case "initialize":
        reply({ userAgent: "scripted-login-fixture", codexHome: "unused-fixture-home",
          platformFamily: "fixture", platformOs: "fixture" });
        break;
      case "account/login/start":
        assert.equal(message.params.type, "chatgpt");
        reply({ type: "chatgpt", loginId: "example-login", authUrl: "https://example.invalid/login" });
        break;
      case "account/login/cancel":
        assert.equal(message.params.loginId, "example-login");
        // Arrives before wait(): the SDK must retain this early completion notification.
        socket.send(JSON.stringify({ method: "account/login/completed",
          params: { loginId: "example-login", success: false, error: "Login canceled" } }));
        reply({ status: "canceled" });
        break;
      case "account/read":
        assert.equal(message.params.refreshToken, false);
        reply({ account: null, requiresOpenaiAuth: true });
        break;
      default:
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unexpected fixture method" } }));
    }
  }));
  await once(server, "listening");
  return {
    url: `ws://127.0.0.1:${server.address().port}`, messages,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function withLoginExample(run) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--live")) throw new Error("Usage: node 15_login_and_account.mjs [--live]");
  const live = args.includes("--live");
  let fixture, client, temporaryRoot;
  try {
    if (live) {
      temporaryRoot = mkdtempSync(join(tmpdir(), "codex-client-login-example-"));
      const codexHome = join(temporaryRoot, "codex-home");
      mkdirSync(codexHome);
      client = new CodexAppServerClient({ cwd: temporaryRoot, requestTimeoutMs: 15_000,
        env: { CODEX_HOME: codexHome, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
          OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined } });
      console.log("[live-auth] Starts and immediately cancels real OAuth in an isolated home. No browser is opened.");
    } else {
      fixture = await startLoginFixture();
      client = new CodexAppServerClient({ transport: { type: "websocket", url: fixture.url },
        protocolValidation: "strict", requestTimeoutMs: 5_000 });
      console.log("[mock-rpc] Scripted login lifecycle; no real app-server, OAuth, credentials, or model calls.");
    }
    await client.connect();
    await run({ client, live, fixture });
  } finally {
    try { await client?.close(); }
    finally {
      try { await fixture?.close(); }
      finally { if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    }
  }
  console.log("[example] login-account passed");
}
