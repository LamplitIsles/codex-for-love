const MAX_STRING_LENGTH = 240;
const MAX_LOG_BYTES = 2048;
const MAX_COLLECTION_ITEMS = 16;
const SENSITIVE_KEY = /(?:input|prompt|content|body|data|image|audio|history|summary|frame|request|response|authorization|credential|secret|token|password)/iu;
const SENSITIVE_ERROR = /\b(?:input|prompt|content|body|data|image|audio|history|summary|authorization|credential|secret|token|password)\b/iu;
const IMAGE_DATA = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gu;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu;

function redactText(value: string): string {
  return value.replace(IMAGE_DATA, '[REDACTED_IMAGE]').replace(BEARER, 'Bearer [REDACTED]').slice(0, MAX_STRING_LENGTH);
}

function redactError(value: string): string {
  const safe = redactText(value);
  return SENSITIVE_ERROR.test(value) ? '[REDACTED_ERROR]' : safe;
}

function redact(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[REDACTED]';
  if (value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => redact(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_COLLECTION_ITEMS).map(([childKey, childValue]) => [childKey, redact(childValue, childKey, depth + 1)]));
  }
  return String(value);
}

function bounded(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_LOG_BYTES) return value;
  const suffix = '…[truncated]';
  const limit = MAX_LOG_BYTES - Buffer.byteLength(suffix, 'utf8');
  let prefix = Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > limit) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

/** Emit process diagnostics without persisting model or provider payloads. */
export function processLog(event: string, details: Record<string, unknown> = {}): void {
  const safeDetails = redact(details) as Record<string, unknown>;
  const record = JSON.stringify({ component: 'partner', event: redactText(event), ...safeDetails });
  console.error(`[partner] ${bounded(record)}`);
}

/** Emit a bounded error message while keeping the original error out of logs. */
export function processError(event: string, error: unknown, details: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  processLog(event, { ...details, error: redactError(message) });
}
