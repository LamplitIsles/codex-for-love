import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  AppServerConnectionClosedError,
  AppServerProtocolError,
  AppServerRequestAbortedError,
  AppServerRequestTimeoutError,
  AppServerServerRequestError,
  mapAppServerRpcError,
} from "./errors";
import type {
  JsonRpcErrorData,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  JsonlRpcPeerOptions,
  NotificationHandler,
  RequestId,
  RequestOptions,
  ServerRequestHandler,
} from "./types";

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

export interface JsonRpcMessageTransport {
  close(): Promise<void>;
  dispose(): void;
  onClose(handler: (reason: Error) => void): () => void;
  onMessage(handler: (message: string) => void): () => void;
  send(message: string): Promise<void>;
}

interface PendingRequest {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (value: JsonValue) => void;
}

export class JsonRpcPeer {
  private readonly transport: JsonRpcMessageTransport;
  private readonly options: JsonlRpcPeerOptions;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers = new Set<(reason: Error) => void>();
  private readonly unsubscribeClose: () => void;
  private readonly unsubscribeMessage: () => void;
  private writeQueue: Promise<void> = Promise.resolve();
  private notificationQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private serverRequestHandler: ServerRequestHandler | null = null;

  constructor(transport: JsonRpcMessageTransport, options: JsonlRpcPeerOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.unsubscribeMessage = transport.onMessage((message) => this.handleMessage(message));
    this.unsubscribeClose = transport.onClose((reason) => this.dispose(reason));
  }

