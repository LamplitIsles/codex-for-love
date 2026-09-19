import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';

test('accepted compaction never reports failure while native completion is still pending', async (t) => {
  const f = await fixture();
  f.appServer.env.FAKE_COMPACT_DELAY_MS = '500';
  const partner = await f.createPartner();
  const app = createWebServer(partner, f.directory);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const originalTimeout = globalThis.setTimeout;
  // Advance the application deadline without waiting a minute or changing native execution.
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => originalTimeout(callback, delay === 60_000 ? 100 : delay, ...args));
  try {
    const response = await fetch(`${base}/api/compact`, { method: 'POST' });
    const atResponse = (await partner.snapshot()).lifecycle.latest?.status;
    const repeated = await fetch(`${base}/api/compact`, { method: 'POST' });
    await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === 'complete');
    assert.equal(response.ok, true, `HTTP ${response.status}, lifecycle ${atResponse}, then complete`);
    assert.equal(response.status, 202);
    assert.equal(atResponse, 'running');
    assert.equal(repeated.ok, false, 'a second compact is rejected while native execution is active');
  } finally {
    t.mock.restoreAll();
    await app.close();
    await f.close();
  }
});

for (const status of ['failed', 'interrupted']) {
  test(`native ${status} compaction remains failed without a successful boundary`, async () => {
    const f = await fixture();
    f.appServer.env.FAKE_COMPACT_DELAY_MS = '100';
    f.appServer.env.FAKE_COMPACT_STATUS = status;
    try {
      const partner = await f.createPartner();
      await partner.compact();
      await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === 'failed');
      assert.equal((await partner.snapshot()).compactions.length, 0);
    } finally { await f.close(); }
  });
}

for (const beforeStarted of [false, true]) for (const stop of [false, true]) {
  test(`messages queued ${beforeStarted ? 'before compact started notification' : 'during compact'} ${stop ? 'return to an editable draft on stop' : 'continue in order after completion'}`, async () => {
    const f = await fixture();
    f.appServer.env.FAKE_REJECT_STEER = 'true';
    f.appServer.env.FAKE_REJECT_STEER_KIND = 'compact';
    const ids = [randomUUID(), randomUUID()];
    const photo = { type: 'image' as const, mediaType: 'image/png' as const, name: 'queued.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=' };
    try {
      await f.holdCompaction(true, beforeStarted);
      const partner = await f.createPartner();
      await partner.compact();
      if (beforeStarted) assert.deepEqual((await partner.snapshot()).cancellable, []);
      else await eventually(async () => (await partner.snapshot()).cancellable.length === 1);
      await partner.submit(ids[0]!, 'first queued text');
      await partner.submit(ids[1]!, '', [photo]);
      assert.deepEqual((await partner.snapshot()).messages.map(message => message.delivery), ['queued', 'queued']);
      if (beforeStarted) {
        assert.equal((await f.requests()).some(request => request.method === 'turn/start' || request.method === 'turn/steer'), false);
        await f.holdCompaction(true);
        await eventually(async () => (await partner.snapshot()).cancellable.length === 1);
      }
      if (stop) {
        await partner.cancel((await partner.snapshot()).cancellable[0]!);
        const view = await partner.snapshot();
        assert.equal(view.lifecycle.latest?.status, 'failed');
        assert.deepEqual(view.draft?.sourceIds, ids);
        assert.equal(view.draft?.input, 'first queued text\n');
        assert.equal(view.draft?.images[0]?.name, 'queued.png');
        assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0);
      } else {
        await f.holdCompaction(false);
        await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === 'complete');
        assert.equal((await partner.snapshot()).messages.some(message => message.delivery === 'unresolved'), false, 'successful compact must not restore queued messages as unresolved drafts');
        await eventually(async () => (await partner.snapshot()).results?.some(result => result.answers.length > 0 && ids.every(id => result.sourceIds.includes(id))) === true);
        const view = await partner.snapshot();
        assert.deepEqual(view.messages.map(message => message.delivery), ['acknowledged', 'acknowledged']);
        assert.equal(view.messages[1]?.inputImages[0]?.name, 'queued.png');
        assert.equal(view.draft, undefined);
        const starts = (await f.requests()).filter(request => request.method === 'turn/start');
        assert.equal(starts.length, 1);
        assert.equal((starts[0]!.params as { clientUserMessageId: string }).clientUserMessageId, `merged:${ids.join(',')}`);
      }
    } finally { await f.close(); }
  });
}
