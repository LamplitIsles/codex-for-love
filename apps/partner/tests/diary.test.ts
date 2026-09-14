import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_DIARY_ENTRY_BYTES } from '../runtime/partner.ts';
import { createWebServer } from '../runtime/server.ts';
import { fixture } from './fixture.ts';

test('diary API exposes only bounded dated workspace entries newest first', async () => {
  const f = await fixture();
  const memory = join(f.workspace, 'memory');
  await mkdir(memory);
  await writeFile(join(memory, '2026-09-12.md'), 'older');
  await writeFile(join(memory, '2026-09-14.md'), 'newer');
  await writeFile(join(memory, 'notes.md'), 'hidden');
  await mkdir(join(memory, '2026-09-13.md'));
  await symlink(join(memory, '2026-09-14.md'), join(memory, '2026-09-11.md'));
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const list = await (await fetch(`${base}/api/diary`)).json() as { entries: string[] };
    assert.deepEqual(list.entries, ['2026-09-14.md', '2026-09-12.md']);
    const entry = await (await fetch(`${base}/api/diary/2026-09-14.md`)).json() as { text: string };
    assert.equal(entry.text, 'newer');
    assert.equal((await fetch(`${base}/api/diary/notes.md`)).status, 404);
    assert.equal((await fetch(`${base}/api/diary/%2e%2e%2fpersona.md`)).status, 404);
    assert.equal((await fetch(`${base}/api/diary/2026-09-11.md`)).status, 404);

    await writeFile(join(memory, '2026-09-10.md'), 'x'.repeat(MAX_DIARY_ENTRY_BYTES));
    assert.equal((await fetch(`${base}/api/diary/2026-09-10.md`)).status, 200);
    await writeFile(join(memory, '2026-09-10.md'), 'x'.repeat(MAX_DIARY_ENTRY_BYTES + 1));
    assert.equal((await fetch(`${base}/api/diary/2026-09-10.md`)).status, 413);
  } finally { await app.close(); await f.close(); }
});

test('missing diary is empty while filesystem failure is an error', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/diary`;
  try {
    assert.deepEqual((await (await fetch(url)).json() as { entries: string[] }).entries, []);
    await rm(join(f.workspace, 'memory'), { recursive: true, force: true });
    await writeFile(join(f.workspace, 'memory'), 'not a directory');
    assert.equal((await fetch(url)).status, 500);
  } finally { await app.close(); await f.close(); }
});
