import type { CompactionLifecycleState } from './companion/continuity.ts';
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

import type { TimelineMessageUnit } from './companion/projection.ts';
/** Keep boundaries between the same visible contributions, including mid-turn. */
export function insertCompactBoundaries(units: readonly TimelineMessageUnit[], boundaries: readonly CompactBoundary[]): TimelineMessageUnit[] {
  const slots = new Map<number, TimelineMessageUnit[]>();
  for (const boundary of boundaries) {
    let index = 0;
    if (boundary.anchorId) {
      const user = units.findIndex(unit => unit.id === `${boundary.anchorId}:user`);
      const answer = units.findIndex(unit => unit.id === `${boundary.anchorId}:answer`);
      if (user < 0) continue;
      index = boundary.position === 'before' ? user : boundary.position === 'after-user' ? user + 1 : (answer < 0 ? user : answer) + 1;
    }
    const records = slots.get(index) ?? [];
    records.push({ id: boundary.id, side: 'incoming', items: [{ id: boundary.id, messageKey: boundary.id, kind: 'continuity',
      side: 'incoming', tone: 'success', compactionId: boundary.id, text: '', time: boundary.time, anchorSeq: index }] });
    slots.set(index, records);
  }
  return Array.from({ length: units.length + 1 }, (_, index) => [...(slots.get(index) ?? []), ...(units[index] ? [units[index]] : [])]).flat();
}
