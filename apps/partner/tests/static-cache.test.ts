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
