import type { JsonRpcErrorData, JsonValue } from "./types";
import type { Turn } from "./generated/protocol/v2/Turn";

export class CodexAppServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerError";
  }
}

export class AppServerRpcError extends CodexAppServerError {
  readonly code: bigint | number;
  readonly data: JsonValue | undefined;
  readonly rpcMessage: string;

  constructor(error: JsonRpcErrorData) {
    super(`JSON-RPC error ${error.code}: ${error.message}`);
    this.name = "AppServerRpcError";
    this.code = normalizeRpcErrorCode(error.code);
    this.data = error.data;
    this.rpcMessage = error.message;
  }
}

export class AppServerParseError extends AppServerRpcError {
  override name = "AppServerParseError";
}

export class AppServerInvalidRequestError extends AppServerRpcError {
  override name = "AppServerInvalidRequestError";
}

export class AppServerMethodNotFoundError extends AppServerRpcError {
  override name = "AppServerMethodNotFoundError";
}

export class AppServerInvalidParamsError extends AppServerRpcError {
  override name = "AppServerInvalidParamsError";
}

export class AppServerInternalRpcError extends AppServerRpcError {
  override name = "AppServerInternalRpcError";
}

export class AppServerServerError extends AppServerRpcError {
  override name = "AppServerServerError";
}

export class AppServerBusyError extends AppServerServerError {
  override name = "AppServerBusyError";
}

export class AppServerRetryLimitExceededError extends AppServerBusyError {
  override name = "AppServerRetryLimitExceededError";
}

export class AppServerConnectionClosedError extends CodexAppServerError {
  constructor(message = "The codex app-server connection is closed.", options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerConnectionClosedError";
  }
}

export class CodexBinaryResolutionError extends CodexAppServerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexBinaryResolutionError";
  }
}

export class AppServerProtocolError extends CodexAppServerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export type ProtocolValidationDirection =
  | "request"
  | "response"
  | "notification"
  | "serverRequest"
  | "serverResponse";

export interface ProtocolValidationIssue {
  instancePath: string;
  keyword: string;
  message?: string;
  schemaPath: string;
}

export class AppServerProtocolValidationError extends AppServerProtocolError {
  readonly direction: ProtocolValidationDirection;
  readonly issues: readonly ProtocolValidationIssue[];
  readonly method: string;

  constructor(
    direction: ProtocolValidationDirection,
    method: string,
    issues: readonly ProtocolValidationIssue[],
    options?: ErrorOptions,
  ) {
    const detail = issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.instancePath || "/"} ${issue.message ?? `failed ${issue.keyword}`}`,
      )
      .join("; ");
    super(
      `Public app-server ${direction} validation failed for ${method}${detail ? `: ${detail}` : "."}`,
      options,
    );
    this.name = "AppServerProtocolValidationError";
    this.direction = direction;
    this.method = method;
    this.issues = issues;
  }
}

export class AppServerRequestTimeoutError extends CodexAppServerError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Request ${method} timed out after ${timeoutMs}ms.`);
    this.name = "AppServerRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AppServerRequestAbortedError extends CodexAppServerError {
  readonly method: string;

  constructor(method: string, reason?: unknown) {
    super(`Request ${method} was aborted.`, reason instanceof Error ? { cause: reason } : undefined);
    this.name = "AppServerRequestAbortedError";
    this.method = method;
  }
}

export class CodexTurnFailedError extends CodexAppServerError {
  readonly turn: Turn;

  constructor(turn: Turn) {
    super(turn.error?.message || `Codex turn ${turn.id} failed.`);
    this.name = "CodexTurnFailedError";
    this.turn = turn;
  }
}

/** Throw from a server-request handler to control the JSON-RPC error response. */
export class AppServerServerRequestError extends CodexAppServerError {
  readonly code: bigint | number;
  readonly data: JsonValue | undefined;

  constructor(message: string, code: bigint | number = -32000, data?: JsonValue) {
    super(message);
    this.name = "AppServerServerRequestError";
    this.code = normalizeRpcErrorCode(code);
    this.data = data;
  }
}

export function mapAppServerRpcError(error: JsonRpcErrorData): AppServerRpcError {
  const code = normalizeRpcErrorCode(error.code);
  const normalized = code === error.code ? error : { ...error, code };
  switch (code) {
    case -32700:
      return new AppServerParseError(normalized);
    case -32600:
      return new AppServerInvalidRequestError(normalized);
    case -32601:
      return new AppServerMethodNotFoundError(normalized);
    case -32602:
      return new AppServerInvalidParamsError(normalized);
    case -32603:
      return new AppServerInternalRpcError(normalized);
  }

  if (typeof code === "number" && code >= -32099 && code <= -32000) {
    if (containsRetryLimitText(normalized.message)) {
      return new AppServerRetryLimitExceededError(normalized);
    }
    if (containsServerOverloaded(normalized.data) || isIngressOverload(normalized)) {
      return new AppServerBusyError(normalized);
    }
    return new AppServerServerError(normalized);
  }

  return new AppServerRpcError(normalized);
}

export function isRetryableAppServerError(error: unknown): boolean {
  return (
    error instanceof AppServerBusyError ||
    (error instanceof AppServerRpcError && containsServerOverloaded(error.data))
  );
}

function containsRetryLimitText(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("retry limit") || normalized.includes("too many failed attempts");
}

function isIngressOverload(error: JsonRpcErrorData): boolean {
  if (error.code !== -32001) return false;
  const normalized = error.message.toLowerCase();
  return normalized.includes("server overloaded") || normalized.includes("retry later");
}

function containsServerOverloaded(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return value.toLowerCase() === "server_overloaded";
  if (Array.isArray(value)) return value.some(containsServerOverloaded);
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsServerOverloaded(item));
  }
  return false;
}

function normalizeRpcErrorCode(code: bigint | number): bigint | number {
  if (typeof code === "bigint") {
    if (code < -(1n << 63n) || code > (1n << 63n) - 1n) {
      throw new RangeError("JSON-RPC error codes must fit in a signed 64-bit integer.");
    }
    return code >= BigInt(Number.MIN_SAFE_INTEGER) && code <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(code)
      : code;
  }
  if (!Number.isSafeInteger(code)) {
    throw new TypeError("JSON-RPC error codes must be integers without numeric precision loss.");
  }
  return code;
}
