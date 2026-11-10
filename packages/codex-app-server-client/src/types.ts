export type JsonValue =
  | bigint
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue };
export type JsonInputValue =
  | bigint
  | boolean
  | null
  | number
  | string
  | readonly JsonInputValue[]
  | { readonly [key: string]: JsonInputValue | undefined };
export type RequestId = bigint | number | string;

export interface W3cTraceContext {
  traceparent?: string | null;
  tracestate?: string | null;
}

export interface JsonRpcErrorData {
  code: bigint | number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
  trace?: W3cTraceContext | null;
}

export interface JsonRpcNotification {
  emittedAtMs?: bigint | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  id: RequestId;
  result: JsonValue;
}

export interface JsonRpcErrorResponse {
  id: RequestId;
  error: JsonRpcErrorData;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: W3cTraceContext | null;
}

export type NotificationHandler = (
  notification: JsonRpcNotification,
) => void | Promise<void>;

export type ServerRequestHandler = (
  request: JsonRpcRequest,
) => JsonValue | Promise<JsonValue>;

export interface JsonlRpcPeerOptions {
  onUnhandledError?: (error: Error) => void;
  requestIdFactory?: () => RequestId;
}
