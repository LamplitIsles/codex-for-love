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
    for (const path of ['/slice', '/slice/', '/slice/manifest.webmanifest', '/management', '/a2ui.html', '/missing.js', '/assets/missing.js'])
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

test('an explicitly provided A2UI entry and its hashed asset are served without a fallback', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'partner-a2ui-static-'));
  let app: ReturnType<typeof createWebServer> | undefined;
  const assetPath = '/assets/a2ui-12345678.js';
  const html = `<!doctype html><title>Test A2UI entry</title><script type="module" src="${assetPath}"></script>`;
  const script = 'export const fixture = "test-owned";';
  try {
    await mkdir(join(assets, 'assets'));
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>Different index</title>');
    await writeFile(join(assets, 'a2ui.html'), html);
    await writeFile(join(assets, 'assets', 'a2ui-12345678.js'), script);
    app = createWebServer({ close: async () => {} } as Partner, assets);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const entry = await fetch(`${url}/a2ui.html`);
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get('content-type') ?? '', /^text\/html(?:;|$)/iu);
    assert.equal(entry.headers.get('cache-control'), 'no-cache');
    assert.equal(await entry.text(), html);
    const asset = await fetch(`${url}${assetPath}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await asset.text(), script);
    for (const path of ['/missing-a2ui.html', '/assets/a2ui-missing123.js'])
      assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  } finally { await app?.close(); await rm(assets, { recursive: true, force: true }); }
});

test('synthetic auth status follows default and async owner authorization', async () => {
  for (const custom of [false,true]) {
    const assets = await mkdtemp(join(tmpdir(),'partner-auth-status-'));
    const app = createWebServer({close:async()=>{}} as Partner,assets,custom ? {
      authorize:async request => request.headers.cookie === 'fixture-owner=1',
    } : {});
    app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
    const base = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
    try {
      for (const signedIn of [false,true]) {
        const response = await fetch(`${base}/api/auth/status`,{headers:signedIn ? {cookie:'fixture-owner=1'} : {}});
        assert.equal(response.status,200);
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.deepEqual(await response.json(),{mode:'passkey',state:!custom || signedIn ? 'signed_in' : 'signed_out'});
      }
      assert.equal((await fetch(`${base}/api/auth/status`,{method:'POST'})).status,405);
    } finally { await app.close(); await rm(assets,{recursive:true,force:true}); }
  }
});
