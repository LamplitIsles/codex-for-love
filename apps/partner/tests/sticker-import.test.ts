import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readStickerDirectory, readStickerZip } from '../runtime/sticker-import.ts';
import { StickerCatalog } from '../runtime/sticker-catalog.ts';

function zip(entries: Array<{ name: string; data: Buffer; mode?: number; declaredSize?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), crc = crc32(item.data), size = item.declaredSize ?? item.data.length;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(item.data.length, 18); l.writeUInt32LE(size, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(item.data.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(l, name, item.data); central.push(c, name); offset += l.length + name.length + item.data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('directory and ZIP imports share manifest validation and reject unsafe entries atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-import-'));
  const folder = join(root, 'source'); await mkdir(folder);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const manifest = Buffer.from(JSON.stringify({ id: 'pack', name: '包', description: 'desc', stickers: [{ id: 'one', file: 'one.png', name: '一', tags: ['好'] }] }));
  const entries = [{ name: 'manifest.json', data: manifest }, { name: 'one.png', data: png }];
  const catalog = await StickerCatalog.open(root);
  try {
    await writeFile(join(folder, 'manifest.json'), manifest); await writeFile(join(folder, 'one.png'), png);
    const directory = await readStickerDirectory(folder), archive = await readStickerZip(zip(entries));
    assert.deepEqual(directory, archive); await catalog.importPack(archive.manifest, archive.files);
    assert.equal((await catalog.listPacks({ cursor: null, limit: 10 })).packs[0]?.cover.name, '一');
    for (const bad of [zip([...entries, entries[1]!]), zip([...entries, { name: '../escape', data: png }]), zip([entries[0]!, { ...entries[1]!, mode: 0o120777 }]), zip([entries[0]!, { ...entries[1]!, declaredSize: 70_000_000 }])]) await assert.rejects(readStickerZip(bad));
    const badChecksum = zip(entries); const central = badChecksum.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    badChecksum.writeUInt32LE(0, central + 16); await assert.rejects(readStickerZip(badChecksum));
    const wrong = await readStickerZip(zip([entries[0]!, { ...entries[1]!, data: Buffer.from('not a png') }]));
    await assert.rejects(catalog.importPack(wrong.manifest, wrong.files));
    assert.equal((await catalog.listPacks({ cursor: null, limit: 10 })).packs[0]?.cover.name, '一');
    await rm(join(folder, 'one.png')); await symlink(join(root, 'outside'), join(folder, 'one.png'));
    await assert.rejects(readStickerDirectory(folder));
  } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
});

