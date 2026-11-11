import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { fixtureImage } from './panels-seed.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';

for (const [started, merged] of [[true, false], [false, false], [false, true]] as const) test(`completed image remains before a later native-consumed steer (started=${started}, merged=${merged})`, { timeout: 25_000 }, async t => {
  const f = await fixture();
  f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const sourceIds = merged ? [crypto.randomUUID(), crypto.randomUUID()] : [crypto.randomUUID()];
  if (merged) {
    const paths = partnerPaths(f.workspace);
    await mkdir(paths.managedRoot, { recursive: true });
    const store = new Store(paths.database);
    try {
      for (const [index, id] of sourceIds.entries()) await store.admit(id, `initial input ${index}`);
      await store.recordTimelineSlot('thread-fake', 'merged-turn', 'merged-user', 'user');
    } finally { await store.close(); }
    const turn = { id: 'merged-turn', status: 'inProgress', itemsView: 'full', startedAt: 1700000000, items: [
      { type: 'userMessage', id: 'merged-user', clientId: `merged:${sourceIds.join(',')}`, content: [{ type: 'text', text: 'initial input 0\ninitial input 1' }] },
    ] };
    await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, active: turn.id, turns: [turn] }));
  }
  let partner = await f.createPartner();
  try {
    if (!merged) await partner.submit(sourceIds[0]!, 'initial input');
    await eventually(async () => !!(await f.nativeState()).active);
    const backend = createCodexChatBackend(partner);
    const image = { type: 'imageGeneration', id: 'missed-start-image', status: 'completed', revisedPrompt: 'fixture', result: fixtureImage.toString('base64'), failure: null, savedPath: null };
    if (started) {
      await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/started', item: { ...image, status: 'in_progress', result: '' } }] });
      await eventually(async () => (await partner.snapshot()).results.some(r => r.timeline.some(slot => slot.itemId === image.id)));
      assert.equal((await backend.read()).messages.some(m => m.imageState), false);
    }
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: image }] });
    await eventually(async () => (await backend.read()).messages.some(m => m.imageState === 'ready'));
    const before = (await backend.read()).messages;
    const imageId = before.find(m => m.imageState === 'ready')!.id;
    assert.deepEqual(before.map(m => m.id), [...sourceIds, imageId]);

    const steerId = crypto.randomUUID();
    const receipt = await partner.submitNativeDelivery({ operationId: steerId, text: 'steer after completed image' });
    await eventually(async () => (await partner.lookupNativeDelivery(steerId))?.state === 'submitted');
    await eventually(async () => await f.consumed(steerId));
    await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(steerId)));
    const live = (await backend.read()).messages.map(m => m.id);
    const native = await f.nativeState();
    const turn = native.turns.find((value: { id: string }) => value.id === native.active);
    const nativeOrder = turn.items
      .filter((item: { id?: string; clientId?: string }) => item.id === image.id || item.clientId === steerId)
      .map((item: { id?: string; clientId?: string }) => item.clientId ?? item.id);
    await partner.close();
    partner = await f.createPartner();
    const restored = (await createCodexChatBackend(partner).read()).messages.map(m => m.id);
    t.diagnostic(JSON.stringify({ before: before.map(m => m.id), nativeOrder, live, restored, expected: [...sourceIds, imageId, steerId] }));
    assert.deepEqual(nativeOrder, [image.id, steerId], 'the fake records the completed image before consuming the steer');
    assert.deepEqual(restored, live, 'restarting Partner preserves the same visible order');
    assert.deepEqual(live, [...sourceIds, imageId, steerId], 'a previously visible completed image keeps its position');
  } finally {
    await partner.close();
    await f.close();
  }
});

test('a missing slot between common anchors keeps the existing fallback order', async () => {
  const f = await fixture();
  const paths = partnerPaths(f.workspace);
  await mkdir(paths.managedRoot, { recursive: true });
  const store = new Store(paths.database);
  try {
    await store.admit('first', 'first');
    await store.admit('steer', 'steer');
    for (const [id, kind] of [['native-first', 'user'], ['absent-slot', 'image'], ['native-steer', 'user']] as const) {
      await store.recordTimelineSlot('thread-fake', 'fallback-turn', id, kind);
    }
  } finally { await store.close(); }
  const savedPath = join(f.directory, 'image.png');
  await writeFile(savedPath, fixtureImage);
  const turn = { id: 'fallback-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'native-first', clientId: 'first', content: [{ type: 'text', text: 'first' }] },
    { type: 'imageGeneration', id: 'unrecorded-image', status: 'completed', savedPath, result: '' },
    { type: 'userMessage', id: 'native-steer', clientId: 'steer', content: [{ type: 'text', text: 'steer' }] },
  ] };
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, turns: [turn] }));
  const partner = await f.createPartner();
  try {
    const messages = (await createCodexChatBackend(partner).read()).messages;
    const image = messages.find(message => message.imageState === 'ready');
    assert.ok(image);
    assert.deepEqual(messages.map(message => message.id), ['first', 'steer', image.id]);
  } finally { await partner.close(); await f.close(); }
});
