import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { version as clientVersion } from "../package.json";
import { prependPathDirectories, resolveCodexBinary } from "./codex-binary";
import {
  AppServerConnectionClosedError,
  AppServerInvalidRequestError,
  AppServerProtocolError,
  AppServerProtocolValidationError,
  AppServerServerRequestError,
} from "./errors";
import type {
  AppServerMethod,
  AppServerParams,
  AppServerResponseMap,
} from "./generated/app-server-methods";
import type { ClientInfo } from "./generated/protocol/ClientInfo";
import type { InitializeCapabilities } from "./generated/protocol/InitializeCapabilities";
import type { InitializeResponse } from "./generated/protocol/InitializeResponse";
import type { ServerNotificationEnvelope as ServerNotification } from "./generated/protocol/ServerNotificationEnvelope";
import type { AccountLoginCompletedNotification } from "./generated/protocol/v2/AccountLoginCompletedNotification";
import type { CancelLoginAccountParams } from "./generated/protocol/v2/CancelLoginAccountParams";
import type { CancelLoginAccountResponse } from "./generated/protocol/v2/CancelLoginAccountResponse";
import type { GetAccountParams } from "./generated/protocol/v2/GetAccountParams";
import type { GetAccountResponse } from "./generated/protocol/v2/GetAccountResponse";
import type { LoginAccountParams } from "./generated/protocol/v2/LoginAccountParams";
import type { LoginAccountResponse } from "./generated/protocol/v2/LoginAccountResponse";
import type { LogoutAccountResponse } from "./generated/protocol/v2/LogoutAccountResponse";
import type { ModelListParams } from "./generated/protocol/v2/ModelListParams";
import type { ModelListResponse } from "./generated/protocol/v2/ModelListResponse";
import type { ThreadArchiveParams } from "./generated/protocol/v2/ThreadArchiveParams";
import type { ThreadArchiveResponse } from "./generated/protocol/v2/ThreadArchiveResponse";
import type { ThreadCompactStartParams } from "./generated/protocol/v2/ThreadCompactStartParams";
import type { ThreadCompactStartResponse } from "./generated/protocol/v2/ThreadCompactStartResponse";
import type { ThreadForkParams } from "./generated/protocol/v2/ThreadForkParams";
import type { ThreadForkResponse } from "./generated/protocol/v2/ThreadForkResponse";
import type { ThreadGoalClearParams } from "./generated/protocol/v2/ThreadGoalClearParams";
import type { ThreadGoalClearResponse } from "./generated/protocol/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetParams } from "./generated/protocol/v2/ThreadGoalGetParams";
import type { ThreadGoalGetResponse } from "./generated/protocol/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams } from "./generated/protocol/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse } from "./generated/protocol/v2/ThreadGoalSetResponse";
import type { ThreadListParams } from "./generated/protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "./generated/protocol/v2/ThreadListResponse";
import type { ThreadReadParams } from "./generated/protocol/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./generated/protocol/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "./generated/protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./generated/protocol/v2/ThreadResumeResponse";
import type { ThreadSetNameParams } from "./generated/protocol/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse } from "./generated/protocol/v2/ThreadSetNameResponse";
import type { ThreadStartParams } from "./generated/protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/protocol/v2/ThreadStartResponse";
import type { ThreadUnarchiveParams } from "./generated/protocol/v2/ThreadUnarchiveParams";
import type { ThreadUnarchiveResponse } from "./generated/protocol/v2/ThreadUnarchiveResponse";
import type { TurnInterruptParams } from "./generated/protocol/v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./generated/protocol/v2/TurnInterruptResponse";
import type { TurnStartParams } from "./generated/protocol/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/protocol/v2/TurnStartResponse";
import type { TurnSteerParams } from "./generated/protocol/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./generated/protocol/v2/TurnSteerResponse";
import {
  CodexGoal,
  DEFAULT_GOAL_START_TIMEOUT_MS,
  GoalEventRouter,
  type GoalOperationState,
  type GoalStartOptions,
} from "./goal";
import { JsonlRpcPeer, JsonRpcPeer } from "./jsonl-rpc-peer";
import {
  ChatGptLoginHandle,
  DeviceCodeLoginHandle,
  LoginEventRouter,
  type ChatGptAuthTokens,
  type ChatGptLoginOptions,
  type LoginWaitOptions,
} from "./login";
import { KeyedOperationCoordinator } from "./operation-coordinator";
import { ExternalMessage, assertToolOutputRuntime } from "./external-message";
import {
  loadProtocolValidator,
  type ProtocolValidationMode,
  type ProtocolValidator,
} from "./protocol-validator";
import {
  CodexThread,
  CodexTurn,
  normalizeTurnInput,
  type CodexTurnInput,
  type CodexTurnStartOptions,
} from "./thread";
import type {
  ServerNotificationMethod,
  ServerRequestMethod,
  TypedNotificationHandler,
  TypedServerRequestHandler,
} from "./typed-handlers";
import type {
  JsonValue,
  NotificationHandler,
  RequestOptions,
  ServerRequestHandler,
} from "./types";
import { TurnEventRouter } from "./turn-event-router";
import {
  WebSocketMessageTransport,
  type AppServerRemoteTransportOptions,
} from "./websocket-transport";

