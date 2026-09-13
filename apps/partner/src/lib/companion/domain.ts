export const MAX_NOTE_CODE_POINTS = 40;
export const MAX_SIGNATURE_CODE_POINTS = 80;
export const MAX_CHANGE_REASON_CODE_POINTS = 160;
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 20;

export const MOODS = [
  "neutral",
  "serene",
  "bright",
  "playful",
  "tender",
  "pensive",
  "tired",
  "low",
] as const;
export type Mood = (typeof MOODS)[number];
export const MOOD_LABELS: Readonly<Record<Mood, string>> = Object.freeze({
  neutral: "如常",
  serene: "平静",
  bright: "愉快",
  playful: "俏皮",
  tender: "柔和",
  pensive: "若有所思",
  tired: "疲惫",
  low: "低落",
});

export interface MoodRecord {
  mood: Mood;
  note?: string;
}

export interface CompanionState extends MoodRecord {
  affinity: number;
  signature: string;
}

export interface CompanionMoodChange {
  value: Mood;
  note?: string;
  reason?: string;
}

export interface CompanionAffinityChange {
  delta: number;
  value: number;
  reason?: string;
}

export interface CompanionSignatureChange {
  value: string;
  reason?: string;
}

export interface CompanionStateChanges {
  seed?: true;
  mood?: CompanionMoodChange;
  affinity?: CompanionAffinityChange;
  signature?: CompanionSignatureChange;
}

export interface CompanionStateRecord {
  at: string;
  changes: CompanionStateChanges;
  state: CompanionState;
}

export interface CompanionHistoryPage {
  /** Records are newest first within this page. */
  records: CompanionStateRecord[];
  /** The next `before` cursor, or undefined when this is the oldest page. */
  nextBefore?: number;
  hasEarlier: boolean;
  /** The complete record immediately before the oldest visible record. */
  predecessor?: CompanionStateRecord;
}

export type CompanionHistoryValue =
  | { value: Mood; note?: string }
  | { value: number }
  | { value: string };

export interface CompanionHistoryChange {
  dimension: "mood" | "affinity" | "signature";
  before?: CompanionHistoryValue;
  after: CompanionHistoryValue;
  reason?: string;
}

export { companionHistoryChanges } from "./relationship-history.ts";

export interface RelationshipUpdate {
  mood?: { value: Mood; note?: string; reason: string };
  affinity?: { delta: number; reason: string };
}

export interface AvatarInput {
  data: string;
  mediaType: AvatarMediaType;
  width: number;
  height: number;
}
export type AvatarMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface CompanionIdentitySettings {
  workspaceId: string;
  companionName: string;
  companionAvatar?: AvatarInput;
  userName: string;
  userAvatar?: AvatarInput;
  preferredAddress: string;
  defaultAffinity: number;
}

export const DEFAULT_MOOD: MoodRecord = Object.freeze({
  mood: "neutral",
});

export class CompanionValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CompanionValidationError";
  }
}

// oxlint-disable-next-line no-control-regex -- reject the full C0/C1 range.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const URL_PATTERN = /(?:https?:\/\/|www\.|[a-z][a-z0-9+.-]*:\/\/)/iu;
const MARKUP_PATTERN = /<[^>]*>|\[\/?[a-z][^\]]*\]/iu;

export function isMood(value: unknown): value is Mood {
  return (
    typeof value === "string" && (MOODS as readonly string[]).includes(value)
  );
}

/** Trim a note without changing its meaning; notes are descriptive data. */
export function canonicalizeMoodNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new CompanionValidationError("状态短句必须是文字。");
  }
  const normalized = value.trim().replace(CONTROL_CHARACTERS, "");
  if (Array.from(normalized).length > MAX_NOTE_CODE_POINTS) {
    throw new CompanionValidationError("状态短句不能超过 40 个字符。");
  }
  return normalized || undefined;
}

export function canonicalizeMood(value: unknown): MoodRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionValidationError("状态格式无效。");
  }
  const record = value as Record<string, unknown>;
  if (!isMood(record.mood))
    throw new CompanionValidationError("状态类型无效。");
  const allowed = new Set(["mood", "note"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new CompanionValidationError("状态包含未知字段。");
  }
  const note = canonicalizeMoodNote(record.note);
  return note === undefined
    ? { mood: record.mood }
    : { mood: record.mood, note };
}

export function canonicalizeChangeReason(value: unknown): string {
  if (typeof value !== "string")
    throw new CompanionValidationError("变化原因必须是文字。");
  const normalized = value.trim().replace(CONTROL_CHARACTERS, "");
  if (
    !normalized ||
    Array.from(normalized).length > MAX_CHANGE_REASON_CODE_POINTS
  ) {
    throw new CompanionValidationError("请提供不超过 160 个字符的变化原因。");
  }
  return normalized;
}

