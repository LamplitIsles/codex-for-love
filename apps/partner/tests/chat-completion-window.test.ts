import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createChatHost } from '@lamplit/contracts/server';
import type { Partner } from '../runtime/partner.ts';

for (const finishDuringRead of [true, false]) test(`two-message window remains continuous when ${finishDuringRead ? 'completion occurs during' : 'nothing changes during'} receipt lookup`, async () => {
  let complete = false, hold = false, snapshots = 0;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const partner = {
    async sharedRecovery() { return []; },
    async sharedImageLimits() { return false; },
    async sharedFileLimits() { return false; },
    async snapshot() {
      snapshots++;
      return structuredClone({ sessionId: 'fixture-session', name: 'Mica', cancellable: ['turn'], context: null,
        lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'turn', inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: 'turn', anchorSequence: 1, anchorCreated: 1, sourceIds: ['a'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 },
          { kind: 'text', itemId: 'b', text: complete ? 'B final' : 'B', textState: complete ? 'complete' : 'streaming', position: 1 },
        ] }],
      });
    },
    async chatReceipt() { if (hold) { entered(); await gate; } return { state: 'submitted' }; },
    streamingReply() { return complete ? undefined : { id: 'b', turnId: 'turn', text: 'B' }; },
    replyCompletion() { return undefined; },
  } as unknown as Partner;
  const backend = createCodexChatBackend(partner);
  const first = await backend.read();
  hold = true;
  const pending = backend.read();
  await reading;
  complete = finishDuringRead;
  hold = false; release();
  const middle = await pending;
  const last = await backend.read();
  assert.deepEqual([first, middle, last].map(view => view.messages.map(message => message.id)), [['a', 'b'], ['a', 'b'], ['a', 'b']]);
  assert.equal(first.messages[1]?.textState, 'streaming');
  assert.equal(middle.messages[1]?.textState, finishDuringRead ? 'complete' : 'streaming');
  assert.equal(middle.messages[1]?.text, finishDuringRead ? 'B final' : 'B');
  assert.equal(last.messages[1]?.textState, finishDuringRead ? 'complete' : 'streaming');
  assert.equal(snapshots, finishDuringRead ? 4 : 3, 'ordinary reads do not rescan history');
});

test('an unsettled projection does not publish a missing message or resurrect an obsolete stream', async () => {
  let snapshots = 0, settled = false;
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      snapshots++;
      return { sessionId: 'fixture-session', name: 'Mica', cancellable: [], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'turn', inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: 'turn', anchorSequence: 1, anchorCreated: 1, sourceIds: ['a'], chatStatus: 'failed', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 }, { kind: 'text', itemId: 'b', text: settled ? 'final' : 'obsolete', textState: settled ? 'complete' : 'streaming', position: 1 },
        ] }] };
    },
    async chatReceipt() { return { state: 'submitted' }; },
    streamingReply() { return undefined; }, replyCompletion() { return undefined; },
  } as unknown as Partner;
  const backend = createCodexChatBackend(partner);
  await assert.rejects(backend.read(), /chat projection.*changed/i);
  assert.equal(snapshots, 3);
  settled = true;
  const view = await backend.read();
  assert.deepEqual(view.messages.map(message => message.id), ['a', 'b', 'result:status']);
  assert.equal(view.messages[1]?.text, 'final');
  assert.equal(view.messages[1]?.textState, 'complete');
  assert.equal(view.streamingReply, undefined);
});

test('repeated completion during receipt lookup exhausts retries without publishing a partial window', async () => {
  let snapshots = 0;
  let streaming: { id: string; turnId: string; text: string } | undefined;
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      const id = `b${++snapshots}`;
      streaming = { id, turnId: 'turn', text: 'B' };
      return { sessionId: 'fixture-session', name: 'Mica', cancellable: ['turn'], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'turn', inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: 'turn', anchorSequence: 1, anchorCreated: 1, sourceIds: ['a'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 }, { kind: 'text', itemId: id, text: 'B', textState: 'streaming', position: 1 },
        ] }] };
    },
    async chatReceipt() { streaming = undefined; return { state: 'submitted' }; },
    streamingReply() { return streaming; }, replyCompletion() { return undefined; },
  } as unknown as Partner;
  await assert.rejects(createCodexChatBackend(partner).read(), /chat projection.*changed/i);
  assert.equal(snapshots, 3);
});

test('a session change during receipt lookup cannot return the old session preview', async () => {
  let session = 'old', hold = true;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      const current = session;
      return { sessionId: current, name: 'Mica', cancellable: [current], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: `a-${current}`, input: current, sequence: 1, created: 1, turnId: current, inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: current, anchorSequence: 1, anchorCreated: 1, sourceIds: [`a-${current}`], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: [`a-${current}`], position: 0 }, { kind: 'text', itemId: 'b', text: current, textState: 'streaming', position: 1 },
        ] }] };
    },
    async chatReceipt() { if (hold) { entered(); await gate; } return { state: 'submitted' }; },
    streamingReply() { return { id: 'b', turnId: session, text: session }; }, replyCompletion() { return undefined; },
  } as unknown as Partner;
  const pending = createCodexChatBackend(partner).read();
  await reading;
  session = 'new'; hold = false; release();
  const view = await pending;
  assert.equal(view.sessionId, 'new');
  assert.deepEqual(view.messages.map(message => [message.id, message.text]), [['a-new', 'new'], ['b', 'new']]);
});

