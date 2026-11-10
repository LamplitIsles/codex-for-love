import { describe, expect, it, vi } from "vitest";
import {
  AppServerProtocolValidationError,
  CodexAppServerClient,
  protocolValidationMetadata,
} from "../src";
import type { v2 } from "../src/generated/protocol";
import { loadProtocolValidator } from "../src/protocol-validator";
import type { JsonRpcNotification } from "../src/types";
import type { ExternalAgentConfigImportHistoriesReadResponse } from "../src/generated/protocol/v2/ExternalAgentConfigImportHistoriesReadResponse";
import type { ThreadItemsListResponse } from "../src/generated/protocol/v2/ThreadItemsListResponse";
import { FakeAppServer } from "./fake-app-server";

type IsOptional<T, Key extends keyof T> = {} extends Pick<T, Key> ? true : false;
type AgentMessageItem = Extract<v2.ThreadItem, { type: "agentMessage" }>;
type AppConfig = NonNullable<v2.AppsConfig["example"]>;
type CommandExecutionItem = Extract<v2.ThreadItem, { type: "commandExecution" }>;

describe("generated protocol runtime validation", () => {
  it("keeps version-skew fields optional for older wire shapes", () => {
    const optionalFields: [
      IsOptional<v2.AccountLoginCompletedNotification, "onboardingEntrypoint">,
      IsOptional<AppConfig, "links">,
      IsOptional<v2.AppToolSummary, "isEnabled">,
      IsOptional<v2.AppToolSummary, "disabledReason">,
      IsOptional<v2.AppToolSummary, "isReadOnly">,
      IsOptional<v2.BrowserUseRequirements, "disableAutoReview">,
      IsOptional<v2.ConfigRequirements, "browserUse">,
      IsOptional<v2.ConfigRequirements, "sqliteHome">,
      IsOptional<v2.ConfigRequirements, "logDir">,
      IsOptional<v2.ConfigRequirements, "modelCatalogJson">,
      IsOptional<v2.ConfigRequirements, "checkForUpdateOnStartup">,
      IsOptional<v2.ConfigRequirements, "allowLoginShell">,
      IsOptional<v2.ConfigRequirements, "feedback">,
      IsOptional<v2.ConfigRequirements, "windowsSandboxPrivateDesktop">,
      IsOptional<v2.ExternalAgentConfigImportHistory, "providerId">,
      IsOptional<v2.ExternalAgentConfigDetectResponse, "connectors">,
      IsOptional<v2.ExternalAgentConfigImportItemTypeSuccess, "title">,
      IsOptional<v2.FeedbackRequirements, "enabled">,
      IsOptional<v2.Model, "modelSpecialty">,
      IsOptional<v2.PluginShareContext, "canPublishToWorkspace">,
      IsOptional<v2.PluginShareSaveResponse, "canPublishToWorkspace">,
      IsOptional<v2.PluginSummary, "installedAt">,
      IsOptional<v2.PluginSummary, "disabledReason">,
      IsOptional<v2.PluginSummary, "eligiblePlanTypes">,
      IsOptional<v2.ResponseUsageMetadata, "metadata">,
      IsOptional<v2.SkillInterface, "iconSmallUrl">,
      IsOptional<v2.SkillInterface, "iconLargeUrl">,
      IsOptional<v2.Thread, "isPinned">,
      IsOptional<v2.Thread, "section">,
      IsOptional<v2.Thread, "sectionEnteredAt">,
      IsOptional<v2.Thread, "model">,
      IsOptional<v2.Thread, "reasoningEffort">,
      IsOptional<v2.ToolRequestUserInputParams, "isBlocking">,
      IsOptional<AgentMessageItem, "questions">,
      IsOptional<CommandExecutionItem, "pluginId">,
      IsOptional<CommandExecutionItem, "scriptPath">,
    ] = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ];

    expect(optionalFields).toHaveLength(36);
  });

  it("validates generated request and response schemas without losing bigint values", async () => {
    const validator = await loadProtocolValidator();
    expect(() => validator.assertClientRequest("plugin/reconcile", {})).not.toThrow();
    expect(() =>
      validator.assertClientRequest("plugin/reconcile", { reason: 42 }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertResponse("plugin/reconcile", {
        changedPlugins: [],
        failedMaterializationRemotePluginIds: [],
        failedRemotePluginIds: [],
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertResponse("plugin/reconcile", { changedPlugins: [] }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertClientRequest("thread/list", { limit: "not-an-integer" }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertClientRequest("thread/list", { limit: 4_294_967_295 }),
    ).not.toThrow();
    for (const limit of [4_294_967_296, 9_007_199_254_740_993n]) {
      expect(() => validator.assertClientRequest("thread/list", { limit })).toThrow(
        AppServerProtocolValidationError,
      );
    }
    expect(() =>
      validator.assertClientRequest("mcpServer/oauth/login", {
        name: "server",
        timeoutSecs: (1n << 63n) - 1n,
      }),
    ).not.toThrow();
    for (const timeoutSecs of [Number.MAX_SAFE_INTEGER + 1, 1n << 63n]) {
      expect(() =>
        validator.assertClientRequest("mcpServer/oauth/login", {
          name: "server",
          timeoutSecs,
        }),
      ).toThrow(AppServerProtocolValidationError);
    }
    expect(() =>
      validator.assertClientRequest("command/exec/resize", {
        processId: "process-1",
        size: { cols: 65_535, rows: 65_535 },
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertClientRequest("command/exec/resize", {
        processId: "process-1",
        size: { cols: 65_536, rows: 1 },
      }),
    ).toThrow(AppServerProtocolValidationError);
    for (const [method, params] of [
      [
        "command/exec",
        { command: ["true"], outputBytesCap: (1n << 64n) - 1n },
      ],
      [
        "environment/add",
        {
          connectTimeoutMs: (1n << 64n) - 1n,
          environmentId: "environment-1",
          execServerUrl: "wss://example.test",
        },
      ],
    ] as const) {
      expect(() => validator.assertClientRequest(method, params)).not.toThrow();
    }
    expect(() =>
      validator.assertClientRequest("environment/add", {
        connectTimeoutMs: 1n << 64n,
        environmentId: "environment-1",
        execServerUrl: "wss://example.test",
      }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertResponse("command/exec", {
        exitCode: 2_147_483_647,
        stderr: "",
        stdout: "",
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertResponse("command/exec", {
        exitCode: 2_147_483_648,
        stderr: "",
        stdout: "",
      }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertResponse("remoteControl/pairing/start", {
        pairingCode: "PAIR",
        manualPairingCode: null,
        environmentId: "environment-1",
        expiresAt: 9_007_199_254_740_993n,
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertServerRequest({
        id: "elicitation",
        method: "mcpServer/elicitation/request",
        params: {
          message: "Provide a number",
          mode: "form",
          requestedSchema: {
            properties: {
              value: { maximum: 1e100, minimum: 1e16, type: "number" },
            },
            required: ["value"],
            type: "object",
          },
          serverName: "server",
          threadId: "thread-1",
        },
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertServerRequest({
        id: "request-user-input",
        method: "item/tool/requestUserInput",
        params: {
          autoResolutionMs: null,
          itemId: "item-1",
          questions: [],
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    ).not.toThrow();
    expect(() => validator.assertClientRequest("future/request", { arbitrary: true })).not.toThrow();
    const oldImportHistories: ExternalAgentConfigImportHistoriesReadResponse = { data: [] };
    expect(() =>
      validator.assertResponse(
        "externalAgentConfig/import/readHistories",
        oldImportHistories,
      ),
    ).not.toThrow();
    expect(() =>
      validator.assertResponse("externalAgentConfig/import/readHistories", { data: "invalid" }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertResponse("externalAgentConfig/import/readHistories", {
        connectors: "invalid",
        data: [],
      }),
    ).toThrow(AppServerProtocolValidationError);
    const legacyItems: ThreadItemsListResponse = {
      backwardsCursor: null,
      data: [{ id: "item-1", type: "contextCompaction" }],
      nextCursor: null,
    };
    expect(() => validator.assertResponse("thread/items/list", legacyItems)).not.toThrow();
    const currentItems: ThreadItemsListResponse = {
      backwardsCursor: null,
      data: [
        { item: { id: "item-2", type: "contextCompaction" }, turnId: "turn-1" },
      ],
      nextCursor: null,
    };
    expect(() => validator.assertResponse("thread/items/list", currentItems)).not.toThrow();
    expect(() =>
      validator.assertResponse("thread/items/list", {
        backwardsCursor: null,
        data: [
          { id: "item-1", type: "contextCompaction" },
          { item: { id: "item-2", type: "contextCompaction" }, turnId: "turn-1" },
        ],
        nextCursor: null,
      }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertServerNotification({
        emittedAtMs: 1_753_200_000_000,
        method: "rawResponse/completed",
        params: {
          responseId: "response-1",
          threadId: "thread-1",
          turnId: "turn-1",
          usage: null,
        },
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertServerNotification({
        emittedAtMs: 1n << 63n,
        method: "rawResponse/completed",
        params: {
          responseId: "response-1",
          threadId: "thread-1",
          turnId: "turn-1",
          usage: null,
        },
      }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertServerNotification({
        emittedAtMs: 1n << 63n,
        method: "thread/archived",
        params: { threadId: "thread-1" },
      }),
    ).toThrow(AppServerProtocolValidationError);
    expect(() =>
      validator.assertServerNotification({
        method: "rawResponseItem/completed",
        params: {
          item: { type: "other" },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    ).not.toThrow();
    for (const method of ["rawResponse/completed", "rawResponseItem/completed"]) {
      expect(() =>
        validator.assertServerNotification({ method, params: { threadId: "thread-1" } }),
      ).toThrow(AppServerProtocolValidationError);
    }
    expect(protocolValidationMetadata).toMatchObject({
      defaultMode: "strict",
      validatedClientNotifications: 1,
      validatedClientRequests: 162,
      validatedClientResponses: 159,
      validatedServerNotifications: 83,
      validatedServerRequests: 11,
      unavailableResponseSchemas: [
        "getAuthStatus",
        "getConversationSummary",
        "gitDiffToRemote",
      ],
    });
  });

  it("rejects malformed known requests before writing them", async () => {
    const server = await FakeAppServer.listen(() => undefined);
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });

    try {
      await client.connect();
      await expect(
        Promise.resolve().then(() =>
          client.request("thread/list", { limit: "not-an-integer" }),
        ),
      ).rejects.toMatchObject({
        direction: "request",
        method: "thread/list",
      });
      expect(server.messages.filter((message) => message.method === "thread/list")).toHaveLength(
        0,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a malformed known response and closes the mismatched connection", async () => {
    const server = await FakeAppServer.listen((message, appServer) => {
      if (message.method === "thread/list") {
        appServer.reply(message, { data: "not-an-array", nextCursor: null });
      }
    });
    const observed: Error[] = [];
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });
    client.onError((error) => observed.push(error));

    await client.connect();
    await expect(client.threadList({ limit: 1 })).rejects.toMatchObject({
      direction: "response",
      method: "thread/list",
    });
    await vi.waitFor(() => expect(client.state).toBe("disconnected"));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeInstanceOf(AppServerProtocolValidationError);
    await client.close();
    await server.close();
  });

  it("closes for malformed known notifications but forwards unknown extensions", async () => {
    const server = await FakeAppServer.listen(() => undefined);
    const observed: Error[] = [];
    const notifications: JsonRpcNotification[] = [];
    const typedTimestamps: Array<number | undefined> = [];
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });
    client.onError((error) => observed.push(error));
    client.onNotification((notification) => {
      notifications.push(notification);
    });
    client.onNotification("rawResponse/completed", (_params, notification) => {
      typedTimestamps.push(notification.emittedAtMs);
    });

    await client.connect();
    server.notify("future/notification", { arbitrary: true });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(client.state).toBe("connected");

    server.notify(
      "rawResponse/completed",
      {
        responseId: "response-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: null,
      },
      1_753_200_000_000,
    );
    await vi.waitFor(() => expect(notifications).toHaveLength(2));
    expect(notifications[1]?.emittedAtMs).toBe(1_753_200_000_000);
    expect(typedTimestamps).toEqual([1_753_200_000_000]);
    expect(client.state).toBe("connected");

    server.notify("turn/started", { threadId: "thread-1" });
    await vi.waitFor(() => expect(client.state).toBe("disconnected"));
    expect(observed[0]).toMatchObject({
      direction: "notification",
      method: "turn/started",
    });
    await client.close();
    await server.close();
  });

  it("returns JSON-RPC errors for malformed server requests and handler responses", async () => {
    const server = await FakeAppServer.listen(() => undefined);
    let handled = 0;
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });
    client.onServerRequest(() => {
      handled += 1;
      return { invalid: true };
    });

    try {
      await client.connect();
      server.request("invalid-params", "currentTime/read", {});
      await vi.waitFor(() =>
        expect(server.messages.find((message) => message.id === "invalid-params")).toMatchObject({
          error: { code: -32602 },
        }),
      );
      expect(handled).toBe(0);

      server.request("invalid-result", "currentTime/read", { threadId: "thread-1" });
      await vi.waitFor(() =>
        expect(server.messages.find((message) => message.id === "invalid-result")).toMatchObject({
          error: { code: -32603 },
        }),
      );
      expect(handled).toBe(1);
      expect(client.state).toBe("connected");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("allows validation to be disabled for deliberate version-skew experiments", async () => {
    const server = await FakeAppServer.listen((message, appServer) => {
      if (message.method === "thread/list") {
        appServer.reply(message, { data: "future-shape" });
      }
    });
    const client = new CodexAppServerClient({
      protocolValidation: "off",
      transport: { type: "websocket", url: server.url },
    });

    try {
      await client.connect();
      await expect(client.request("thread/list", { limit: 1 })).resolves.toEqual({
        data: "future-shape",
      });
      expect(client.state).toBe("connected");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
