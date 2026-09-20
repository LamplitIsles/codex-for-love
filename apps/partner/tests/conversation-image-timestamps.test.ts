import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
const photo = { type: 'image' as const, mediaType: 'image/png' as const, name: 'sample.png', data: png };

test('catalogue reconciliation keeps an existing input image at its recorded message time when a turn omits its start time', async () => {
  const f = await fixture();
  try {
    let partner = await f.createPartner();
    const id = randomUUID();
    await partner.submit(id, '', [photo]);
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.status === 'completed') === true);
    const before = await partner.snapshot();
    const message = before.messages.find((value) => value.id === id);
    assert.ok(message);
    await partner.close();

    const statePath = f.appServer.env.FAKE_SERVER_STATE!;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { turns: Array<{ items: Array<{ clientId?: string }>; startedAt: number | null }> };
    const turn = state.turns.find((value) => value.items.some((item) => item.clientId === id));
    assert.ok(turn);
    turn.startedAt = null;
    await writeFile(statePath, JSON.stringify(state));

    const fallbackNow = 2_000_000_000_000;
    partner = await f.createPartner({ now: () => fallbackNow });
    const page = await partner.conversationImages({ limit: 5 });
    assert.equal(page.images.length, 1);
    assert.equal(page.images[0]?.created, message.created);
  } finally { await f.close(); }
});

test('historical media with no recoverable turn time uses the ordered September fallback across restart', async () => {
  const f = await fixture();
  try {
    const historical = join(f.workspace, '.lamplit', 'historical-media', 'imported.png');
    await mkdir(join(f.workspace, '.lamplit', 'historical-media'), { recursive: true });
    await writeFile(historical, Buffer.from(png, 'base64'));
    await writeFile(join(f.workspace, '.lamplit', 'thread.json'), JSON.stringify({ threadId: 'thread-fake', model: f.config.codex.model }));
    await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({
      threadId: 'thread-fake',
      turns: [{
        id: 'turn-historical', status: 'completed', startedAt: null, completedAt: 1_900_000_000,
        items: [{ type: 'userMessage', id: 'historical-user', clientId: 'historical-source', content: [{ type: 'localImage', path: historical }] }],
      }],
    }));

    let partner = await f.createPartner({ now: () => 2_000_000_000_000 });
    const expected = new Date(2026, 8, 1).getTime();
    let page = await partner.conversationImages({ limit: 5 });
    assert.deepEqual(page.images.map(({ origin, created }) => ({ origin, created })), [{ origin: 'historical', created: expected }]);
    await partner.close();

    partner = await f.createPartner({ now: () => 2_100_000_000_000 });
    page = await partner.conversationImages({ limit: 5 });
    assert.deepEqual(page.images.map(({ origin, created }) => ({ origin, created })), [{ origin: 'historical', created: expected }]);
  } finally { await f.close(); }
});
