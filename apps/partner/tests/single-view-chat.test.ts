import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { createWebServer } from './web-server.ts';
import { fixture, eventually } from './fixture.ts';
import { fixtureImage } from './panels-seed.ts';

test('single shared view publishes raw reply updates and only materialized images', { timeout: 25_000 }, async () => {
  const f = await fixture();
  f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  let view: ChatView | undefined;
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { view = value; }, () => {});
    const operationId = crypto.randomUUID();
    assert.equal((await client.submit({ operationId, text: 'fixture input' })).state, 'submitted');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'first line\nsecond' });
    await eventually(async () => view?.messages.some(message => message.text === 'first line\nsecond') === true);
    const reply = view!.messages.find(message => message.text === 'first line\nsecond')!;
    assert.equal(reply.textState, 'streaming');
    assert.deepEqual(reply.ends, [11]);
    const image = { type: 'imageGeneration', id: 'pending-picture', status: 'in_progress', revisedPrompt: 'fixture', result: '', failure: null, savedPath: null };
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/started', item: image }] });
    await eventually(async () => (await partner.snapshot()).results.some(result => result.timeline.some(slot => slot.itemId === image.id)));
    const during = await client.history(JSON.stringify({ before: 2 }));
    assert.equal(during.messages.some(message => message.imageState !== undefined), false, 'an unfinished image does not enter history');
    assert.equal(view!.messages.some(message => message.imageState !== undefined), false, 'an unfinished image does not enter the view');
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: { ...image, status: 'completed', result: fixtureImage.toString('base64') } }] });
    await eventually(async () => view?.messages.some(message => message.imageState === 'ready') === true);
    assert.equal(view!.messages.filter(message => message.imageState === 'ready').length, 1);
    assert.equal(view!.messages.find(message => message.id === reply.id)?.text, reply.text);
  } finally {
    client?.close();
    await app.close();
    await f.close();
  }
});
