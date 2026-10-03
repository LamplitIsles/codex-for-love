/** Qwen3-ASR-Flash's synchronous complete Base64 Data URL bound. */
export const MAX_VOICE_DATA_URL_BYTES = 10 * 1024 * 1024;
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
