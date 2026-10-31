import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebServer } from './web-server.ts';
import type { Partner } from '../runtime/partner.ts';

test('only canonical entries serve the document and both revalidate', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'partner-static-cache-'));
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Partner</title>');
  const app = createWebServer({ close: async () => {} } as Partner, assets);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${url}/`)).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${url}/chat`)).headers.get('cache-control'), 'no-cache');
    assert.equal(await (await fetch(`${url}/chat`)).text(), await (await fetch(`${url}/`)).text());
    for (const path of ['/slice', '/slice/', '/slice/manifest.webmanifest', '/management', '/missing.js', '/assets/missing.js'])
      assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  } finally {
    await app.close();
    await rm(assets, { recursive: true, force: true });
  }
});

test('selected frontend static resources use immutable asset caching', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'partner-pwa-'));
  let app: ReturnType<typeof createWebServer> | undefined;
  try {
    await mkdir(join(assets, 'assets'));
    await writeFile(join(assets, 'index.html'), '<!doctype html><script src="/assets/app-12345678.js"></script>');
    await writeFile(join(assets, 'assets/app-12345678.js'), 'console.log("fixture")');
    app = createWebServer({ close: async () => {} } as Partner, assets);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const entry = await fetch(url);
    assert.equal(entry.headers.get('cache-control'), 'no-cache');
    const asset = await fetch(`${url}/assets/app-12345678.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(`${url}/chat`)).headers.get('cache-control'), 'no-cache');
  } finally { await app?.close(); await rm(assets, { recursive: true, force: true }); }
});
