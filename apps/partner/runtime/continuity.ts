/** Lifecycle states intentionally contain no checkpoint, prompt, or summary text. */
export type CompactionLifecycleStatus = "running" | "complete" | "failed";

export interface CompactionLifecycleState {
  readonly compactionId: string;
  readonly nativeId?: string;
  readonly status: CompactionLifecycleStatus;
  readonly startSeq: number;
  readonly startedAt: number;
  readonly endSeq?: number;
  readonly endedAt?: number;
}

/** Official telemetry may be temporarily unknown; zero is a real observation. */
export type ContextObservation = { activeTokens: number | null; windowTokens: number | null };
export type CompactBoundary = { id: string; anchorId: string | null; position: 'before' | 'after-user' | 'after'; time: number };
export type CompactionPhase = 'pre_turn' | 'mid_turn';

/** Build the smallest presentation anchor from the SDK compaction boundary. */
export function createCompactBoundary(id: string, activeOperationId: string | null, completedOperationId: string | null,
  phase: CompactionPhase, time: number): CompactBoundary {
  return { id, anchorId: activeOperationId ?? completedOperationId,
    position: activeOperationId ? (phase === 'mid_turn' ? 'after-user' : 'before') : 'after', time };
}

/** Combine durable presentation anchors with the current in-process lifecycle. */
export function projectContinuity(compactions: readonly CompactBoundary[], latest?: CompactionLifecycleState) {
  return { compactions: [...compactions], lifecycle: { lifecycles: latest ? [latest] : [], latest } };
}
