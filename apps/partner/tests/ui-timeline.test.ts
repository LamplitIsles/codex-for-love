import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { visibleHistoryPage } from '../runtime/partner.ts';
import { fixture, eventually } from './fixture.ts';

// This seam tests host projection, not the unreleased App's A2UI validation.
const bound = (value: unknown) => value === null ? {} : structuredClone(value);
const surface = (label: string) => ({ version: '1.0', label });
const uiItem = (id: string, ui: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'mcpToolCall', id, server: 'companion', tool: 'send_ui', status: 'completed', error: null,
  arguments: { secret: 'PRIVATE_ARGUMENT' },
  result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'ui', ui }) }], structuredContent: { private: 'PRIVATE_RESULT' } }, ...extra,
});
const uiId = (turn: string, id: string) => `ui:${createHash('sha256').update(JSON.stringify([turn, id])).digest('hex')}`;
const uiValue = (message: unknown) => (message as { ui?: unknown }).ui;

async function allMessages(backend: ReturnType<typeof createCodexChatBackend>) {
  const view = await backend.read(); let messages = [...view.messages], before = view.before;
  while (before) { const page = await backend.history(before); assert.ok(page.messages.length <= 30); messages = [...page.messages, ...messages]; before = page.before; }
  return messages;
}

test('native window counts each UI when choosing its page boundary', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: `input-${i}`, sequence: i + 1, revision: i + 1, created: i + 1 }));
  const results = [{ turnId: 'turn', sourceIds: ['input-19'], sequence: 20, revision: 20, answers: [], error: null, status: 'completed', generatedIds: [], voiceDispatches: [], uiDispatches: Array.from({ length: 45 }, (_, i) => ({ itemId: `ui-${i}`, ui: {} })) }];
  const page = visibleHistoryPage(messages, results);
  assert.equal(page.messages.length, 5);
  assert.equal(page.before, 16);
  assert.equal(page.hasMore, true);
});

test('fake native history projects ordered independent UI through pages and restart', async () => {
  const f = await fixture();
  const turnId = 'mixed-turn';
  const mixed = { id: turnId, status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'human', clientId: 'input', content: [{ type: 'text', text: 'input' }] },
    { type: 'agentMessage', id: 'text-before', text: 'before', phase: 'commentary' },
    uiItem('ui-first', surface('one')), uiItem('ui-bad', null),
    uiItem('ui-oversized', null, { result: { content: [{ type: 'text', text: 'PRIVATE_OVERSIZED'.repeat(9000) }] } }),
    uiItem('failed', surface('failed'), { status: 'failed' }),
    uiItem('pending', surface('pending'), { status: 'inProgress' }),
    uiItem('duplicate', surface('duplicate')), uiItem('duplicate', surface('duplicate')),
    { type: 'mcpToolCall', id: 'voice', server: 'companion', tool: 'send_voice', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'voice', audioId: 'a'.repeat(64) }) }] } },
    ...Array.from({ length: 35 }, (_, i) => uiItem(`ui-many-${i}`, surface(`many-${i}`))),
    uiItem('ui-last', surface('three')),
    { type: 'agentMessage', id: 'text-after', text: 'after', phase: 'final_answer' },
  ] };
  const turns = [mixed, ...Array.from({ length: 40 }, (_, i) => ({ id: `later-${i}`, status: 'completed', startedAt: 1700000001 + i, items: [
    { type: 'userMessage', id: `user-${i}`, clientId: `input-${i}`, content: [{ type: 'text', text: `input ${i}` }] },
    { type: 'agentMessage', id: `answer-${i}`, text: `answer ${i}`, phase: 'final_answer' },
  ] }))];
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, turns }));
  try {
    let previous: unknown;
    let retained: { cursor: string; page: unknown } | undefined;
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner({ uiPayloadBound: bound });
      const backend = createCodexChatBackend(partner);
      const initial = await backend.read();
      assert.ok(initial.before);
      if (retained) assert.deepEqual(await backend.history(retained.cursor), retained.page);
      else retained = { cursor: initial.before, page: await backend.history(initial.before) };
      const messages = await allMessages(backend), mixedMessages = messages.filter(message => message.turnId === turnId);
      assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
      assert.deepEqual(mixedMessages.map(message => message.id), ['input', 'text-before', uiId(turnId, 'ui-first'), uiId(turnId, 'ui-bad'), uiId(turnId, 'ui-oversized'), mixedMessages[5]!.id, ...Array.from({ length: 35 }, (_, i) => uiId(turnId, `ui-many-${i}`)), uiId(turnId, 'ui-last'), 'text-after']);
      assert.ok(mixedMessages[5]!.voice);
      assert.deepEqual(mixedMessages.filter(message => Object.hasOwn(message, 'ui')).map(uiValue), [surface('one'), {}, {}, ...Array.from({ length: 35 }, (_, i) => surface(`many-${i}`)), surface('three')]);
      for (const message of mixedMessages.filter(message => Object.hasOwn(message, 'ui'))) {
        assert.equal(message.role, 'agent'); assert.equal(message.text, '');
        for (const key of ['images', 'files', 'voice', 'source', 'imageState', 'textState', 'ends']) assert.equal(Object.hasOwn(message, key), false);
      }
      assert.equal(JSON.stringify(messages).includes('PRIVATE_'), false);
      if (previous) assert.deepEqual(messages, previous);
      previous = messages;
      await partner.close();
    }
    // The published boundary is now present; malformed UI remains isolated.
    const partner = await f.createPartner();
    const messages = await allMessages(createCodexChatBackend(partner));
    assert.equal(messages.filter(message => Object.hasOwn(message, 'ui')).length, 39);
    assert.deepEqual((messages.find(message => message.id === uiId(turnId, 'ui-oversized')) as { ui?: unknown })?.ui, {});
    assert.ok(messages.some(message => message.id === 'text-after'));
    await partner.close();
  } finally { await f.close(); }
});

