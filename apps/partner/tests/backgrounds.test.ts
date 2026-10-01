import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');

test('configured backgrounds are served as decoration outside the image catalogue', async () => {
  const f = await fixture();
  try {
    const landscape = join(f.workspace, 'wide.png'), portrait = join(f.workspace, 'tall.png');
    await writeFile(landscape, png); await writeFile(portrait, png);
    f.config.backgrounds = { landscape, portrait };
    const partner = await f.createPartner();
    const app = createWebServer(partner, join(f.directory, 'assets'));
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try {
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      assert.deepEqual((await partner.snapshot()).backgrounds, { landscape: '/api/backgrounds/landscape', portrait: '/api/backgrounds/portrait' });
      for (const kind of ['landscape', 'portrait']) {
        const response = await fetch(`${base}/api/backgrounds/${kind}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
      }
      assert.equal((await fetch(`${base}/api/backgrounds/unknown`)).status, 400);
      assert.equal((await partner.conversationImages({})).images.length, 0);
    } finally { await app.close(); }
  } finally { await f.close(); }
});

test('unconfigured background routes return 404; invalid configured files reject startup', async () => {
  const f = await fixture();
  try {
    const partner = await f.createPartner();
    assert.equal((await partner.snapshot()).backgrounds, undefined);
    const app = createWebServer(partner, join(f.directory, 'assets'));
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try {
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      assert.equal((await fetch(`${base}/api/backgrounds/portrait`)).status, 404);
    } finally { await app.close(); }
    const landscape = join(f.workspace, 'wide.png'), portrait = join(f.workspace, 'tall.png');
    await writeFile(landscape, png); await writeFile(portrait, png);
    f.config.backgrounds = { landscape: join(f.directory, 'outside.png'), portrait };
    await assert.rejects(f.createPartner(), /inside the workspace/);
    f.config.backgrounds.landscape = join(f.workspace, 'missing.png');
    await assert.rejects(f.createPartner(), /ENOENT/);
    f.config.backgrounds.landscape = landscape;
    await writeFile(landscape, Buffer.alloc(0));
    await assert.rejects(f.createPartner(), /Background file size/);
    await writeFile(landscape, Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(f.createPartner(), /Background file size/);
  } finally { await f.close(); }
});
