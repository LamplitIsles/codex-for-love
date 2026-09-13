import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompactBoundary, projectContinuity, insertCompactBoundaries } from '../src/lib/continuity.ts';
import type { CompactionLifecycleState } from '../src/lib/companion/continuity.ts';
import type { TimelineMessageUnit } from '../src/lib/companion/projection.ts';

test('automatic pre-turn and mid-turn compact boundaries use engine operation identity, not pending message order', () => {
  const pre = createCompactBoundary('compact:pre', 'one', 'old', 'pre_turn', 2000);
  const mid = createCompactBoundary('compact:mid', 'one', 'pending', 'mid_turn', 5000);
  const view = projectContinuity([pre, mid], { compactionId: 'compact:mid', status: 'complete', startSeq: 4, startedAt: 4000, endSeq: 5, endedAt: 5000 });
  const units = ['one:user', 'one:answer', 'pending:user'].map(id => ({ id, side: 'incoming', items: [] } as TimelineMessageUnit));
  assert.deepEqual(insertCompactBoundaries(units, view.compactions).map(unit => unit.id), ['compact:pre', 'one:user', 'compact:mid', 'one:answer', 'pending:user']);
  assert.equal(view.lifecycle.latest?.status, 'complete');
  const failed: CompactionLifecycleState = { compactionId: 'compact:failed', status: 'failed', startSeq: 1, startedAt: 1000, endSeq: 2, endedAt: 2000 };
  assert.equal(projectContinuity([], failed).compactions.length, 0);
  assert.equal(projectContinuity([], failed).lifecycle.latest?.status, 'failed');
  assert.equal(projectContinuity([pre]).lifecycle.latest, undefined);
});
