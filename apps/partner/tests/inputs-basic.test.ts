import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../runtime/server.ts';
import { fixture, eventually } from './fixture.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
const photo = { type: 'image' as const, mediaType: 'image/png' as const, name: 'sample.png', data: png };

test('native localImage input is admitted once, keeps visible text clean, and survives refresh', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const id = randomUUID();
  try {
    const response = await fetch(`${url}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, input: '', images: [photo] }) });
    assert.equal(response.status, 202);
    await eventually(async () => ((await partner.snapshot()).results?.[0]?.answers.length ?? 0) > 0);
    const view = await partner.snapshot();
    assert.equal(view.messages[0]?.input, '');
    assert.equal(view.messages[0]?.inputImages.length, 1);
    const image = view.messages[0]!.inputImages[0]!;
    const path = join(partnerPaths(f.workspace).attachments, `${image.id}.png`);
    assert.equal((await readFile(path)).toString('base64'), png);
    assert.equal((await fetch(`${url}${image.url}`)).headers.get('content-type'), 'image/png');
    const requests = await f.requests();
    assert.match(JSON.stringify(requests), /localImage/);
    assert.doesNotMatch(JSON.stringify(requests), /data:image/);
    assert.doesNotMatch(JSON.stringify(view.messages), /lamplit-partner-test.*attachments/);
    assert.equal((await stat(path)).isFile(), true);
    await partner.close();
    const reopened = await f.createPartner();
    const afterRefresh = await reopened.snapshot();
    assert.equal(afterRefresh.messages[0]?.input, '');
    assert.equal(afterRefresh.messages[0]?.inputImages.length, 1);
    assert.match(afterRefresh.results?.[0]?.answers.join('\n\n') ?? '', /^fixture reply/);
  } finally { await app.close(); await f.close(); }
});

test('invalid image bytes are rejected before native turn admission', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    for (const data of [Buffer.from('GIF89a').toString('base64'), 'not-base64!']) {
      const response = await fetch(`${url}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), input: '', images: [{ ...photo, data }] }) });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, 'invalid_message');
    }
    assert.equal((await partner.snapshot()).messages.length, 0);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start' || request.method === 'turn/steer').length, 0);
  } finally { await app.close(); await f.close(); }
});