export function canonicalizeHistoryLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_HISTORY_LIMIT
  ) {
    throw new CompanionValidationError("历史记录数量必须是 1 到 20 的整数。");
  }
  return value;
}

export function canonicalizeHistoryRead(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionValidationError("历史读取格式无效。");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "limit")) {
    throw new CompanionValidationError("历史读取包含未知字段。");
  }
  return canonicalizeHistoryLimit(record.limit);
}

export interface CompanionHistoryPageRead {
  limit: number;
  /** Absolute exclusive record position, counted from the beginning. */
  before?: number;
}

export function canonicalizeHistoryPageRead(
  value: unknown,
): CompanionHistoryPageRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionValidationError("历史分页读取格式无效。");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "limit" && key !== "before")) {
    throw new CompanionValidationError("历史分页读取包含未知字段。");
  }
  const limit = canonicalizeHistoryLimit(record.limit);
  if (record.before === undefined) return { limit };
  if (
    typeof record.before !== "number" ||
    !Number.isSafeInteger(record.before) ||
    record.before < 0
  ) {
    throw new CompanionValidationError("历史分页位置必须是非负整数。");
  }
  return { limit, before: record.before };
}

function canonicalizeOptionalChangeReason(value: unknown): string | undefined {
  return value === undefined ? undefined : canonicalizeChangeReason(value);
}

export function canonicalizeRelationshipUpdate(
  value: unknown,
): RelationshipUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionValidationError("关系反应格式无效。");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "mood" && key !== "affinity")) {
    throw new CompanionValidationError("关系反应包含未知字段。");
  }
  if (record.mood === undefined && record.affinity === undefined) {
    throw new CompanionValidationError("请至少更新此刻状态或亲近度。");
  }
  const update: RelationshipUpdate = {};
  if (record.mood !== undefined) {
    if (
      typeof record.mood !== "object" ||
      record.mood === null ||
      Array.isArray(record.mood)
    ) {
      throw new CompanionValidationError("此刻状态变化格式无效。");
    }
    const rawMood = record.mood as Record<string, unknown>;
    if (
      Object.keys(rawMood).some(
        (key) => !["value", "note", "reason"].includes(key),
      )
    ) {
      throw new CompanionValidationError("此刻状态变化包含未知字段。");
    }
    const mood = canonicalizeMood({
      mood: rawMood.value,
      ...(rawMood.note === undefined ? {} : { note: rawMood.note }),
    });
    update.mood = {
      value: mood.mood,
      ...(mood.note === undefined ? {} : { note: mood.note }),
      reason: canonicalizeChangeReason(rawMood.reason),
    };
  }
  if (record.affinity !== undefined) {
    if (
      typeof record.affinity !== "object" ||
      record.affinity === null ||
      Array.isArray(record.affinity)
    ) {
      throw new CompanionValidationError("亲近度变化格式无效。");
    }
    const rawAffinity = record.affinity as Record<string, unknown>;
    if (
      Object.keys(rawAffinity).some(
        (key) => key !== "delta" && key !== "reason",
      )
    ) {
      throw new CompanionValidationError("亲近度变化包含未知字段。");
    }
    if (
      typeof rawAffinity.delta !== "number" ||
      !Number.isSafeInteger(rawAffinity.delta) ||
      rawAffinity.delta < -10 ||
      rawAffinity.delta > 10
    ) {
      throw new CompanionValidationError("亲近度变化必须是 -10 到 10 的整数。");
    }
    update.affinity = {
      delta: rawAffinity.delta,
      reason: canonicalizeChangeReason(rawAffinity.reason),
    };
  }
  return update;
}

/**
 * Canonicalize an agent-authored signature. Newlines become a single space so
 * a well-intentioned model cannot break the profile layout; active markup and
 * URLs are rejected instead of rendered as HTML or links.
 */
export function canonicalizeSignature(value: unknown): string {
  if (typeof value !== "string") {
    throw new CompanionValidationError("签名必须是文字。");
  }
  const normalized = value
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (URL_PATTERN.test(normalized)) {
    throw new CompanionValidationError("签名不能包含链接。");
  }
  if (MARKUP_PATTERN.test(normalized)) {
    throw new CompanionValidationError("签名不能包含标记语法。");
  }
  if (Array.from(normalized).length > MAX_SIGNATURE_CODE_POINTS) {
    throw new CompanionValidationError("签名不能超过 80 个字符。");
  }
  return normalized;
}

export function clampAffinity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

export type AffinityStage = "疏离" | "生疏" | "熟悉" | "亲近" | "深厚";

export function affinityStage(value: number): AffinityStage {
  const affinity = clampAffinity(value);
  if (affinity < 20) return "疏离";
  if (affinity < 40) return "生疏";
  if (affinity < 60) return "熟悉";
  if (affinity < 80) return "亲近";
  return "深厚";
}

export function normalizeDefaultAffinity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new CompanionValidationError("默认亲近度必须是 0 到 100 的整数。");
  }
  return value;
}
