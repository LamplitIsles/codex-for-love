import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { startMockProvider } from "./mock-provider.mjs";

/** @type {import('@jaminzhou/codex-app-server-client/protocol').v2.AskForApproval} */
export const approvalPolicy = {
  granular: {
    sandbox_approval: true, rules: false, skill_approval: false,
    request_permissions: false, mcp_elicitations: false,
  },
};

export async function withExample(scenario, run, { allowInteractive = false } = {}) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--live" && !(allowInteractive && arg === "--interactive"))) {
    throw new Error("Usage: node <example.mjs> [--live]" + (allowInteractive ? " [--interactive]" : ""));
  }
  const live = args.includes("--live");
  const interactive = args.includes("--interactive");
  const temporaryRoot = live ? null : mkdtempSync(join(tmpdir(), "codex-client-example-"));
  const workspace = temporaryRoot ? join(temporaryRoot, "workspace") : process.cwd();
  let provider;
  let client;
  let timeout;
  let timedOut = false;
  try {
    const options = { requestTimeoutMs: 15_000, cwd: workspace };
    if (temporaryRoot) {
      mkdirSync(workspace);
      const codexHome = join(temporaryRoot, "codex-home");
      mkdirSync(codexHome);
      provider = await startMockProvider(scenario, workspace);
      writeFileSync(join(codexHome, "config.toml"), `model = "mock-model"
model_provider = "example_mock"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"

[model_providers.example_mock]
name = "Local example fixture"
base_url = "${provider.origin}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0

[features]
plugins = false
shell_snapshot = false
`);
      options.env = {
        CODEX_HOME: codexHome,
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        RUST_LOG: "warn",
      };
    }
    client = new CodexAppServerClient(options);
    if (!live && !interactive) {
      timeout = setTimeout(() => {
        timedOut = true;
        void client.close().catch(() => {});
      }, 45_000);
    }
    // The example never silently grants a command, file change, or permission request.
    client.onServerRequest("item/commandExecution/requestApproval", () => ({ decision: "decline" }));
    client.onServerRequest("item/fileChange/requestApproval", () => ({ decision: "decline" }));
    client.onServerRequest("item/permissions/requestApproval", () => ({ permissions: {}, scope: "turn" }));
    console.log(live ? "[live] Uses your Codex authentication and may consume model usage."
      : "[mock] Real app-server, local provider, no model usage.");
    await client.connect();
    if (live) {
      const account = await client.account(false);
      if (account.requiresOpenaiAuth && !account.account) {
        throw new Error("Sign in first: npm exec --package=@openai/codex@0.154.0 -- codex login");
      }
    }
    await run({
      client, live, provider, workspace, interactive,
      threadOptions: {
        cwd: workspace, sandbox: "read-only", approvalPolicy, approvalsReviewer: "user",
      },
    });
    if (timedOut) throw new Error("Mock example exceeded its 45-second deadline");
  } finally {
    clearTimeout(timeout);
    try { await client?.close(); }
    finally {
      try { await provider?.close(); }
      finally { if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    }
  }
  console.log(`[example] ${scenario} passed`);
}