test('authenticated ZIP import, bounded discovery, independent favorites and private media use real host', async () => {
  const { fixture } = await import('./fixture.ts');
  const { createWebServer } = await import('./web-server.ts');
  const f = await fixture(); const partner = await f.createPartner(); let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async request => authorized && request.headers.authorization === 'owner' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const manifest = Buffer.from(JSON.stringify({ id: 'pack', name: '猫', description: 'desc', stickers: [{ id: 'one', file: 'one.png', name: '你好', tags: ['开心'] }] }));
    const payload = zip([{ name: 'manifest.json', data: manifest }, { name: 'one.png', data: png }]);
    const session = (await partner.snapshot()).sessionId, url = `${origin}/api/stickers/imports?sessionId=${encodeURIComponent(session)}`;
    const headers = { origin, authorization: 'owner', 'content-type': 'application/zip' };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'bad' }, body: Uint8Array.from(payload) })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://other.invalid' }, body: Uint8Array.from(payload) })).status, 403);
    const invalidPayload = zip([{ name: 'manifest.json', data: manifest }, { name: '../private.png', data: png }]);
    const invalid = await fetch(url, { method: 'POST', headers, body: Uint8Array.from(invalidPayload) });
    assert.equal(invalid.status, 400); const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, 'invalid_import'); assert.doesNotMatch(JSON.stringify(invalidBody), /private|\.\./u);
    const imported = await fetch(url, { method: 'POST', headers, body: Uint8Array.from(payload) }); assert.equal(imported.status, 200);
    const pack = (await imported.json()).pack; assert.equal(pack.cover.name, '你好');
    const page = await fetch(`${origin}/api/stickers/search?sessionId=${encodeURIComponent(session)}&query=${encodeURIComponent('开心')}&limit=1`, { headers: { authorization: 'owner' } });
    assert.deepEqual((await page.json()).stickers.map((item: { id: string }) => item.id), [pack.cover.id]);
    assert.equal((await partner.conversationImages()).images.length, 0);
    const favorite = await fetch(`${origin}/api/stickers/favorites`, { method: 'POST', headers: { origin, authorization: 'owner', 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session, stickerId: pack.cover.id, favorite: true }) });
    assert.equal(favorite.status, 200);
    const catalog = await StickerCatalog.open(f.workspace);
    try { assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 1); assert.equal((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.length, 0); }
    finally { catalog.close(); }
    const upload = await fetch(`${origin}/api/stickers/favorites/upload`, { method: 'POST', headers: { origin, authorization: 'owner', 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session, name: '单张', tags: ['测试'], mediaType: 'image/png', data: png.toString('base64') }) });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json(); assert.equal(uploaded.favorite, true);
    const favoritesPage = await fetch(`${origin}/api/stickers/favorites?sessionId=${encodeURIComponent(session)}&limit=1`, { headers: { authorization: 'owner' } });
    const favorites = await favoritesPage.json(); assert.equal(favorites.stickers.length, 1); assert.ok(favorites.nextCursor);
    const secondPage = await fetch(`${origin}/api/stickers/favorites?sessionId=${encodeURIComponent(session)}&limit=1&cursor=${favorites.nextCursor}`, { headers: { authorization: 'owner' } });
    assert.equal((await secondPage.json()).stickers.length, 1);
    assert.equal((await partner.conversationImages()).images.length, 0);
    const mediaUrl = `${origin}/api/stickers/media/${pack.cover.version}/original`;
    const original = await fetch(mediaUrl, { headers: { authorization: 'owner' } }); assert.equal(original.status, 200);
    assert.equal(original.headers.get('cache-control'), 'private, no-cache');
    const etag = original.headers.get('etag')!; assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
    assert.equal((await fetch(mediaUrl, { headers: { authorization: 'owner', 'if-none-match': etag } })).status, 304);
    const thumbnailUrl = `${origin}/api/stickers/media/${pack.cover.version}/thumbnail`;
    assert.equal((await fetch(thumbnailUrl)).status, 401);
    const thumbnail = await fetch(thumbnailUrl, { headers: { authorization: 'owner' } });
    assert.equal(thumbnail.status, 200); assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.equal(thumbnail.headers.get('cache-control'), 'private, no-cache');
    const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
    assert.ok(thumbnailBytes.length <= 160_000);
    const thumbnailTag = thumbnail.headers.get('etag')!;
    assert.ok(thumbnailTag.includes(createHash('sha256').update(thumbnailBytes).digest('hex')));
    assert.equal((await fetch(thumbnailUrl, { headers: { authorization: 'owner', 'if-none-match': thumbnailTag } })).status, 304);
    const retired = await fetch(`${origin}/api/stickers/media/${pack.cover.version}/preview`, { headers: { authorization: 'owner', 'if-none-match': thumbnailTag } });
    assert.ok([400, 404].includes(retired.status));
    assert.ok(!retired.headers.get('content-type')?.startsWith('image/'));
    authorized = false;
    assert.equal((await fetch(mediaUrl, { headers: { authorization: 'owner', 'if-none-match': etag } })).status, 401);
    assert.equal((await fetch(thumbnailUrl, { headers: { authorization: 'owner', 'if-none-match': thumbnailTag } })).status, 401);
  } finally { await app.close(); await f.close(); }
});

test('directory importer runs as a long-lived CLI command using only test-owned workspace', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fixture } = await import('./fixture.ts');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(); const directory = join(f.directory, 'pack'); await mkdir(directory);
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  const manifest = { id: 'pack', name: '包', description: 'desc', stickers: [{ id: 'one', file: 'one.png', name: '一', tags: [] }] };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)); await writeFile(join(directory, 'one.png'), png);
  const config = join(f.directory, 'fixture.toml');
  await writeFile(config, `name = "Mica"\nprompts = { persona = ${JSON.stringify(f.config.prompts.persona)} }\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\n`);
  const script = fileURLToPath(new URL('../runtime/cli.ts', import.meta.url));
  try {
    const result = await promisify(execFile)(process.execPath, [script, 'import-stickers', config, directory]);
    assert.equal(JSON.parse(result.stdout).count, 1);
    const catalog = await StickerCatalog.open(f.workspace);
    try { assert.equal((await catalog.getPack('pack'))?.cover.name, '一'); } finally { catalog.close(); }
    assert.equal((await f.requests()).length, 0);
  } finally { await f.close(); }
});
