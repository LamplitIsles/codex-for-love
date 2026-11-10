import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createConnection, isIP } from "node:net";
import WebSocket from "ws";
import {
  AppServerConnectionClosedError,
  AppServerProtocolError,
} from "./errors";
import type { JsonRpcMessageTransport } from "./jsonl-rpc-peer";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "host",
  "origin",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);

export interface AppServerWebSocketCommonOptions {
  bearerToken?: string;
  bearerTokenEnv?: string;
  closeTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
  maxPayloadBytes?: number;
}

/** Experimental and unsupported by upstream Codex for production workloads. */
export interface AppServerWebSocketTransportOptions extends AppServerWebSocketCommonOptions {
  type: "websocket";
  allowInsecureRemote?: boolean;
  rejectUnauthorized?: boolean;
  url: string;
}

/** Local control-plane transport over a WebSocket handshake on a Unix socket. */
export interface AppServerUnixSocketTransportOptions extends AppServerWebSocketCommonOptions {
  type: "unix";
  codexHome?: string;
  socketPath?: string;
}

export type AppServerRemoteTransportOptions =
  | AppServerUnixSocketTransportOptions
  | AppServerWebSocketTransportOptions;

export function resolveAppServerUnixSocketPath(
  options: Pick<AppServerUnixSocketTransportOptions, "codexHome" | "socketPath"> = {},
): string {
  const socketPath =
    options.socketPath ??
    join(
      options.codexHome ?? globalThis.process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "app-server-control",
      "app-server-control.sock",
    );
  if (!isAbsolute(socketPath)) {
    throw new TypeError("The codex app-server Unix socket path must be absolute.");
  }
  return socketPath;
}

export class WebSocketMessageTransport implements JsonRpcMessageTransport {
  private readonly socket: WebSocket;
  private readonly closeTimeoutMs: number;
  private readonly closeHandlers = new Set<(reason: Error) => void>();
  private readonly messageHandlers = new Set<(message: string) => void>();
  private closeReason: Error | null = null;
  private disposed = false;

  private readonly handleClose = (code: number, reason: Buffer) => {
    const suffix = reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    this.signalClose(
      new AppServerConnectionClosedError(`codex app-server WebSocket closed (${code})${suffix}.`),
    );
  };

  private readonly handleError = (error: Error) => {
    this.signalClose(
      new AppServerConnectionClosedError("codex app-server WebSocket failed.", {
        cause: error,
      }),
    );
  };

  private readonly handleMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      this.signalClose(
        new AppServerProtocolError(
          "codex app-server sent a binary WebSocket frame; JSON-RPC requires text frames.",
        ),
      );
      this.terminateSocket();
      return;
    }
    const message = rawDataToUtf8(data);
    for (const handler of [...this.messageHandlers]) handler(message);
  };

  private constructor(socket: WebSocket, closeTimeoutMs: number) {
    this.socket = socket;
    this.closeTimeoutMs = closeTimeoutMs;
    socket.on("close", this.handleClose);
    socket.on("error", this.handleError);
    socket.on("message", this.handleMessage);
  }

  static async connect(
    options: AppServerRemoteTransportOptions,
    signal?: AbortSignal,
  ): Promise<WebSocketMessageTransport> {
    const normalized = normalizeOptions(options);
    if (signal?.aborted) throw connectionAbortedError(signal);
    const socket = createSocket(normalized);
    const transport = new WebSocketMessageTransport(socket, normalized.closeTimeoutMs);
    const handleAbort = () => transport.abortConnection(connectionAbortedError(signal!));
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      await transport.waitForOpen();
      if (signal?.aborted) throw connectionAbortedError(signal);
      return transport;
    } catch (error) {
      transport.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", handleAbort);
    }
  }

  send(message: string): Promise<void> {
    if (this.closeReason || this.disposed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        this.closeReason ?? new AppServerConnectionClosedError("WebSocket is not open."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.send(message, { binary: false, compress: false }, (error) => {
        if (!error) {
          resolve();
          return;
        }
        const reason = new AppServerConnectionClosedError(
          "Failed to write to the codex app-server WebSocket.",
          { cause: error },
        );
        this.signalClose(reason);
        this.terminateSocket();
        reject(reason);
      });
    });
  }

  onMessage(handler: (message: string) => void): () => void {
    if (this.disposed) throw new AppServerConnectionClosedError();
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (reason: Error) => void): () => void {
    if (this.closeReason) {
      const reason = this.closeReason;
      queueMicrotask(() => handler(reason));
      return () => undefined;
    }
    if (this.disposed) throw new AppServerConnectionClosedError();
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closeReason || this.disposed || this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.signalClose(new AppServerConnectionClosedError("WebSocket closed during startup."));
      this.terminateSocket();
      return;
    }

    const closed = new Promise<void>((resolve) => {
      const unsubscribe = this.onClose(() => {
        unsubscribe();
        resolve();
      });
    });
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "client closing");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let didClose: boolean;
    try {
      didClose = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!didClose && !this.closeReason) {
      this.signalClose(
        new AppServerConnectionClosedError(
          `WebSocket did not close within ${this.closeTimeoutMs}ms.`,
        ),
      );
      this.terminateSocket();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off("close", this.handleClose);
    this.socket.off("error", this.handleError);
    this.socket.off("message", this.handleMessage);
    this.terminateSocket();
    this.closeHandlers.clear();
    this.messageHandlers.clear();
  }

  private waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.closeReason) return Promise.reject(this.closeReason);
    return new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        unsubscribeClose();
        resolve();
      };
      const unsubscribeClose = this.onClose((reason) => {
        this.socket.off("open", handleOpen);
        reject(reason);
      });
      this.socket.once("open", handleOpen);
    });
  }

  private signalClose(reason: Error): void {
    if (this.closeReason || this.disposed) return;
    this.closeReason = reason;
    for (const handler of [...this.closeHandlers]) handler(reason);
  }

  private abortConnection(reason: Error): void {
    this.signalClose(reason);
    this.terminateSocket();
  }

  private terminateSocket(): void {
    if (this.socket.readyState === WebSocket.CONNECTING) {
      // ws emits this asynchronously when a connecting socket is terminated. Keep a listener
      // installed even if dispose() removes the regular transport listener first.
      this.socket.once("error", () => undefined);
    }
    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      this.socket.terminate();
    }
  }
}