export type AppServerConnectionState = "disconnected" | "connecting" | "connected" | "closing";
export type AppServerCallArguments<M extends AppServerMethod> = [undefined] extends [
  AppServerParams<M>,
]
  ? [params?: AppServerParams<M>, options?: RequestOptions]
  : [params: AppServerParams<M>, options?: RequestOptions];
type StoredTypedNotificationHandler = (
  params: unknown,
  notification: ServerNotification,
) => void | Promise<void>;

export interface CodexAppServerClientOptions {
  appServerArgs?: readonly string[];
  capabilities?: Partial<InitializeCapabilities>;
  clientInfo?: ClientInfo;
  codexPath?: string;
  /** Use app-server with an explicit standalone binary; defaults to the full CLI. */
  codexExecutableType?: "cli" | "app-server";
  configOverrides?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onUnhandledError?: (error: Error) => void;
  protocolValidation?: ProtocolValidationMode;
  requestTimeoutMs?: number;
  stderrBufferLines?: number;
  transport?: AppServerClientTransportOptions;
}

export interface AppServerStdioTransportOptions {
  type: "stdio";
}

export type AppServerClientTransportOptions =
  | AppServerRemoteTransportOptions
  | AppServerStdioTransportOptions;

const DEFAULT_CLIENT_INFO: ClientInfo = {
  name: "codex_app_server_client_ts",
  title: "Codex App Server Client for TypeScript",
  version: clientVersion,
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  experimentalApi: true,
  requestAttestation: false,
};

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly typedNotificationHandlers = new Map<
    string,
    Set<StoredTypedNotificationHandler>
  >();
  private readonly typedServerRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly turnEvents = new TurnEventRouter();
  private readonly goalEvents = new GoalEventRouter();
  private readonly loginEvents = new LoginEventRouter();
  private readonly threadOperations = new KeyedOperationCoordinator();
  private child: ChildProcessWithoutNullStreams | null = null;
  private closePromise: Promise<void> | null = null;
  private connectAbortController: AbortController | null = null;
  private peer: JsonRpcPeer | null = null;
  private protocolValidator: ProtocolValidator | null = null;
  private connectPromise: Promise<InitializeResponse> | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private stderrLines: string[] = [];
  private stderrRemainder = "";
  private currentState: AppServerConnectionState = "disconnected";

  constructor(options: CodexAppServerClientOptions = {}) {
    validateClientOptions(options);
    this.options = {
      ...options,
      appServerArgs: options.appServerArgs ? [...options.appServerArgs] : undefined,
      capabilities: options.capabilities ? { ...options.capabilities } : undefined,
      clientInfo: options.clientInfo ? { ...options.clientInfo } : undefined,
      configOverrides: options.configOverrides ? [...options.configOverrides] : undefined,
      env: options.env ? { ...options.env } : undefined,
      transport: cloneTransportOptions(options.transport),
    };
  }

  get initialization(): InitializeResponse | null {
    return this.initializeResponse;
  }

  get state(): AppServerConnectionState {
    return this.currentState;
  }

  get stderrTail(): string {
    return [...this.stderrLines, this.stderrRemainder].filter(Boolean).join("\n");
  }

  connect(): Promise<InitializeResponse> {
    if (this.initializeResponse) return Promise.resolve(this.initializeResponse);
    if (this.closePromise) {
      const closing = this.closePromise;
      return closing.then(async () => {
        const interruptedConnection = this.connectPromise;
        if (interruptedConnection) {
          await interruptedConnection.catch(() => undefined);
        }
        return this.connect();
      });
    }
    if (this.connectPromise) return this.connectPromise;
    const tracked = this.start().finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  request<T = JsonValue>(
    method: string,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const peer = this.requirePeer();
    if (method === "turn/start" && params !== null && typeof params === "object"
      && "toolOutput" in params && params.toolOutput != null) {
      assertToolOutputRuntime(this.initializeResponse?.userAgent);
    }
    const validator = this.protocolValidator;
    validator?.assertClientRequest(method, params);
    const response = peer.request<T>(method, params, this.withDefaultTimeout(options));
    if (!validator) return response;
    return response.then((result) => {
      try {
        validator.assertResponse(method, result);
        return result;
      } catch (error) {
        peer.dispose(asError(error));
        throw error;
      }
    });
  }

  call<M extends AppServerMethod>(
    method: M,
    ...args: AppServerCallArguments<M>
  ): Promise<AppServerResponseMap[M]> {
    const [params, options = {}] = args as [unknown, RequestOptions?];
    return this.request<AppServerResponseMap[M]>(method, params, options);
  }

  accountLoginStart(
    params: LoginAccountParams,
    options: RequestOptions = {},
  ): Promise<LoginAccountResponse> {
    return this.request("account/login/start", params, options);
  }

  accountLoginCancel(
    params: CancelLoginAccountParams,
    options: RequestOptions = {},
  ): Promise<CancelLoginAccountResponse> {
    return this.request("account/login/cancel", params, options);
  }

  accountRead(
    params: GetAccountParams = {},
    options: RequestOptions = {},
  ): Promise<GetAccountResponse> {
    return this.request("account/read", params, options);
  }

  accountLogout(options: RequestOptions = {}): Promise<LogoutAccountResponse> {
    return this.request("account/logout", undefined, options);
  }

  async loginApiKey(apiKey: string, options: RequestOptions = {}): Promise<void> {
    if (!apiKey) throw new TypeError("apiKey must be a non-empty string.");
    const response = await this.accountLoginStart({ type: "apiKey", apiKey }, options);
    if (response.type !== "apiKey") {
      throw new AppServerProtocolError(`Unexpected API-key login response: ${response.type}.`);
    }
  }

  async loginChatGPT(
    params: ChatGptLoginOptions = {},
    options: RequestOptions = {},
  ): Promise<ChatGptLoginHandle> {
    const response = await this.accountLoginStart({ type: "chatgpt", ...params }, options);
    if (response.type !== "chatgpt") {
      throw new AppServerProtocolError(`Unexpected ChatGPT login response: ${response.type}.`);
    }
    return new ChatGptLoginHandle(this, response.loginId, response.authUrl);
  }

  async loginChatGPTDeviceCode(
    options: RequestOptions = {},
  ): Promise<DeviceCodeLoginHandle> {
    const response = await this.accountLoginStart({ type: "chatgptDeviceCode" }, options);
    if (response.type !== "chatgptDeviceCode") {
      throw new AppServerProtocolError(
        `Unexpected device-code login response: ${response.type}.`,
      );
    }
    return new DeviceCodeLoginHandle(
      this,
      response.loginId,
      response.verificationUrl,
      response.userCode,
    );
  }

  async loginChatGPTAuthTokens(
    params: ChatGptAuthTokens,
    options: RequestOptions = {},
  ): Promise<void> {
    const response = await this.accountLoginStart(
      { type: "chatgptAuthTokens", ...params },
      options,
    );
    if (response.type !== "chatgptAuthTokens") {
      throw new AppServerProtocolError(
        `Unexpected ChatGPT token login response: ${response.type}.`,
      );
    }
  }

  account(refreshToken = false, options: RequestOptions = {}): Promise<GetAccountResponse> {
    return this.accountRead({ refreshToken }, options);
  }

  async logout(options: RequestOptions = {}): Promise<void> {
    await this.accountLogout(options);
  }

  waitForLoginCompleted(
    loginId: string,
    options: LoginWaitOptions = {},
  ): Promise<AccountLoginCompletedNotification> {
    return this.loginEvents.wait(loginId, options);
  }

  threadStart(
    params: ThreadStartParams = {},
    options: RequestOptions = {},
  ): Promise<ThreadStartResponse> {
    return this.request("thread/start", params, options);
  }

  threadResume(
    params: ThreadResumeParams,
    options: RequestOptions = {},
  ): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params, options);
  }

  threadFork(
    params: ThreadForkParams,
    options: RequestOptions = {},
  ): Promise<ThreadForkResponse> {
    return this.request("thread/fork", params, options);
  }

  threadList(
    params: ThreadListParams = {},
    options: RequestOptions = {},
  ): Promise<ThreadListResponse> {
    return this.request("thread/list", params, options);
  }

  threadRead(
    params: ThreadReadParams,
    options: RequestOptions = {},
  ): Promise<ThreadReadResponse> {
    return this.request("thread/read", params, options);
  }

  threadGoalGet(
    params: ThreadGoalGetParams,
    options: RequestOptions = {},
  ): Promise<ThreadGoalGetResponse> {
    return this.request("thread/goal/get", params, options);
  }

  threadGoalSet(
    params: ThreadGoalSetParams,
    options: RequestOptions = {},
  ): Promise<ThreadGoalSetResponse> {
    return this.request("thread/goal/set", params, options);
  }

  threadGoalClear(
    params: ThreadGoalClearParams,
    options: RequestOptions = {},
  ): Promise<ThreadGoalClearResponse> {
    return this.request("thread/goal/clear", params, options);
  }

  threadArchive(
    params: ThreadArchiveParams,
    options: RequestOptions = {},
  ): Promise<ThreadArchiveResponse> {
    return this.request("thread/archive", params, options);
  }

  threadUnarchive(
    params: ThreadUnarchiveParams,
    options: RequestOptions = {},
  ): Promise<ThreadUnarchiveResponse> {
    return this.request("thread/unarchive", params, options);
  }

  threadSetName(
    params: ThreadSetNameParams,
    options: RequestOptions = {},
  ): Promise<ThreadSetNameResponse> {
    return this.request("thread/name/set", params, options);
  }

  threadCompact(
    params: ThreadCompactStartParams,
    options: RequestOptions = {},
  ): Promise<ThreadCompactStartResponse> {
    return this.request("thread/compact/start", params, options);
  }

  turnStart(
    params: TurnStartParams,
    options: RequestOptions = {},
  ): Promise<TurnStartResponse> {
    return this.request("turn/start", params, options);
  }

  turnSteer(
    params: TurnSteerParams,
    options: RequestOptions = {},
  ): Promise<TurnSteerResponse> {
    return this.request("turn/steer", params, options);
  }

  turnInterrupt(
    params: TurnInterruptParams,
    options: RequestOptions = {},
  ): Promise<TurnInterruptResponse> {
    return this.request("turn/interrupt", params, options);
  }

  modelList(
    params: ModelListParams = {},
    options: RequestOptions = {},
  ): Promise<ModelListResponse> {
    return this.request("model/list", params, options);
  }

  async createThread(
    params: ThreadStartParams = {},
    options: RequestOptions = {},
  ): Promise<CodexThread> {
    const response = await this.threadStart(params, options);
    return new CodexThread(this, response.thread);
  }

  async resumeThread(
    threadId: string,
    params: Omit<ThreadResumeParams, "threadId"> = {},
    options: RequestOptions = {},
  ): Promise<CodexThread> {
    const response = await this.threadResume({ ...params, threadId }, options);
    return new CodexThread(this, response.thread);
  }

  async forkThread(
    threadId: string,
    params: Omit<ThreadForkParams, "threadId"> = {},
    options: RequestOptions = {},
  ): Promise<CodexThread> {
    const response = await this.threadFork({ ...params, threadId }, options);
    return new CodexThread(this, response.thread);
  }

  async startTurn(
    threadId: string,
    input: CodexTurnInput,
    params: CodexTurnStartOptions = {},
    options: RequestOptions = {},
  ): Promise<CodexTurn> {
    if (input instanceof ExternalMessage && params.toolOutput != null) {
      throw new TypeError("ExternalMessage cannot be combined with a second toolOutput option.");
    }
    const turnInput = input instanceof ExternalMessage
      ? { input: [], toolOutput: input.toToolOutput() }
      : { input: normalizeTurnInput(input) };
    if (turnInput.input.length && params.toolOutput != null) {
      throw new TypeError("toolOutput cannot be combined with nonempty user input.");
    }
    return this.threadOperations.run(threadId, async () => {
      if (this.goalEvents.has(threadId)) {
        throw new AppServerInvalidRequestError({
          code: -32600,
          message: `Thread has an active goal operation: ${threadId}`,
        });
      }
      // A joining request can complete the original handle before its RPC reply arrives.
      const release = this.turnEvents.reserveStart(threadId);
      try {
        const response = await this.turnStart({ ...params, ...turnInput, threadId }, options);
        return new CodexTurn(this, threadId, response.turn.id,
          this.turnEvents.open(response.turn.id, threadId));
      } finally { release(); }
    });
  }

  async startGoal(
    threadId: string,
    objective: string,
    goalOptions: GoalStartOptions = {},
    requestOptions: RequestOptions = {},
  ): Promise<CodexGoal> {
    validateGoalStartOptions(threadId, objective, goalOptions);
    return this.threadOperations.run(threadId, async () => {
      if (this.goalEvents.has(threadId)) {
        throw new AppServerInvalidRequestError({
          code: -32600,
          message: `Thread already has an active goal operation: ${threadId}`,
        });
      }
      const thread = (await this.threadRead({ threadId, includeTurns: false }, requestOptions))
        .thread;
      if (thread.status.type !== "idle") {
        throw new AppServerInvalidRequestError({
          code: -32600,
          message: `Thread must be idle before starting a goal: ${threadId}`,
        });
      }
      if (thread.ephemeral || thread.path === null) {
        throw new AppServerInvalidRequestError({
          code: -32600,
          message: `Thread must be persisted before starting a goal: ${threadId}`,
        });
      }

      const state = this.goalEvents.reserve(threadId);
      let goalActivated = false;
      try {
        await this.threadGoalClear({ threadId }, requestOptions);
        state.activateTurnRouting();
        await this.threadGoalSet(
          {
            threadId,
            objective,
            status: "active",
            ...(goalOptions.tokenBudget === undefined
              ? {}
              : { tokenBudget: goalOptions.tokenBudget }),
          },
          requestOptions,
        );
        goalActivated = true;
        const logicalTurnId = await state.waitForStart({
          signal: requestOptions.signal,
          timeoutMs: goalOptions.startTimeoutMs ?? DEFAULT_GOAL_START_TIMEOUT_MS,
        });
        return new CodexGoal(
          logicalTurnId,
          threadId,
          objective,
          state.stream,
          (options) => this.pauseGoalOperation(state, options),
        );
      } catch (error) {
        if (goalActivated || !(error instanceof AppServerInvalidRequestError)) {
          await this.pauseGoalOperation(state).catch(() => undefined);
        }
        state.fail(asError(error));
        this.goalEvents.release(state);
        throw error;
      }
    });
  }

  private async pauseGoalOperation(
    state: GoalOperationState,
    options: RequestOptions = {},
  ): Promise<void> {
    if (state.finished) return;
    let pauseError: unknown;
    try {
      await this.threadGoalSet({ threadId: state.threadId, status: "paused" }, options);
    } catch (error) {
      pauseError = error;
    }
    if (await this.interruptGoalTurn(state, options)) state.markInterrupted();
    if (pauseError !== undefined) throw pauseError;
  }

  notify(method: string, params?: unknown): Promise<void> {
    const peer = this.requirePeer();
    this.protocolValidator?.assertClientNotification(method, params);
    return peer.notify(method, params);
  }

  onNotification(handler: NotificationHandler): () => void;
  onNotification<M extends ServerNotificationMethod>(
    method: M,
    handler: TypedNotificationHandler<M>,
  ): () => void;
  onNotification<M extends ServerNotificationMethod>(
    methodOrHandler: M | NotificationHandler,
    typedHandler?: TypedNotificationHandler<M>,
  ): () => void {
    if (typeof methodOrHandler === "function") {
      this.notificationHandlers.add(methodOrHandler);
      return () => this.notificationHandlers.delete(methodOrHandler);
    }
    if (typeof typedHandler !== "function") {
      throw new TypeError("A notification handler is required when registering by method.");
    }
    const handlers = this.typedNotificationHandlers.get(methodOrHandler) ?? new Set();
    const handler: StoredTypedNotificationHandler = (params, notification) =>
      typedHandler(
        params as Parameters<TypedNotificationHandler<M>>[0],
        notification as Parameters<TypedNotificationHandler<M>>[1],
      );
    handlers.add(handler);
    this.typedNotificationHandlers.set(methodOrHandler, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.typedNotificationHandlers.delete(methodOrHandler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void;
  onServerRequest<M extends ServerRequestMethod>(
    method: M,
    handler: TypedServerRequestHandler<M>,
  ): () => void;
  onServerRequest<M extends ServerRequestMethod>(
    methodOrHandler: M | ServerRequestHandler,
    typedHandler?: TypedServerRequestHandler<M>,
  ): () => void {
    if (typeof methodOrHandler !== "function") {
      if (typeof typedHandler !== "function") {
        throw new TypeError("A server-request handler is required when registering by method.");
      }
      const handler: ServerRequestHandler = (request) =>
        typedHandler(
          request.params as Parameters<TypedServerRequestHandler<M>>[0],
          request as Parameters<TypedServerRequestHandler<M>>[1],
        );
      this.typedServerRequestHandlers.set(methodOrHandler, handler);
      return () => {
        if (this.typedServerRequestHandlers.get(methodOrHandler) === handler) {
          this.typedServerRequestHandlers.delete(methodOrHandler);
        }
      };
    }
    const handler = methodOrHandler;
    this.serverRequestHandler = handler;
    return () => {
      if (this.serverRequestHandler === handler) this.serverRequestHandler = null;
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const tracked = this.stop().finally(() => {
      if (this.closePromise === tracked) this.closePromise = null;
    });
    this.closePromise = tracked;
    return tracked;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    const peer = this.peer;
    const reason = new AppServerConnectionClosedError(
      "The client closed the codex app-server connection.",
    );
    this.connectAbortController?.abort(reason);
    this.connectAbortController = null;
    this.currentState = "closing";
    this.initializeResponse = null;
    this.turnEvents.failAll(reason);
    this.loginEvents.failAll(reason);
    this.goalEvents.failAll(reason);
    this.peer = null;
    this.child = null;
    await peer?.close(reason);
    if (!child) {
      this.currentState = "disconnected";
      return;
    }

    if (child.pid === undefined && isRunning(child)) {
      await Promise.race([
        once(child, "spawn").then(() => undefined).catch(() => undefined),
        once(child, "close").then(() => undefined).catch(() => undefined),
        delay(2_000),
      ]);
    }

    if (child.stdin.writable) child.stdin.end();
    if (isRunning(child)) {
      const exited = once(child, "exit").then(() => undefined).catch(() => undefined);
      if (child.pid !== undefined) child.kill("SIGTERM");
      await Promise.race([exited, delay(2_000)]);
    }
    if (isRunning(child)) {
      const exited = once(child, "exit").then(() => undefined).catch(() => undefined);
      child.kill("SIGKILL");
      await Promise.race([exited, delay(500)]);
    }
    this.currentState = "disconnected";
  }

  private async start(): Promise<InitializeResponse> {
    this.currentState = "connecting";
    this.stderrLines = [];
    this.stderrRemainder = "";
    this.loginEvents.reset();
    const abortController = new AbortController();
    this.connectAbortController = abortController;
    try {
      this.protocolValidator =
        this.options.protocolValidation === "off" ? null : await loadProtocolValidator();
      if (abortController.signal.aborted) {
        throw asError(
          abortController.signal.reason ?? new AppServerConnectionClosedError(),
        );
      }
      const peer = await this.openPeer(abortController.signal);
      this.peer = peer;
      this.configurePeer(peer);

      const initializeParams = {
        capabilities: { ...DEFAULT_CAPABILITIES, ...this.options.capabilities },
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      };
      this.protocolValidator?.assertClientRequest("initialize", initializeParams);
      const rawResponse = await peer.request<unknown>(
        "initialize",
        initializeParams,
        this.withDefaultTimeout({}),
      );
      this.protocolValidator?.assertResponse("initialize", rawResponse);
      const response = validateInitializeResponse(rawResponse);
      this.protocolValidator?.assertClientNotification("initialized", undefined);
      await peer.notify("initialized");
      this.initializeResponse = response;
      this.currentState = "connected";
      return response;
    } catch (error) {
      const tail = this.stderrTail;
      await this.close();
      if (error instanceof AppServerConnectionClosedError && tail) {
        throw new AppServerConnectionClosedError(`${error.message}\n${tail}`, { cause: error });
      }
      throw error;
    } finally {
      if (this.connectAbortController === abortController) {
        this.connectAbortController = null;
      }
    }
  }

  private async openPeer(signal: AbortSignal): Promise<JsonRpcPeer> {
    const transport = this.options.transport ?? { type: "stdio" };
    if (transport.type !== "stdio") {
      const messageTransport = await WebSocketMessageTransport.connect(transport, signal);
      try {
        return new JsonRpcPeer(messageTransport, {
          onUnhandledError: (error) => this.reportUnhandledError(error),
        });
      } catch (error) {
        messageTransport.dispose();
        throw error;
      }
    }

    return this.openStdioPeer();
  }

  private async openStdioPeer(): Promise<JsonRpcPeer> {
    const resolved = resolveCodexBinary(this.options.codexPath);
    const args: string[] = [];
    for (const override of this.options.configOverrides ?? []) {
      args.push("--config", override);
    }
    if (this.options.codexExecutableType !== "app-server") args.push("app-server");
    args.push("--listen", "stdio://", ...(this.options.appServerArgs ?? []));

    const child = spawn(resolved.executablePath, args, {
      cwd: this.options.cwd,
      env: prependPathDirectories(
        { ...globalThis.process.env, ...this.options.env },
        resolved.pathDirectories,
      ),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.captureStderr(chunk));
    child.on("error", (error) => {
      if (this.child !== child) return;
      const reason = new AppServerConnectionClosedError("codex app-server process failed.", {
        cause: error,
      });
      if (this.peer) this.peer.dispose(reason);
      else this.reportUnhandledError(error);
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));

    await once(child, "spawn");
    if (this.child !== child) throw new AppServerConnectionClosedError();
    return new JsonlRpcPeer(child.stdout, child.stdin, {
      onUnhandledError: (error) => this.reportUnhandledError(error),
    });
  }

  private configurePeer(peer: JsonRpcPeer): void {
    peer.onClose((reason) => this.handlePeerClose(peer, reason));
    peer.onNotification(async (notification) => {
      try {
        this.protocolValidator?.assertServerNotification(notification);
      } catch (error) {
        peer.dispose(asError(error));
        return;
      }
      const typed = notification as ServerNotification;
      try {
        this.loginEvents.route(typed);
        if (!this.goalEvents.route(typed)) this.turnEvents.route(notification);
      } catch (error) {
        peer.dispose(asError(error));
        return;
      }
      for (const handler of [...this.notificationHandlers]) await handler(notification);
      for (const handler of this.typedNotificationHandlers.get(notification.method) ?? []) {
        await handler(notification.params, typed);
      }
    });
    peer.onServerRequest(async (request) => {
      try {
        this.protocolValidator?.assertServerRequest(request);
      } catch (error) {
        if (error instanceof AppServerProtocolValidationError) {
          throw new AppServerServerRequestError(error.message, -32602);
        }
        throw error;
      }
      const typedHandler = this.typedServerRequestHandlers.get(request.method);
      let result: JsonValue;
      if (typedHandler) result = await typedHandler(request);
      else if (this.serverRequestHandler) result = await this.serverRequestHandler(request);
      else {
        throw new AppServerServerRequestError(
          `Unsupported server request: ${request.method}`,
          -32601,
        );
      }
      try {
        this.protocolValidator?.assertServerResponse(request.method, result);
      } catch (error) {
        if (error instanceof AppServerProtocolValidationError) {
          throw new AppServerServerRequestError(error.message, -32603);
        }
        throw error;
      }
      return result;
    });
  }

  private handlePeerClose(peer: JsonRpcPeer, reason: Error): void {
    if (this.peer !== peer) return;
    const wasConnected = this.currentState === "connected";
    this.peer = null;
    this.initializeResponse = null;
    this.turnEvents.failAll(reason);
    this.loginEvents.failAll(reason);
    this.goalEvents.failAll(reason);
    if (this.currentState === "closing") return;
    this.currentState = "disconnected";
    if (wasConnected) this.reportUnhandledError(reason);
    if (this.child && isRunning(this.child)) {
      void this.close().catch((error: unknown) => this.reportUnhandledError(asError(error)));
    }
  }

  private async interruptGoalTurn(
    state: GoalOperationState,
    options: RequestOptions,
  ): Promise<boolean> {
    const turnId = state.turnForInterrupt();
    if (!turnId) return false;
    try {
      await this.turnInterrupt({ threadId: state.threadId, turnId }, options);
      return true;
    } catch (error) {
      if (!(error instanceof AppServerInvalidRequestError)) return false;
      if (!error.rpcMessage.startsWith("expected active turn id")) return false;
      const activeTurnId = activeTurnIdFromError(error.rpcMessage);
      if (!activeTurnId || activeTurnId === turnId) return false;
      try {
        await this.turnInterrupt(
          { threadId: state.threadId, turnId: activeTurnId },
          options,
        );
        return true;
      } catch {
        // Goal cancellation is best effort across physical-turn rollover races.
        return false;
      }
    }
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    const suffix = this.stderrTail ? `\n${this.stderrTail}` : "";
    this.peer?.dispose(
      new AppServerConnectionClosedError(
        `codex app-server exited (${signal ?? code ?? "unknown"}).${suffix}`,
      ),
    );
    this.turnEvents.failAll(
      new AppServerConnectionClosedError(
        `codex app-server exited (${signal ?? code ?? "unknown"}).${suffix}`,
      ),
    );
    this.loginEvents.failAll(
      new AppServerConnectionClosedError(
        `codex app-server exited (${signal ?? code ?? "unknown"}).${suffix}`,
      ),
    );
    this.goalEvents.failAll(
      new AppServerConnectionClosedError(
        `codex app-server exited (${signal ?? code ?? "unknown"}).${suffix}`,
      ),
    );
    this.peer = null;
    this.child = null;
    this.initializeResponse = null;
    this.currentState = "disconnected";
  }

  private captureStderr(chunk: string): void {
    const lines = `${this.stderrRemainder}${chunk}`.split(/\r?\n/);
    this.stderrRemainder = lines.pop() ?? "";
    this.stderrLines.push(...lines);
    const maximum = this.options.stderrBufferLines ?? 400;
    if (this.stderrLines.length > maximum) {
      this.stderrLines.splice(0, this.stderrLines.length - maximum);
    }
  }

  private withDefaultTimeout(options: RequestOptions): RequestOptions {
    return options.timeoutMs === undefined && this.options.requestTimeoutMs !== undefined
      ? { ...options, timeoutMs: this.options.requestTimeoutMs }
      : options;
  }

  private reportUnhandledError(error: Error): void {
    try {
      this.options.onUnhandledError?.(error);
    } catch {
      // Error observers are isolated from transport processing.
    }
    for (const handler of [...this.errorHandlers]) {
      try {
        handler(error);
      } catch {
        // Error observers are isolated from each other.
      }
    }
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer || !this.initializeResponse) {
      throw new AppServerConnectionClosedError(
        "Call connect() before using the codex app-server client.",
      );
    }
    return this.peer;
  }
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateInitializeResponse(value: unknown): InitializeResponse {
  if (!isRecord(value)) {
    throw new AppServerProtocolError("initialize response must be an object.");
  }
  for (const field of ["userAgent", "codexHome", "platformFamily", "platformOs"] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new AppServerProtocolError(`initialize response has invalid ${field}.`);
    }
  }
  return value as InitializeResponse;
}

function validateClientOptions(options: CodexAppServerClientOptions): void {
  if (
    options.codexExecutableType !== undefined &&
    options.codexExecutableType !== "cli" &&
    options.codexExecutableType !== "app-server"
  ) {
    throw new TypeError("codexExecutableType must be cli or app-server.");
  }
  if (options.codexExecutableType === "app-server" && !options.codexPath) {
    throw new TypeError("Standalone app-server requires an explicit codexPath.");
  }
  if (
    options.protocolValidation !== undefined &&
    options.protocolValidation !== "strict" &&
    options.protocolValidation !== "off"
  ) {
    throw new TypeError("protocolValidation must be strict or off.");
  }
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs < 0)
  ) {
    throw new RangeError("requestTimeoutMs must be a finite non-negative number.");
  }
  if (
    options.stderrBufferLines !== undefined &&
    (!Number.isInteger(options.stderrBufferLines) || options.stderrBufferLines < 0)
  ) {
    throw new RangeError("stderrBufferLines must be a non-negative integer.");
  }
  if (
    options.transport !== undefined &&
    options.transport.type !== "stdio" &&
    options.transport.type !== "unix" &&
    options.transport.type !== "websocket"
  ) {
    throw new TypeError("transport.type must be stdio, unix, or websocket.");
  }
  if (options.transport?.type === "unix" || options.transport?.type === "websocket") {
    const incompatible = [
      "appServerArgs",
      "codexPath",
      "codexExecutableType",
      "configOverrides",
      "cwd",
      "env",
      "stderrBufferLines",
    ].filter((key) => options[key as keyof CodexAppServerClientOptions] !== undefined);
    if (incompatible.length > 0) {
      throw new TypeError(
        `Local process options cannot be used with ${options.transport.type} transport: ${incompatible.join(", ")}.`,
      );
    }
  }
}

function cloneTransportOptions(
  options: AppServerClientTransportOptions | undefined,
): AppServerClientTransportOptions | undefined {
  if (!options) return undefined;
  if (options.type === "stdio") return { type: "stdio" };
  return {
    ...options,
    headers: options.headers ? { ...options.headers } : undefined,
  };
}

function validateGoalStartOptions(
  threadId: string,
  objective: string,
  options: GoalStartOptions,
): void {
  if (!threadId.trim()) throw new TypeError("threadId must be a non-empty string.");
  if (!objective.trim()) throw new TypeError("objective must be a non-empty string.");
  if (
    options.startTimeoutMs !== undefined &&
    (!Number.isFinite(options.startTimeoutMs) || options.startTimeoutMs < 0)
  ) {
    throw new RangeError("startTimeoutMs must be a finite non-negative number.");
  }
  if (
    options.tokenBudget !== undefined &&
    options.tokenBudget !== null &&
    (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)
  ) {
    throw new RangeError("tokenBudget must be null or a positive safe integer.");
  }
}

function activeTurnIdFromError(message: string): string | null {
  return message.match(/ but found `?([^`]+)`?$/)?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
