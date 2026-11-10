import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerClient,
  protocolMetadata,
  resolveCodexBinary,
} from "../src";
import type {
  CommandExecutionRequestApprovalParams,
} from "../src/generated/protocol/v2/CommandExecutionRequestApprovalParams";
import { MockResponsesServer } from "./mock-responses-server";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("codex app-server integration", () => {
  it("resolves the version-matched local CLI package", () => {
    const resolved = resolveCodexBinary();
    const version = execFileSync(resolved.executablePath, ["--version"], { encoding: "utf8" });
    expect(version.trim()).toBe(`codex-cli ${protocolMetadata.codexCliVersion}`);
  });

  it("fails fast when an explicit Codex binary cannot be spawned", async () => {
    const observed: Error[] = [];
    const client = new CodexAppServerClient({
      codexPath: "/definitely/missing/codex",
    });
    client.onError((error) => observed.push(error));

    await expect(client.connect()).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.state).toBe("disconnected");
    expect(observed).toHaveLength(1);
  });

  it(
    "closes safely during startup and serializes a requested reconnect",
    async () => {
      const codexHome = createTestCodexHome("codex-app-server-client-race-test-");
      const client = new CodexAppServerClient({
        env: { CODEX_HOME: codexHome },
        requestTimeoutMs: 10_000,
      });

      const initialConnection = client.connect();
      const initialOutcome = initialConnection.then(
        () => null,
        (error: unknown) => error,
      );
      const closing = client.close();
      const reconnected = client.connect();

      await closing;
      expect(await initialOutcome).toBeInstanceOf(Error);
      const initialization = await reconnected;
      expect(realpathSync(initialization.codexHome)).toBe(realpathSync(codexHome));
      expect(client.state).toBe("connected");
      await client.close();
      expect(client.state).toBe("disconnected");
    },
    20_000,
  );

  it(
    "initializes over stdio and performs a typed-protocol request",
    async () => {
      const codexHome = createTestCodexHome("codex-app-server-client-test-");
      const client = new CodexAppServerClient({
        env: { CODEX_HOME: codexHome },
        requestTimeoutMs: 10_000,
      });

      try {
        const firstConnection = client.connect();
        const secondConnection = client.connect();
        expect(secondConnection).toBe(firstConnection);
        const initialization = await firstConnection;
        expect(initialization.userAgent).toContain("codex");
        expect(realpathSync(initialization.codexHome)).toBe(realpathSync(codexHome));
        expect(client.state).toBe("connected");

        const response = await client.call("thread/list", { limit: 1 });
        expect(response.data).toEqual([]);
        expect(response.nextCursor).toBeNull();

        await expect(client.account(false)).resolves.toMatchObject({
          account: null,
          requiresOpenaiAuth: true,
        });

        const thread = await client.createThread({ cwd: codexHome });
        expect(thread.id).toMatch(/^[0-9a-f-]+$/i);
        const read = await thread.read();
        expect(read.thread.id).toBe(thread.id);
        await expect(thread.goal()).resolves.toEqual({ goal: null });
        await expect(thread.clearGoal()).resolves.toEqual({ cleared: false });
        await expect(thread.setName("integration test")).resolves.toEqual({});
      } finally {
        await client.close();
      }
      expect(client.state).toBe("disconnected");
    },
    20_000,
  );

  it(
    "runs and streams turns through a real app-server with a local Responses provider",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-app-server-client-turn-test-"));
      temporaryDirectories.push(root);
      const codexHome = join(root, "codex-home");
      const workspace = join(root, "workspace");
      mkdirSync(codexHome);
      mkdirSync(workspace);

      const responses = new MockResponsesServer();
      await responses.start();
      responses.enqueueAssistantMessage("Hello from the local mock.", "run-1");
      responses.enqueueStreamingAssistantMessage(["Streamed ", "response."], "stream-1");
      writeFileSync(
        join(codexHome, "config.toml"),
        mockProviderConfig(responses.origin),
      );

      const client = new CodexAppServerClient({
        cwd: workspace,
        env: {
          CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
          CODEX_HOME: codexHome,
          RUST_LOG: "warn",
        },
        requestTimeoutMs: 10_000,
      });

      try {
        await client.connect();
        const thread = await client.createThread({ cwd: workspace });
        const result = await thread.run("hello real app-server");
        expect(result.finalResponse).toBe("Hello from the local mock.");
        expect(result.turn.status).toBe("completed");
        expect(result.usage).not.toBeNull();

        const streamedTurn = await thread.startTurn("stream real app-server");
        const events = [];
        for await (const event of streamedTurn.events()) events.push(event);
        expect(events.some((event) => event.method === "turn/started")).toBe(true);
        expect(
          events.some(
            (event) =>
              event.method === "item/agentMessage/delta" &&
              event.params.delta === "Streamed ",
          ),
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.method === "item/completed" &&
              event.params.item.type === "agentMessage" &&
              event.params.item.text === "Streamed response.",
          ),
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.method === "turn/completed" && event.params.turn.status === "completed",
          ),
        ).toBe(true);

        expect(responses.requests).toHaveLength(2);
        expect(responses.requests.map((request) => request.path)).toEqual([
          "/v1/responses",
          "/v1/responses",
        ]);
        expect(responses.requests.map((request) => request.body.stream)).toEqual([
          true,
          true,
        ]);
        expect(lastUserText(responses.requests[0]?.body)).toBe("hello real app-server");
        expect(lastUserText(responses.requests[1]?.body)).toBe("stream real app-server");
      } finally {
        await client.close();
        await responses.close();
      }
    },
    30_000,
  );

  it(
    "handles a real app-server command approval without executing the declined command",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-app-server-client-approval-test-"));
      temporaryDirectories.push(root);
      const codexHome = join(root, "codex-home");
      const workspace = join(root, "workspace");
      const marker = join(workspace, "declined-command-must-not-run");
      mkdirSync(codexHome);
      mkdirSync(workspace);

      const responses = new MockResponsesServer();
      await responses.start();
      responses.enqueueFunctionCall(
        "exec_command",
        {
          cmd: `touch ${JSON.stringify(marker)}`,
          workdir: workspace,
        },
        "call-decline",
        "approval-1",
      );
      responses.enqueueAssistantMessage("The command was declined safely.", "approval-2");
      writeFileSync(
        join(codexHome, "config.toml"),
        mockProviderConfig(responses.origin, "on-request", "user"),
      );

      const client = new CodexAppServerClient({
        cwd: workspace,
        env: {
          CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
          CODEX_HOME: codexHome,
          RUST_LOG: "warn",
        },
        requestTimeoutMs: 10_000,
      });
      let approval: CommandExecutionRequestApprovalParams | null = null;
      client.onServerRequest("item/commandExecution/requestApproval", (params) => {
        approval = params;
        return { decision: "decline" };
      });

      try {
        await client.connect();
        const thread = await client.createThread({
          approvalPolicy: {
            granular: {
              sandbox_approval: true,
              rules: false,
              skill_approval: false,
              request_permissions: false,
              mcp_elicitations: false,
            },
          },
          approvalsReviewer: "user",
          cwd: workspace,
        });
        const result = await thread.run("try the mocked command");

        expect(approval).toMatchObject({
          command: expect.stringContaining("declined-command-must-not-run"),
          itemId: "call-decline",
          threadId: thread.id,
        });
        expect(result.finalResponse).toBe("The command was declined safely.");
        expect(result.items).toContainEqual(
          expect.objectContaining({
            aggregatedOutput: null,
            exitCode: null,
            id: "call-decline",
            status: "declined",
            type: "commandExecution",
          }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(responses.requests).toHaveLength(2);
      } finally {
        await client.close();
        await responses.close();
      }
    },
    30_000,
  );

  it(
    "initializes through the real app-server Unix control socket",
    async () => {
      const codexHome = createTestCodexHome("codex-app-server-client-unix-test-");
      const socketPath = join(codexHome, "control.sock");
      const resolved = resolveCodexBinary();
      const child = spawn(
        resolved.executablePath,
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "warn" },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const client = new CodexAppServerClient({
        requestTimeoutMs: 10_000,
        transport: { type: "unix", socketPath },
      });

      try {
        await waitForSocket(child, socketPath, () => stderr);
        const initialization = await client.connect();
        expect(realpathSync(initialization.codexHome)).toBe(realpathSync(codexHome));
        expect(client.state).toBe("connected");
        await expect(client.call("thread/list", { limit: 1 })).resolves.toMatchObject({
          data: [],
          nextCursor: null,
        });
      } finally {
        await client.close();
        await stopChild(child);
      }
      expect(client.state).toBe("disconnected");
    },
    20_000,
  );

  it(
    "initializes through the real experimental TCP WebSocket listener",
    async () => {
      const codexHome = createTestCodexHome("codex-app-server-client-ws-test-");
      const port = await availableTcpPort();
      const listenUrl = `ws://127.0.0.1:${port}`;
      const resolved = resolveCodexBinary();
      const child = spawn(resolved.executablePath, ["app-server", "--listen", listenUrl], {
        env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "warn" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const client = new CodexAppServerClient({
        requestTimeoutMs: 10_000,
        transport: { type: "websocket", url: listenUrl },
      });

      try {
        await waitForReady(child, port, () => stderr);
        const initialization = await client.connect();
        expect(realpathSync(initialization.codexHome)).toBe(realpathSync(codexHome));
        await expect(client.call("thread/list", { limit: 1 })).resolves.toMatchObject({
          data: [],
          nextCursor: null,
        });
      } finally {
        await client.close();
        await stopChild(child);
      }
    },
    20_000,
  );
});

async function waitForSocket(
  child: ChildProcess,
  socketPath: string,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`codex app-server exited before creating its socket.\n${stderr()}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for codex app-server socket ${socketPath}.\n${stderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  exited = once(child, "exit").then(() => undefined);
  child.kill("SIGKILL");
  await Promise.race([exited, delay(500)]);
}

async function availableTcpPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForReady(
  child: ChildProcess,
  port: number,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`codex app-server exited before becoming ready.\n${stderr()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // Listener startup is asynchronous; retry until the bounded deadline.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for codex app-server readiness.\n${stderr()}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createTestCodexHome(prefix: string): string {
  const codexHome = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "[features]\nplugins = false\n");
  return codexHome;
}

function mockProviderConfig(
  origin: string,
  approvalPolicy = "never",
  approvalsReviewer?: "user",
): string {
  const approvalsReviewerLine = approvalsReviewer
    ? `approvals_reviewer = "${approvalsReviewer}"\n`
    : "";
  return `model = "mock-model"
approval_policy = "${approvalPolicy}"
${approvalsReviewerLine}sandbox_mode = "read-only"
model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for TypeScript client tests"
base_url = "${origin}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[features]
plugins = false
`;
}

function lastUserText(body: Record<string, unknown> | undefined): string | null {
  if (!body || !Array.isArray(body.input)) return null;
  const texts: string[] = [];
  for (const input of body.input) {
    if (!isRecord(input) || input.type !== "message" || input.role !== "user") continue;
    if (!Array.isArray(input.content)) continue;
    for (const content of input.content) {
      if (isRecord(content) && content.type === "input_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  return texts.at(-1) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
