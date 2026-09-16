import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { rollDice } from '../runtime/tools/dice-core.ts';

test('event stream exposes liveness while a disconnected view does not cancel a turn', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'), { heartbeatMs: 5 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await f.holdProvider(true); await partner.submit(randomUUID(), 'keep working');
    await eventually(async () => (await partner.snapshot()).typing);
    const response = await fetch(`${url}/api/events`); const reader = response.body!.getReader();
    let text = ''; while (!text.includes('event: heartbeat')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.equal((await partner.snapshot()).typing, true);
    const snapshot = await (await fetch(`${url}/api/session`)).json() as { typing: boolean };
    assert.equal(snapshot.typing, true);
  } finally { await app.close(); await f.close(); }
});


test('native image creation and editing persist assistant attachments through refresh', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const firstId = randomUUID(); await partner.submit(firstId, 'generate image of a quiet room');
    await eventually(async () => (await partner.snapshot()).results?.[0]?.images.length === 1);
    let view = await partner.snapshot();
    const first = view.results?.[0]?.images[0]!;
    assert.equal(first.name.startsWith('image-image-item-'), true);
    const firstResponse = await fetch(`${url}${first.url}`);
    assert.equal(firstResponse.headers.get('content-type'), 'image/png');
    assert.equal((await firstResponse.arrayBuffer()).byteLength > 0, true);
    const attachmentRoot = partnerPaths(f.workspace).attachments;
    assert.match((await readFile(join(attachmentRoot, `${first.id}.png`))).toString('base64'), /^iVBOR/);
    assert.doesNotMatch(JSON.stringify(view.messages[0]), /base64/);

    const secondId = randomUUID(); await partner.submit(secondId, 'edit image with a candle');
    await eventually(async () => (await partner.snapshot()).results?.[1]?.images.length === 1);
    view = await partner.snapshot();
    assert.equal(view.results?.[0]?.images.length, 1);
    assert.equal(view.results?.[1]?.images.length, 1);
    assert.notEqual(view.results?.[1]?.images[0]?.id, first.id);
    await partner.close();
    const reopened = await f.createPartner();
    const restored = await reopened.snapshot();
    assert.equal(restored.results?.[0]?.images.length, 1);
    assert.equal(restored.results?.[1]?.images.length, 1);
  } finally { await app.close(); await f.close(); }
});

test('event projection and restart reuse saved generated attachments without old-history reads', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  try {
    const firstId = randomUUID();
    await partner.submit(firstId, 'generate image of a quiet room');
    await eventually(async () => (await partner.snapshot()).results?.[0]?.images.length === 1);
    const first = (await partner.snapshot()).results?.[0]?.images[0]!;
    const initialRequests = await f.requests();
    const initialTurnPages = initialRequests.filter((request) => request.method === 'thread/turns/list').length;
    const initialFullTurns = initialRequests.filter((request) => request.method === 'thread/turns/list' && (request.params as { itemsView?: string } | undefined)?.itemsView === 'full').length;
    const initialItemPages = initialRequests.filter((request) => request.method === 'thread/items/list').length;

    const followupId = randomUUID();
    await partner.submit(followupId, 'follow-up text after the image');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(followupId) && result.answers.length > 0) === true);
    await partner.snapshot();
    await partner.snapshot();
    const afterEvents = await f.requests();
    assert.equal(afterEvents.filter((request) => request.method === 'thread/turns/list').length, initialTurnPages);
    assert.equal(afterEvents.filter((request) => request.method === 'thread/turns/list' && (request.params as { itemsView?: string } | undefined)?.itemsView === 'full').length, initialFullTurns);
    assert.equal(afterEvents.filter((request) => request.method === 'thread/items/list').length, initialItemPages);
    assert.match((await partner.snapshot()).results?.find((result) => result.sourceIds.includes(followupId))?.answers.join('\n\n') ?? '', /^fixture reply/);

    for (const name of await readdir(join(f.directory, 'native-images'))) await unlink(join(f.directory, 'native-images', name));
    await partner.close();
    partner = await f.createPartner();
    const restored = await partner.snapshot();
    assert.equal(restored.storageError, false);
    assert.equal(restored.results?.find((result) => result.sourceIds.includes(firstId))?.images[0]?.id, first.id);
    const restoredImage = await partner.image(first.id);
    assert.ok(restoredImage && restoredImage.data.byteLength > 0);
    const afterRestart = await f.requests();
    assert.equal(afterRestart.filter((request) => request.method === 'thread/items/list').length, initialItemPages);
    assert.equal(afterRestart.filter((request) => request.method === 'thread/turns/list').length, initialTurnPages + 1);
    assert.equal(afterRestart.filter((request) => request.method === 'thread/turns/list' && (request.params as { itemsView?: string } | undefined)?.itemsView === 'full').length, initialFullTurns + 1);
  } finally { await partner.close(); await f.close(); }
});


test('dice validation happens before random drawing', () => {
  assert.deepEqual(rollDice({ count: 2, sides: 6, modifier: -1, label: '判断' }, () => 4),
    { count: 2, sides: 6, rolls: [4, 4], modifier: -1, total: 7, label: '判断' });
  assert.throws(() => rollDice({ sides: 6, count: 0 }, () => { throw new Error('should not draw'); }), /count/);
});
