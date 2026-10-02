import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';

test('SPA fallback documents revalidate like the root document', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'partner-static-cache-'));
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Partner</title>');
  const app = createWebServer({ close: async () => {} } as Partner, assets);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${url}/`)).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${url}/chat`)).headers.get('cache-control'), 'no-cache');
  } finally {
    await app.close();
    await rm(assets, { recursive: true, force: true });
  }
});

test('built PWA entry, manifest and real icons are served without changing document caching', async () => {
  const { cp } = await import('node:fs/promises');
  const { default: sharp } = await import('sharp');
  const assets = await mkdtemp(join(tmpdir(), 'partner-pwa-'));
  let app: ReturnType<typeof createWebServer> | undefined;
  try {
    await cp(process.env.CFL_TEST_BUILD_DIR ?? new URL('../build/', import.meta.url), assets, { recursive: true });
    app = createWebServer({ close: async () => {} } as Partner, assets);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const entry = await fetch(url);
    assert.equal(entry.headers.get('cache-control'), 'no-cache');
    const html = await entry.text();
    assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/u);
    assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png"/u);
    const response = await fetch(`${url}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /application\/manifest\+json/u);
    const manifest = await response.json();
    assert.deepEqual([manifest.id, manifest.scope, manifest.start_url, manifest.display, manifest.name, manifest.short_name], ['/', '/', '/', 'standalone', 'Codex for Love', 'CFL']);
    for (const [src, size] of [...manifest.icons.map((icon: { src: string; sizes: string; type: string }) => {
      assert.equal(icon.type, 'image/png');
      return [icon.src, Number(icon.sizes.split('x')[0])];
    }), ['/icons/apple-touch-icon.png', 180]]) {
      const icon = await fetch(`${url}${src}`);
      assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png');
      const metadata = await sharp(Buffer.from(await icon.arrayBuffer())).metadata();
      assert.equal(metadata.width, size); assert.equal(metadata.height, size); assert.equal(metadata.format, 'png');
    }
    assert.deepEqual(manifest.icons.map((icon: { sizes: string }) => icon.sizes), ['192x192', '512x512']);
    const asset = html.match(/(?:href|src)="([^" ]*\/assets\/[^" ]+\.js)"/u)![1];
    assert.equal((await fetch(new URL(asset, url))).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(`${url}/chat`)).headers.get('cache-control'), 'no-cache');
  } finally { await app?.close(); await rm(assets, { recursive: true, force: true }); }
});
