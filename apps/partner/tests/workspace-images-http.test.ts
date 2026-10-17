import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { WORKSPACE_IMAGE_PATH, workspaceImageUrl } from '@lamplit/contracts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createWebServer } from '../runtime/server.ts';
import { MAX_WORKSPACE_IMAGE_BYTES } from '../runtime/workspace-images.ts';
import { fixture } from './fixture.ts';

test('authenticated native workspace-image HTTP preserves literal paths, current bytes and API boundaries', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async () => authorized });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#cc8844' } }).png().toBuffer();
  const url = (path: string) => `${origin}${WORKSPACE_IMAGE_PATH}?${new URLSearchParams({ path })}`;
  try {
    assert.equal((await createCodexChatBackend(partner).read()).capabilities.workspaceImages, true);
    const initialLibrary = await partner.conversationImages({});
    for (const name of ['relative.png', '图片 space.png', 'literal%20.png', 'literal%2F.png', 'literal%ZZ.png']) {
      await writeFile(join(f.workspace, name), bytes);
      for (const path of [name, join(f.workspace, name)]) {
        // The source URI is decoded by App once; the native query stays literal.
        const sharedUrl = workspaceImageUrl(encodeURI(path));
        assert.ok(sharedUrl);
        const response = await fetch(origin + sharedUrl);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
    }
    assert.deepEqual(await partner.conversationImages({}), initialLibrary);
    const path = 'relative.png';
    authorized = false;
    assert.equal((await fetch(url(path))).status, 401);
    authorized = true;
    assert.equal((await fetch(url(path), { headers: { origin: 'https://other.test' } })).status, 403);
    assert.equal((await fetch(url(path), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(url(path), { method: 'POST' })).status, 405);
    await writeFile(join(f.workspace, path), 'replaced private contents');
    let response = await fetch(url(path));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Workspace image unavailable' });
    await writeFile(join(f.workspace, path), bytes);
    response = await fetch(url(path) + '&retry=1');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await writeFile(join(f.directory, 'private.png'), bytes);
    await symlink(join(f.directory, 'private.png'), join(f.workspace, 'escape.png'));
    await symlink(f.directory, join(f.workspace, 'escape-dir'));
    await mkdir(join(f.workspace, 'directory.png'));
    await writeFile(join(f.workspace, 'invalid.png'), 'private invalid data');
    const huge = await open(join(f.workspace, 'huge.png'), 'w');
    try { await huge.truncate(MAX_WORKSPACE_IMAGE_BYTES + 1); } finally { await huge.close(); }
    for (const invalid of ['', '../private.png', join(f.directory, 'private.png'), 'escape.png', 'escape-dir/private.png',
      'directory.png', 'invalid.png', 'huge.png', 'missing.png', 'file:/private.png', 'x\\y.png', 'x\0.png']) {
      const denied = await fetch(url(invalid));
      assert.equal(denied.status, 404, invalid);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await denied.json(), { error: 'Workspace image unavailable' });
    }
    assert.equal((await fetch(origin + WORKSPACE_IMAGE_PATH)).status, 404);
  } finally { await app.close(); await f.close(); }
});