for (const steer of [false, true]) test(`a ${steer ? 'steer' : 'new turn'} starting during receipt lookup is read with its source`, async () => {
  let started = false, hold = false;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      const turn = steer ? 'old' : 'new';
      return structuredClone({ sessionId: 'session', name: 'Mica', cancellable: [started ? turn : 'old'], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'old', inputImages: [], delivery: 'submitted' },
          ...(started ? [{ id: 'c', input: 'C', sequence: 2, created: 2, turnId: turn, inputImages: [], delivery: 'submitted' }] : [])],
        results: [{ id: 'old-result', turnId: 'old', anchorSequence: 1, anchorCreated: 1, sourceIds: steer && started ? ['a', 'c'] : ['a'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 },
          ...(steer && started ? [{ kind: 'user', sourceIds: ['c'], position: 1 }, { kind: 'text', itemId: 'b', text: 'B', textState: 'streaming', position: 2 }] : []),
        ] }, ...(!steer && started ? [{ id: 'new-result', turnId: 'new', anchorSequence: 2, anchorCreated: 2, sourceIds: ['c'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['c'], position: 0 }, { kind: 'text', itemId: 'b', text: 'B', textState: 'streaming', position: 1 },
        ] }] : [])] });
    },
    async chatReceipt() { if (hold) { entered(); await gate; } return { state: 'submitted' }; },
    streamingReply() { return started ? { id: 'b', turnId: steer ? 'old' : 'new', text: 'B' } : undefined; }, replyCompletion() { return undefined; },
  } as unknown as Partner;
  const backend = createCodexChatBackend(partner);
  hold = true;
  const pending = backend.read();
  await reading;
  started = true; hold = false; release();
  const view = await pending;
  assert.equal(view.activeTurnId, steer ? 'old' : 'new');
  assert.deepEqual(view.messages.map(message => message.id), ['a', 'c', 'b']);
  assert.equal(view.streamingReply, undefined);
});

test('stream text growth during receipt lookup does not rescan history', async () => {
  let text = 'B', snapshots = 0, entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      snapshots++;
      return { sessionId: 'session', name: 'Mica', cancellable: ['turn'], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'turn', inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: 'turn', anchorSequence: 1, anchorCreated: 1, sourceIds: ['a'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 }, { kind: 'text', itemId: 'b', text, textState: 'streaming', position: 1 },
        ] }] };
    },
    async chatReceipt() { entered(); await gate; return { state: 'submitted' }; },
    streamingReply() { return { id: 'b', turnId: 'turn', text }; }, replyCompletion() { return undefined; },
  } as unknown as Partner;
  const pending = createCodexChatBackend(partner).read();
  await reading;
  text = 'B extended'; release();
  const view = await pending;
  assert.equal(snapshots, 1);
  assert.equal(view.messages[1]?.text, 'B extended');
});

test('single-view host disconnects after an exhausted inconsistent invalidation', { timeout: 5000 }, async () => {
  let unstable = false;
  let notify!: () => void;
  const partner = {
    async sharedRecovery() { return []; }, async sharedImageLimits() { return false; }, async sharedFileLimits() { return false; },
    async snapshot() {
      return { sessionId: 'session', name: 'Mica', cancellable: [], context: null, lifecycle: { latest: null }, hasMore: false, before: null,
        messages: [{ id: 'a', input: 'A', sequence: 1, created: 1, turnId: 'turn', inputImages: [], delivery: 'submitted' }],
        results: [{ id: 'result', turnId: 'turn', anchorSequence: 1, anchorCreated: 1, sourceIds: ['a'], chatStatus: 'running', timeline: [
          { kind: 'user', sourceIds: ['a'], position: 0 }, ...(unstable ? [{ kind: 'text', itemId: 'b', text: 'obsolete', textState: 'streaming', position: 1 }] : []),
        ] }] };
    },
    async chatReceipt() { return { state: 'submitted' }; },
    streamingReply() { return undefined; }, replyCompletion() { return undefined; },
    subscribeChat(listener: (event: { type: 'change' }) => void) { notify = () => listener({ type: 'change' }); return () => {}; },
  } as unknown as Partner;
  const backend = createCodexChatBackend(partner);
  let observedError!: () => void;
  const error = new Promise<void>(resolve => { observedError = resolve; });
  const host = await createChatHost(backend, () => observedError());
  let closeCode: number | undefined;
  const socket = { send() {}, close(code?: number) { closeCode = code; }, bufferedAmount: 0 };
  host.connect(socket, async () => true);
  try {
    unstable = true;
    notify();
    await error;
    assert.equal(closeCode, 1012);
    await assert.rejects(createChatHost(createCodexChatBackend(partner), () => {}), /chat projection.*changed/i);
    unstable = false;
    const fresh = createCodexChatBackend(partner);
    const recovered = await createChatHost(fresh, () => {});
    try { assert.deepEqual((await fresh.read()).messages.map(message => message.id), ['a']); }
    finally { recovered.close(); }
  } finally { host.close(); }
});
