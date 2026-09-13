export type ContextPressureProjection = { contextWindow: number; projectedTokens?: number; pressureTokens?: number };
export const COMPACTION_STATUS_DURATION_MS = 8_000;

/** A safe, provider-neutral capacity value suitable for Companion copy. */
export interface ContextCapacity {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly percentage: number;
}

/** Lifecycle states intentionally contain no checkpoint, prompt, or summary text. */
export type CompactionLifecycleStatus = "running" | "complete" | "failed";

export interface CompactionLifecycleState {
  readonly compactionId: string;
  readonly status: CompactionLifecycleStatus;
  readonly startSeq: number;
  readonly startedAt: number;
  readonly endSeq?: number;
  readonly endedAt?: number;
}

export interface CompanionContinuitySnapshot {
  readonly lifecycles: readonly CompactionLifecycleState[];
  readonly latest?: CompactionLifecycleState;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the token-meter projection into the only capacity facts Companion
 * needs. A present projected value is authoritative; the provider anchor is
 * used only when projection is absent. Malformed telemetry is hidden rather
 * than guessed at.
 */
export function resolveContextCapacity(
  value: unknown,
): ContextCapacity | undefined {
  const record = asRecord(value);
  if (!record || !positiveFinite(record.contextWindow)) return undefined;
  const hasProjection =
    Object.hasOwn(record, "projectedTokens") &&
    record.projectedTokens !== undefined;
  const selected = hasProjection
    ? record.projectedTokens
    : record.pressureTokens;
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected < 0) return undefined;
  return {
    usedTokens: selected,
    contextWindow: record.contextWindow,
    percentage: Math.min(
      100,
      Math.max(0, Math.round((selected / record.contextWindow) * 100)),
    ),
  };
}

/** Round a token estimate to a quiet, human-scale value for Companion copy. */
export function roundTokenEstimate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  const unit = value >= 1_000 ? 1_000 : 100;
  return Math.round(value / unit) * unit;
}

/** Format an already-validated token count for the compact capacity display. */
export function formatTokenCount(value: unknown): string | undefined {
  const rounded = roundTokenEstimate(value);
  if (rounded === undefined) return undefined;
  if (rounded >= 1_000) return `${Math.round(rounded / 1_000)}k`;
  return String(rounded);
}

export interface ContinuityRecord {
  readonly id: string;
  /** Stable source contribution key used by the canonical message-unit projection. */
  readonly messageKey: string;
  readonly kind: "continuity";
  readonly side: "incoming";
  readonly tone: "success";
  readonly compactionId: string;
  readonly text: string;
  readonly time?: number;
  readonly anchorSeq: number;
}