test('fake live completion invalidates the view and preserves missed-start UI before a later steer', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  let partner = await f.createPartner({ uiPayloadBound: bound });
  let backend = createCodexChatBackend(partner);
  const updates: unknown[] = [];
  try {
    const subscription = backend.subscribe(change => updates.push(change));
    await backend.read();
    const first = crypto.randomUUID(); await partner.submit(first, 'input');
    await eventually(async () => !!(await f.nativeState()).active);
    const native = await f.nativeState(), turnId = native.active as string;
    const started = uiItem('started-ui', surface('started'));
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/started', item: { ...started, status: 'inProgress', result: null } }] });
    await eventually(async () => (await partner.snapshot()).results.some(result => result.timeline.some(slot => slot.itemId === 'started-ui')));
    assert.equal((await backend.read()).messages.some(message => Object.hasOwn(message, 'ui')), false);
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: started }, { method: 'item/completed', item: uiItem('missed-ui', surface('missed')) }] });
    await eventually(async () => (await backend.read()).messages.filter(message => Object.hasOwn(message, 'ui')).length === 2);
    await eventually(async () => updates.some(change => JSON.stringify(change).includes(uiId(turnId, 'missed-ui'))));
    const revision = (await partner.snapshot()).results.find(result => result.turnId === turnId)!.revision;
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: uiItem('missed-ui', surface('revised')) }] });
    await eventually(async () => (await partner.snapshot()).results.some(result => result.turnId === turnId && result.revision > revision));
    const revised = (await backend.read()).messages.filter(message => message.id === uiId(turnId, 'missed-ui'));
    assert.equal(revised.length, 1); assert.deepEqual(uiValue(revised[0]), surface('revised'));
    const steer = crypto.randomUUID(); await partner.submitNativeDelivery({ operationId: steer, text: 'steer' });
    await eventually(async () => await f.consumed(steer));
    await eventually(async () => (await partner.snapshot()).results.some(result => result.sourceIds.includes(steer)));
    const live = await allMessages(backend);
    const relevant = live.filter(message => message.id === first || message.id === steer || Object.hasOwn(message, 'ui')).map(message => message.id);
    assert.deepEqual(relevant, [first, uiId(turnId, 'started-ui'), uiId(turnId, 'missed-ui'), steer]);
    subscription.close(); await partner.close();
    partner = await f.createPartner({ uiPayloadBound: bound }); backend = createCodexChatBackend(partner);
    const restored = await allMessages(backend);
    assert.deepEqual(restored.filter(message => relevant.includes(message.id)).map(message => message.id), relevant);
  } finally { await partner.close(); await f.close(); }
});