interface NormalizedOptions {
  closeTimeoutMs: number;
  headers: Record<string, string>;
  handshakeTimeoutMs: number;
  maxPayloadBytes: number;
  rejectUnauthorized: boolean;
  socketPath?: string;
  url: string;
}

function normalizeOptions(options: AppServerRemoteTransportOptions): NormalizedOptions {
  validateNonNegativeFinite("handshakeTimeoutMs", options.handshakeTimeoutMs);
  validateNonNegativeFinite("closeTimeoutMs", options.closeTimeoutMs);
  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0)
  ) {
    throw new RangeError("maxPayloadBytes must be a positive safe integer.");
  }
  if (options.bearerToken !== undefined && options.bearerTokenEnv !== undefined) {
    throw new TypeError("bearerToken and bearerTokenEnv are mutually exclusive.");
  }

  const headers = normalizeHeaders(options.headers);
  const bearerToken = resolveBearerToken(options);
  if (bearerToken !== undefined) {
    if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
      throw new TypeError("Authorization cannot be set in both headers and bearerToken.");
    }
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  if (options.type === "unix") {
    return {
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      headers,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      rejectUnauthorized: true,
      socketPath: resolveAppServerUnixSocketPath(options),
      url: "ws://localhost/",
    };
  }

  let url: URL;
  try {
    url = new URL(options.url);
  } catch (error) {
    throw new TypeError("The codex app-server WebSocket URL is invalid.", { cause: error });
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("The codex app-server WebSocket URL must use ws:// or wss://.");
  }
  if (url.username || url.password) {
    throw new TypeError("WebSocket URL user information is not supported; use bearerToken.");
  }
  if (url.hash) throw new TypeError("The codex app-server WebSocket URL cannot contain a fragment.");
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname) && !options.allowInsecureRemote) {
    throw new TypeError(
      "Refusing plaintext ws:// to a non-loopback host; use wss:// or set allowInsecureRemote explicitly.",
    );
  }

  return {
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    headers,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    rejectUnauthorized: options.rejectUnauthorized ?? true,
    url: url.href,
  };
}

function createSocket(options: NormalizedOptions): WebSocket {
  const clientOptions: WebSocket.ClientOptions = {
    followRedirects: false,
    handshakeTimeout: options.handshakeTimeoutMs,
    headers: options.headers,
    maxPayload: options.maxPayloadBytes,
    perMessageDeflate: false,
    rejectUnauthorized: options.rejectUnauthorized,
  };
  if (options.socketPath) {
    const socketPath = options.socketPath;
    clientOptions.createConnection = ((_options: unknown, callback?: () => void) =>
      createConnection(socketPath, callback)) as NonNullable<
      WebSocket.ClientOptions["createConnection"]
    >;
  }
  return new WebSocket(options.url, clientOptions);
}

function normalizeHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new TypeError(`Invalid WebSocket header name: ${name}`);
    }
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(normalized)) {
      throw new TypeError(`WebSocket header ${name} is managed by the transport and cannot be set.`);
    }
    if (seen.has(normalized)) throw new TypeError(`Duplicate WebSocket header: ${name}`);
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new TypeError(`WebSocket header ${name} must be a single-line string.`);
    }
    seen.add(normalized);
    output[name] = value;
  }
  return output;
}

function resolveBearerToken(options: AppServerWebSocketCommonOptions): string | undefined {
  if (options.bearerTokenEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.bearerTokenEnv)) {
      throw new TypeError("bearerTokenEnv must be a valid environment variable name.");
    }
    const value = globalThis.process.env[options.bearerTokenEnv];
    if (value === undefined || value.length === 0) {
      throw new TypeError(`Environment variable ${options.bearerTokenEnv} is not set.`);
    }
    return validateBearerToken(value);
  }
  return options.bearerToken === undefined
    ? undefined
    : validateBearerToken(options.bearerToken);
}

function validateBearerToken(value: string): string {
  if (value.length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new TypeError("bearerToken must be a non-empty single-line value without surrounding whitespace.");
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || normalized.startsWith("::ffff:127.");
  }
  return false;
}

function rawDataToUtf8(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

function validateNonNegativeFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
}

function connectionAbortedError(signal: AbortSignal): AppServerConnectionClosedError {
  return new AppServerConnectionClosedError(
    "The codex app-server WebSocket connection was cancelled.",
    signal.reason === undefined ? undefined : { cause: signal.reason },
  );
}