  request<T = JsonValue>(
    method: string,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    this.assertOpen();
    validateRequestOptions(options);

    const id = this.nextRequestId();
    const signal = options.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const promise = new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      };
      const fail = (error: Error) => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.cleanup();
        request.reject(error);
      };

      this.pending.set(id, {
        cleanup,
        reject,
        resolve: (value) => resolve(value as T),
      });

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => fail(new AppServerRequestTimeoutError(method, options.timeoutMs!)),
          options.timeoutMs,
        );
      }
      if (signal) {
        abortHandler = () => fail(new AppServerRequestAbortedError(method, signal.reason));
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }

      if (!this.pending.has(id)) return;
      void this.enqueueWrite(
        {
          id,
          method,
          ...(params === undefined ? {} : { params }),
          ...(options.trace === undefined ? {} : { trace: options.trace }),
        },
        () => this.pending.has(id),
      ).catch((error) => fail(asError(error)));
    });

    return promise;
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.assertOpen();
    return this.enqueueWrite({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.assertOpen();
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.assertOpen();
    this.serverRequestHandler = handler;
    return () => {
      if (this.serverRequestHandler === handler) this.serverRequestHandler = null;
    };
  }

  onClose(handler: (reason: Error) => void): () => void {
    if (this.closed) throw new AppServerConnectionClosedError();
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(reason: Error = new AppServerConnectionClosedError()): Promise<void> {
    if (!this.beginClose(reason)) return;
    try {
      await this.transport.close();
    } finally {
      this.transport.dispose();
    }
  }

  dispose(reason: Error = new AppServerConnectionClosedError()): void {
    if (!this.beginClose(reason)) return;
    this.transport.dispose();
  }

  private beginClose(reason: Error): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeClose();
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(reason);
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.serverRequestHandler = null;
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(reason);
      } catch (error) {
        this.reportUnhandledError(asError(error));
      }
    }
    this.closeHandlers.clear();
    return true;
  }

  private nextRequestId(): RequestId {
    const id = normalizeRequestId(this.options.requestIdFactory?.() ?? randomUUID());
    if (this.pending.has(id)) throw new Error(`Duplicate JSON-RPC request id: ${String(id)}`);
    return id;
  }

  private assertOpen(): void {
    if (this.closed) throw new AppServerConnectionClosedError();
  }

  private enqueueWrite(message: JsonRpcMessage, shouldWrite: () => boolean = () => true): Promise<void> {
    this.assertOpen();
    let serialized: string;
    try {
      serialized = stringifyJsonPreservingBigInts(message);
    } catch (error) {
      return Promise.reject(
        new AppServerProtocolError("JSON-RPC message is not safely serializable.", {
          cause: error,
        }),
      );
    }
    const operation = this.writeQueue.then(() => {
      this.assertOpen();
      if (!shouldWrite()) return;
      return this.transport.send(serialized);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private handleMessage(messageText: string): void {
    if (!messageText.trim() || this.closed) return;

    let value: unknown;
    try {
      value = parseJsonPreservingLargeIntegers(messageText);
    } catch (error) {
      this.dispose(new AppServerProtocolError("Received invalid JSONL from codex app-server.", { cause: error }));
      return;
    }

    try {
      const message = classifyMessage(value);
      if ("method" in message) {
        if ("id" in message) {
          void this.handleServerRequest(message).catch((error) => this.dispose(asError(error)));
        } else {
          this.notificationQueue = this.notificationQueue
            .then(() => this.handleNotification(message))
            .catch((error) => this.reportUnhandledError(asError(error)));
        }
      } else {
        this.handleResponse(message);
      }
    } catch (error) {
      this.dispose(asError(error));
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    request.cleanup();

    if ("error" in response) request.reject(mapAppServerRpcError(response.error));
    else request.resolve(response.result);
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    for (const handler of [...this.notificationHandlers]) await handler(notification);
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.serverRequestHandler) {
      await this.enqueueWrite({
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${request.method}`,
        },
      } satisfies JsonRpcErrorResponse);
      return;
    }

    try {
      const result = await this.serverRequestHandler(request);
      if (result === undefined) {
        throw new AppServerServerRequestError(
          "Server request handler returned undefined instead of a JSON value.",
          -32603,
        );
      }
      await this.enqueueWrite({ id: request.id, result });
    } catch (error) {
      const requestError =
        error instanceof AppServerServerRequestError
          ? error
          : new AppServerServerRequestError(error instanceof Error ? error.message : String(error));
      await this.enqueueWrite({
        id: request.id,
        error: {
          code: requestError.code,
          message: requestError.message,
          ...(requestError.data === undefined ? {} : { data: requestError.data }),
        },
      });
    }
  }

  private reportUnhandledError(error: Error): void {
    if (this.options.onUnhandledError) this.options.onUnhandledError(error);
    else queueMicrotask(() => {
      throw error;
    });
  }
}

export class JsonlRpcPeer extends JsonRpcPeer {
  constructor(input: Readable, output: Writable, options: JsonlRpcPeerOptions = {}) {
    super(new JsonlStreamTransport(input, output), options);
  }
}

class JsonlStreamTransport implements JsonRpcMessageTransport {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly reader: ReadLineInterface;
  private readonly closeHandlers = new Set<(reason: Error) => void>();
  private readonly messageHandlers = new Set<(message: string) => void>();
  private readonly handleInputError = (error: Error) => this.signalClose(asError(error));
  private readonly handleOutputError = (error: Error) => this.signalClose(asError(error));
  private readonly handleReaderClose = () =>
    this.signalClose(
      new AppServerConnectionClosedError("codex app-server closed the JSONL stream."),
    );
  private closed = false;
  private closeReason: Error | null = null;

  constructor(input: Readable, output: Writable) {
    this.input = input;
    this.output = output;
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on("line", (line) => {
      for (const handler of [...this.messageHandlers]) handler(line);
    });
    this.reader.once("close", this.handleReaderClose);
    this.input.once("error", this.handleInputError);
    this.output.once("error", this.handleOutputError);
  }

  send(message: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closeReason ?? new AppServerConnectionClosedError());
    return new Promise<void>((resolve, reject) => {
      try {
        this.output.write(`${message}\n`, "utf8", (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(asError(error));
      }
    });
  }

  onMessage(handler: (message: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (reason: Error) => void): () => void {
    if (this.closeReason) {
      const reason = this.closeReason;
      queueMicrotask(() => handler(reason));
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): Promise<void> {
    this.dispose();
    return Promise.resolve();
  }

  dispose(): void {
    this.closed = true;
    this.reader.off("close", this.handleReaderClose);
    this.input.off("error", this.handleInputError);
    this.output.off("error", this.handleOutputError);
    this.reader.close();
    this.closeHandlers.clear();
    this.messageHandlers.clear();
  }

  private signalClose(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const handler of [...this.closeHandlers]) handler(reason);
  }
}

function classifyMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value)) throw new AppServerProtocolError("JSON-RPC payload must be an object.");

  if (Object.hasOwn(value, "method")) {
    if (typeof value.method !== "string" || value.method.length === 0) {
      throw new AppServerProtocolError("JSON-RPC method must be a non-empty string.");
    }
    if (Object.hasOwn(value, "id")) {
      if (!isRequestId(value.id)) throw new AppServerProtocolError("JSON-RPC request id is invalid.");
      return {
        id: value.id,
        method: value.method,
        ...(Object.hasOwn(value, "params") ? { params: value.params as JsonValue } : {}),
        ...(Object.hasOwn(value, "trace")
          ? { trace: validateTraceContext(value.trace) }
          : {}),
      };
    }
    return {
      ...(Object.hasOwn(value, "emittedAtMs")
        ? { emittedAtMs: validateNotificationTimestamp(value.emittedAtMs) }
        : {}),
      method: value.method,
      ...(Object.hasOwn(value, "params") ? { params: value.params as JsonValue } : {}),
    };
  }

  if (!isRequestId(value.id)) throw new AppServerProtocolError("JSON-RPC response id is invalid.");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    throw new AppServerProtocolError("JSON-RPC response must contain exactly one of result or error.");
  }
  if (hasError) {
    const error = value.error;
    if (!isRecord(error) || !isRpcErrorCode(error.code) || typeof error.message !== "string") {
      throw new AppServerProtocolError("JSON-RPC error response is malformed.");
    }
    return {
      id: value.id,
      error: {
        code: error.code,
        message: error.message,
        ...(Object.hasOwn(error, "data") ? { data: error.data as JsonValue } : {}),
      },
    };
  }
  return { id: value.id, result: value.result as JsonValue };
}

function validateRequestOptions(options: RequestOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new RangeError("timeoutMs must be a finite non-negative number.");
  }
  if (options.trace !== undefined) validateTraceContext(options.trace);
}

function validateNotificationTimestamp(value: unknown): bigint | number {
  if (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  throw new AppServerProtocolError(
    "JSON-RPC notification emittedAtMs must be an integer without numeric precision loss.",
  );
}

function validateTraceContext(value: unknown): JsonRpcRequest["trace"] {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new AppServerProtocolError("JSON-RPC trace must be an object or null.");
  }
  for (const field of ["traceparent", "tracestate"] as const) {
    if (
      Object.hasOwn(value, field) &&
      value[field] !== null &&
      typeof value[field] !== "string"
    ) {
      throw new AppServerProtocolError(`JSON-RPC trace ${field} must be a string or null.`);
    }
  }
  return {
    ...(Object.hasOwn(value, "traceparent")
      ? { traceparent: value.traceparent as string | null }
      : {}),
    ...(Object.hasOwn(value, "tracestate")
      ? { tracestate: value.tracestate as string | null }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequestId(value: unknown): RequestId {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") {
    if (value < MIN_I64 || value > MAX_I64) {
      throw new TypeError("Numeric request IDs must fit in a signed 64-bit integer.");
    }
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  throw new TypeError(
    "requestIdFactory must return a string or signed 64-bit integer without numeric precision loss.",
  );
}

function isRequestId(value: unknown): value is RequestId {
  return (
    typeof value === "string" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRpcErrorCode(value: unknown): value is JsonRpcErrorData["code"] {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "bigint" && value >= MIN_I64 && value <= MAX_I64)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stringifyJsonPreservingBigInts(value: unknown): string {
  for (;;) {
    const prefix = `__codex_app_server_bigint_${randomUUID()}_`;
    const markers: Array<{ literal: string; marker: string }> = [];
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new TypeError("JSON numbers must be finite.");
      }
      // Do not reject every unsafe integer-valued number here. Large finite f64 values such as
      // 1e16 and 1e100 also satisfy Number.isInteger(), and a schema-less JSON peer cannot recover
      // whether the caller originally intended integer or double semantics. Integer callers must
      // supply bigint before JavaScript rounds the value; numeric request IDs are schema-known and
      // validated separately by normalizeRequestId().
      if (typeof item !== "bigint") return item;
      const marker = `${prefix}${markers.length}__`;
      markers.push({ literal: item.toString(), marker });
      return marker;
    });
    if (serialized === undefined) {
      throw new TypeError("JSON value serialized to undefined.");
    }

    const replacements = markers.map(({ literal, marker }) => ({
      literal,
      quotedMarker: JSON.stringify(marker),
    }));
    if (
      replacements.some(
        ({ quotedMarker }) => countOccurrences(serialized, quotedMarker) !== 1,
      )
    ) {
      continue;
    }

    return replacements.reduce(
      (output, { literal, quotedMarker }) => output.replace(quotedMarker, literal),
      serialized,
    );
  }
}

function parseJsonPreservingLargeIntegers(source: string): unknown {
  // The token-preserving rewrite deliberately quotes numeric literals. Validate the untouched
  // source first so it cannot accidentally make malformed constructs (for example an unquoted
  // numeric object key) acceptable. The rounded result of this syntax-only parse is discarded.
  JSON.parse(source);
  let prefix = `__codex_app_server_bigint_${randomUUID()}_`;
  while (source.includes(prefix)) prefix = `__codex_app_server_bigint_${randomUUID()}_`;
  const transformed = quoteNumberTokens(source, prefix);
  return restoreJsonNumbers(JSON.parse(transformed), prefix, true);
}

function quoteNumberTokens(source: string, prefix: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      const end = endOfJsonString(source, index);
      output += source.slice(index, end);
      index = end;
      continue;
    }

    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      output += source[index];
      index += 1;
      continue;
    }

    const token = match[0];
    output += JSON.stringify(`${prefix}${token}`);
    index += token.length;
  }
  return output;
}

function restoreJsonNumbers(value: unknown, prefix: string, root: boolean): unknown {
  if (typeof value === "string" && value.startsWith(prefix)) {
    return numberFromJsonLiteral(value.slice(prefix.length));
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = restoreJsonNumbers(value[index], prefix, false);
    }
    return value;
  }
  if (!isRecord(value)) return value;

  for (const [key, item] of Object.entries(value)) {
    if (root && key === "id" && typeof item === "string" && item.startsWith(prefix)) {
      value[key] = requestIdFromJsonLiteral(item.slice(prefix.length));
      continue;
    }
    if (root && key === "error" && !Object.hasOwn(value, "method") && isRecord(item)) {
      value[key] = restoreJsonRpcErrorNumbers(item, prefix);
      continue;
    }
    value[key] = restoreJsonNumbers(item, prefix, false);
  }
  return value;
}

function restoreJsonRpcErrorNumbers(
  value: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  for (const [key, item] of Object.entries(value)) {
    value[key] =
      key === "code" && typeof item === "string" && item.startsWith(prefix)
        ? signedI64FromJsonLiteral(item.slice(prefix.length), "JSON-RPC error codes")
        : restoreJsonNumbers(item, prefix, false);
  }
  return value;
}

function numberFromJsonLiteral(literal: string): number | bigint {
  // Upstream typed integer serializers emit plain integer tokens. Decimal and exponent tokens keep
  // f64 semantics even when their mathematical value is integral; treating 1e16 or 1e100 as bigint
  // here would change valid public double fields in this otherwise schema-less layer.
  if (/^-?(?:0|[1-9]\d*)$/.test(literal)) {
    const integer = BigInt(literal);
    if (
      integer < BigInt(Number.MIN_SAFE_INTEGER) ||
      integer > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return integer;
    }
  }
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    throw new TypeError("JSON number exceeds the finite range supported by this client.");
  }
  return value;
}

function requestIdFromJsonLiteral(literal: string): RequestId {
  return signedI64FromJsonLiteral(literal, "JSON-RPC numeric request IDs");
}

function signedI64FromJsonLiteral(literal: string, subject: string): bigint | number {
  if (!/^-?(?:0|[1-9]\d*)$/.test(literal)) {
    throw new TypeError(`${subject} must be integers.`);
  }
  const integer = BigInt(literal);
  if (integer < MIN_I64 || integer > MAX_I64) {
    throw new TypeError(`${subject} must fit in a signed 64-bit integer.`);
  }
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(literal)
    : integer;
}

function endOfJsonString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === '"') return index + 1;
    else index += 1;
  }
  return source.length;
}

function countOccurrences(source: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}
