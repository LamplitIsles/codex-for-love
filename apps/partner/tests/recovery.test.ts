import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionRecovery, type RecoveryStream } from '../src/lib/companion/client/recovery.ts';

class Clock {
  now = 0; private next = 1; readonly requested: number[] = []; readonly timers = new Map<number, { at: number; run: () => void }>();
  set(run: () => void, ms: number) { this.requested.push(ms); const id = this.next++; this.timers.set(id, { at: this.now + ms, run }); return id; }
  clear(id: number) { this.timers.delete(id); }
  advance(ms: number) { this.now += ms; for (;;) { const due = [...this.timers.entries()].find(([, timer]) => timer.at <= this.now); if (!due) return; this.timers.delete(due[0]); due[1].run(); } }
  delays() { return [...this.timers.values()].map(timer => timer.at - this.now); }
}
class Stream implements RecoveryStream {
  onopen: ((event: Event) => void) | null = null; onerror: ((event: Event) => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null; closed = false; heartbeat?: (event: Event) => void;
  addEventListener(_: 'heartbeat', listener: (event: Event) => void) { this.heartbeat = listener; }
  close() { this.closed = true; }
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('replacement waits for an aborted old read then synchronizes its own generation', async () => {
  const clock = new Clock(); const streams: Stream[] = []; const changes: boolean[] = []; const listeners = new Map<string, () => void>();
  const calls: Array<{ generation: number; resolve: () => void }> = [];
  const recovery = new CompanionRecovery({
    open: () => { const stream = new Stream(); streams.push(stream); return stream; },
    sync: (signal, generation) => new Promise<void>((resolve, reject) => {
      calls.push({ generation, resolve }); signal.addEventListener('abort', () => reject(new Error('obsolete')));
    }), now: () => clock.now, changed: value => changes.push(value),
    window: { visible: () => true, on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) },
  });
  recovery.start(); assert.equal(calls[0]!.generation, 1);
  listeners.get('pageshow')!(); assert.equal(streams[0]!.closed, true);
  for (let index = 0; index < 8; index += 1) await tick();
  assert.deepEqual(calls.map(call => call.generation), [1, 2]);
  assert.equal(changes.includes(true), false);
  calls[1]!.resolve(); await tick(); await tick();
  assert.equal(changes.at(-1), true);
  recovery.close();
});

test('recovery aborts hanging reads, caps retries, resets after success, and cleans up', async () => {
  const clock = new Clock(); const streams: Stream[] = []; const changes: boolean[] = []; let visible = true;
  const listeners = new Map<string, () => void>(); const calls: Array<{ generation: number; signal: AbortSignal }> = [];
  const recovery = new CompanionRecovery({
    open: () => { const stream = new Stream(); streams.push(stream); return stream; },
    sync: (signal, generation) => new Promise<void>((resolve, reject) => { calls.push({ generation, signal }); signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
    now: () => clock.now, changed: value => changes.push(value),
    window: { visible: () => visible, on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) },
  });
  recovery.start(); assert.deepEqual(changes, [false]);
  clock.advance(15000); await tick(); assert.equal(calls[0]!.signal.aborted, true); assert.deepEqual(clock.delays(), [1000]);
  for (const delay of [1000, 2000, 4000, 8000, 15000]) { clock.advance(delay); await tick(); clock.advance(15000); await tick(); }
  assert(clock.requested.includes(15000));
  // A foreground pageshow replaces the stale stream without an online event.
  listeners.get('pageshow')!(); await tick(); assert.equal(streams.at(-2)!.closed, true);
  recovery.close();
  assert.equal([...listeners.keys()].length, 0);
});

test('heartbeat schedules watchdog from its own timestamp and hidden pages stop it', async () => {
  const clock = new Clock(); const streams: Stream[] = []; let visible = true; const listeners = new Map<string, () => void>(); let resolve!: () => void;
  const recovery = new CompanionRecovery({
    open: () => { const stream = new Stream(); streams.push(stream); return stream; }, sync: () => new Promise<void>(done => { resolve = done; }),
    now: () => clock.now, changed: () => undefined,
    window: { visible: () => visible, on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) },
  });
  recovery.start(); resolve(); await tick(); streams[0]!.heartbeat?.(new Event('heartbeat')); clock.advance(44999); assert.equal(streams.length, 1); clock.advance(1); assert.equal(streams.length, 2);
  visible = false; listeners.get('visibilitychange')!(); assert.equal(clock.delays().length, 0); recovery.close();
});

test('a successful snapshot before any stream event uses its fresh 45-second liveness baseline', async () => {
  const clock = new Clock(); const streams: Stream[] = []; let resolve!: () => void;
  const recovery = new CompanionRecovery({
    open: () => { const stream = new Stream(); streams.push(stream); return stream; }, sync: () => new Promise<void>(done => { resolve = done; }),
    now: () => clock.now, changed: () => undefined,
    window: { visible: () => true, on: () => () => undefined, setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) },
  });
  recovery.start(); resolve(); await tick(); clock.advance(44999); assert.equal(streams.length, 1); clock.advance(1); assert.equal(streams.length, 2); recovery.close();
});

test('an SSE error invalidates a held current sync until replacement succeeds', async () => {
  const clock = new Clock(); const streams: Stream[] = []; const changes: boolean[] = []; const pending: Array<() => void> = [];
  const recovery = new CompanionRecovery({
    open: () => { const stream = new Stream(); streams.push(stream); return stream; }, sync: () => new Promise<void>(resolve => pending.push(resolve)),
    now: () => clock.now, changed: value => changes.push(value),
    window: { visible: () => true, on: () => () => undefined, setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) },
  });
  recovery.start(); streams[0]!.onerror?.(new Event('error')); pending[0]!(); await tick(); await tick();
  assert.equal(changes.includes(true), false); clock.advance(1000); await tick(); pending[1]!(); await tick(); await tick();
  assert.equal(changes.at(-1), true); recovery.close();
});
