/**
 * The browser/Companion boundary for the optional DSH Speech short-audio service.
 * Keep this module free of browser and Node-only APIs so both bundles can use
 * the same admission rules.
 */

/** Qwen3-ASR-Flash's synchronous complete Base64 Data URL bound. */
export const MAX_VOICE_DATA_URL_BYTES = 10 * 1024 * 1024;
/** Companion stops capture before the provider's duration policy can reject it. */
export const MAX_VOICE_DURATION_MS = 5 * 60 * 1000;
export const VOICE_TRANSCRIBE_ENDPOINT = "voice/transcribe" as const;
export const VOICE_CAPABILITY_ENDPOINT = "voice/capability" as const;

/** Media types advertised by the optional DSH ASR contract. */
export const VOICE_AUDIO_MEDIA_TYPES = [
  "audio/aac",
  "audio/amr",
  "audio/aiff",
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/x-ms-wma",
] as const;

export type VoiceAudioMediaType = (typeof VOICE_AUDIO_MEDIA_TYPES)[number];

/** Labels normalized by DSH Speech from Qwen's model-derived speech expression. */
export const VOICE_EXPRESSIONS = [
  "surprised",
  "neutral",
  "happy",
  "sad",
  "disgusted",
  "angry",
  "fearful",
] as const;

export type VoiceExpression = (typeof VOICE_EXPRESSIONS)[number];

const PARAM_TOKEN = "[a-z0-9!#$&^_.+-]+";
const AUDIO_MEDIA_TYPE_PATTERN = new RegExp(
  `^audio\\/[a-z0-9][a-z0-9.+-]*(?:\\s*;\\s*${PARAM_TOKEN}=${PARAM_TOKEN})*$`,
  "u",
);

/**
 * Normalize and allowlist a declared audio media type. Parameters (for
 * example `codecs=opus`) are retained because MediaRecorder may emit them.
 */
export function normalizeVoiceMediaType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  const normalized = value.trim().toLowerCase();
  // The Data URL admission count is a byte count; keep the normalized MIME
  // token ASCII so its string length is its encoded byte length.
  // This deliberate control-range match enforces an ASCII MIME token.
  // oxlint-disable-next-line no-control-regex -- the range is the validation contract.
  if (!/^[\x00-\x7F]*$/u.test(normalized)) return undefined;
  const base = normalized.split(";", 1)[0]?.trim();
  if (!base || !AUDIO_MEDIA_TYPE_PATTERN.test(normalized)) return undefined;
  return (VOICE_AUDIO_MEDIA_TYPES as readonly string[]).includes(base)
    ? normalized
    : undefined;
}

/** Return the allowlisted base media type without parameters. */
export function voiceMediaBaseType(
  value: unknown,
): VoiceAudioMediaType | undefined {
  const normalized = normalizeVoiceMediaType(value);
  if (!normalized) return undefined;
  return normalized.split(";", 1)[0] as VoiceAudioMediaType;
}

export function isVoiceExpression(value: unknown): value is VoiceExpression {
  return (
    typeof value === "string" &&
    (VOICE_EXPRESSIONS as readonly string[]).includes(
      value.trim().toLowerCase(),
    )
  );
}

export function normalizeVoiceExpression(
  value: unknown,
): VoiceExpression | undefined {
  if (!isVoiceExpression(value)) return undefined;
  return value.trim().toLowerCase() as VoiceExpression;
}

/** Return the normalized Data URL prefix sent to the synchronous ASR service. */
export function voiceDataUrlPrefix(mediaType: unknown): string | undefined {
  const normalized = normalizeVoiceMediaType(mediaType);
  return normalized ? `data:${normalized};base64,` : undefined;
}

/** Base64 character count for a decoded byte count (RFC 4648 padding included). */
export function voiceBase64Length(rawBytes: number): number | undefined {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) return undefined;
  const encodedLength = Math.ceil(rawBytes / 3) * 4;
  return Number.isSafeInteger(encodedLength) ? encodedLength : undefined;
}

/** Complete Data URL character/byte count for a normalized media type and raw bytes. */
export function voiceDataUrlByteLength(
  mediaType: unknown,
  rawBytes: number,
): number | undefined {
  const prefix = voiceDataUrlPrefix(mediaType);
  const encodedLength = voiceBase64Length(rawBytes);
  return prefix === undefined || encodedLength === undefined
    ? undefined
    : prefix.length + encodedLength;
}

/** Largest raw byte count whose complete Data URL remains within the provider bound. */
export function maxVoiceAudioBytesForMediaType(
  mediaType: unknown,
  limit = MAX_VOICE_DATA_URL_BYTES,
): number | undefined {
  const prefix = voiceDataUrlPrefix(mediaType);
  if (prefix === undefined || !Number.isSafeInteger(limit) || limit < 0)
    return undefined;
  const availableBase64Chars = limit - prefix.length;
  if (availableBase64Chars < 4) return 0;
  return Math.floor(availableBase64Chars / 4) * 3;
}

/** Maximum canonical Base64 payload length admitted for this media type. */
export function maxVoiceBase64CharsForMediaType(
  mediaType: unknown,
  limit = MAX_VOICE_DATA_URL_BYTES,
): number | undefined {
  const maxRawBytes = maxVoiceAudioBytesForMediaType(mediaType, limit);
  return maxRawBytes === undefined ? undefined : voiceBase64Length(maxRawBytes);
}

/** Shared admission check for browser Blobs and decoded Host RPC payloads. */
export function isVoiceAudioWithinDataUrlLimit(
  mediaType: unknown,
  rawBytes: number,
  limit = MAX_VOICE_DATA_URL_BYTES,
): boolean {
  const dataUrlLength = voiceDataUrlByteLength(mediaType, rawBytes);
  return dataUrlLength !== undefined && dataUrlLength <= limit;
}

/**
 * Canonical RFC 4648 Base64 has no whitespace, URL-safe substitutions, or
 * spare padding. An optional character bound lets the Host reject an
 * oversized payload before decoding it.
 */
export function isCanonicalBase64(
  value: unknown,
  maxChars?: number,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0)
    return false;
  if (
    maxChars !== undefined &&
    (!Number.isSafeInteger(maxChars) || maxChars < 0 || value.length > maxChars)
  )
    return false;
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 61) {
      padding += 1;
      if (padding > 2 || index < value.length - 2) return false;
      continue;
    }
    if (
      padding > 0 ||
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  return true;
}
