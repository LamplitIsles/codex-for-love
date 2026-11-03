import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { StickerCatalog, packStickerId } from '../runtime/sticker-catalog.ts';
import { inspectStickerImage } from '../runtime/sticker-image.ts';

async function gif(colors: number[]): Promise<Buffer> {
  const pixels = Buffer.from(colors.flatMap(value => [value, 0, 0, 255]));
  return sharp(pixels, { raw: { width: 1, height: colors.length, channels: 4, pageHeight: 1 } }).gif({ delay: colors.map(() => 100), loop: 0 }).toBuffer();
}

test('inspect and public edits through Companion preserve assets and favorites', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-inspect-'));
  const catalog = await StickerCatalog.open(workspace);
  const client = new Client({ name: 'test', version: '1' });
  try {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toBuffer();
    const animated = await gif([10, 40, 70, 100, 130, 160, 190, 220]);
    const single = await gif([100]);
    const two = await gif([20, 220]);
    const manifest = { id: 'pack', name: 'Pack', description: '', stickers: [
      { id: 'png', file: 'a.png', name: 'Original', tags: ['old'] },
      { id: 'gif', file: 'b.gif', name: 'Moving', tags: [] },
      { id: 'single', file: 'c.gif', name: 'Still', tags: [] },
      { id: 'two', file: 'd.gif', name: 'Two', tags: [] },
    ] };
    const files = new Map([['a.png', { bytes: png, mediaType: 'image/png' as const }], ['b.gif', { bytes: animated, mediaType: 'image/gif' as const }], ['c.gif', { bytes: single, mediaType: 'image/gif' as const }], ['d.gif', { bytes: two, mediaType: 'image/gif' as const }]]);
    await catalog.importPack(manifest, files);
    const id = packStickerId('pack', 'png'), gifId = packStickerId('pack', 'gif');
    await catalog.favorite('human', id, true);
    await catalog.favorite('agent', id, true);
    const original = (await catalog.get(id))!;
    const asset = await catalog.asset(id, original.version);
    const historicalPath = (await catalog.historicalAsset(id, original.version)).path;
    const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace], stderr: 'ignore' }));
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    for (const [stickerId, count, expectedAnimated, sampled] of [[id, 1, false, [0]], [gifId, 8, true, [0, 1, 3, 4, 6, 7]], [packStickerId('pack', 'single'), 1, false, [0]], [packStickerId('pack', 'two'), 2, true, [0, 1]]] as const) {
      const result = await call('inspect_sticker', { stickerId });
      assert.equal(result.isError, undefined);
      const metadata = JSON.parse(result.content[0]!.text!);
      assert.equal(metadata.id, stickerId); assert.equal(metadata.frameCount, count); assert.equal(metadata.animated, expectedAnimated);
      const current = (await catalog.get(stickerId))!;
      assert.equal(metadata.version, current.version); assert.equal(metadata.name, current.name);
      assert.deepEqual(metadata.tags, current.tags); assert.equal(metadata.mediaType, current.mediaType);
      assert.deepEqual(metadata.sampledFrames, sampled);
      assert.equal(result.content.length, sampled.length + 1);
      assert.equal(metadata.kind, undefined); // Does not produce the send projection.
      if (expectedAnimated) assert.match(metadata.notice, /may omit/u);
      for (const item of result.content.slice(1)) {
        assert.equal(item.type, 'image'); assert.equal(item.mimeType, 'image/jpeg');
        assert.equal((await sharp(Buffer.from(item.data!, 'base64')).metadata()).format, 'jpeg');
      }
      if (stickerId === gifId) {
        const reds = await Promise.all(result.content.slice(1).map(async item => (await sharp(Buffer.from(item.data!, 'base64')).removeAlpha().raw().toBuffer())[0]!));
        for (let i = 1; i < reds.length; i++) assert.ok(reds[i]! > reds[i - 1]!, `frames should follow source order: ${reds}`);
      }
    }
    assert.deepEqual((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.map(s => s.id), [id]);
    assert.deepEqual((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.map(s => s.id), [id]);
    assert.equal((await call('inspect_sticker', { stickerId: 'missing' })).isError, true);
    assert.equal((await call('update_sticker_metadata', { stickerId: id, name: 'Renamed' })).isError, undefined);
    assert.deepEqual((await catalog.get(id))?.tags, ['old']);
    assert.equal((await call('update_sticker_metadata', { stickerId: id, tags: ['new'] })).isError, undefined);
    assert.match(JSON.stringify(await call('search_stickers', { query: 'new' })), /Renamed/u);
    assert.match(JSON.stringify(await call('list_pack_stickers', { packId: 'pack' })), /Renamed/u);
    for (const participant of ['human', 'agent'] as const) {
      const page = await catalog.listStickers({ participant, cursor: null, limit: 10, query: 'new' });
      assert.equal(page.stickers[0]?.name, 'Renamed');
      assert.equal((await catalog.listStickers({ participant, cursor: null, limit: 10, query: 'Renamed' })).stickers[0]?.id, id);
      assert.equal((await catalog.listStickers({ participant, cursor: null, limit: 10, query: 'old' })).stickers.length, 0);
    }
    assert.equal((await call('update_sticker_metadata', { stickerId: id, tags: [] })).isError, undefined);
    assert.deepEqual((await catalog.get(id))?.tags, []);
    for (const args of [{ stickerId: id }, { stickerId: id, name: '   ' }, { stickerId: id, name: 'x'.repeat(161) }, { stickerId: id, tags: ['x', 'x'] }, { stickerId: id, tags: ['x'.repeat(81)] }, { stickerId: id, tags: Array.from({ length: 33 }, (_, i) => `${i}`) }, { stickerId: 'missing', name: 'x' }]) assert.equal((await call('update_sticker_metadata', args)).isError, true);
    assert.equal((await catalog.get(id))?.version, original.version);
    assert.deepEqual(await readFile(historicalPath), png);
    assert.deepEqual((await catalog.asset(id, original.version)).model, asset.model);
    for (const source of [{ kind: 'upload' as const }, { kind: 'chat' as const, imageId: 'a'.repeat(64) }]) {
      const favorite = await catalog.favoriteImage('human', source, { name: 'Saved', tags: [], bytes: png, mediaType: 'image/png' });
      assert.equal((await call('update_sticker_metadata', { stickerId: favorite.id, name: 'Shared' })).isError, undefined);
      assert.equal((await catalog.get(favorite.id))?.name, 'Shared');
    }
    await catalog.importPack(manifest, files);
    assert.equal((await catalog.get(id))?.name, 'Original');
    assert.deepEqual((await catalog.get(id))?.tags, ['old']);
    await writeFile(historicalPath, Buffer.from('corrupt'));
    const unavailable = await call('inspect_sticker', { stickerId: id });
    assert.equal(unavailable.isError, true); assert.match(unavailable.content[0]!.text!, /unavailable|unreadable|limits/u);
  } finally { await client.close(); catalog.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('inspection rejects corrupt and excessive image data', async () => {
  await assert.rejects(inspectStickerImage(Buffer.from('GIF89a'), 'image/gif'));
  await assert.rejects(inspectStickerImage(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png'));
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(inspectStickerImage(wide, 'image/png'));
  const excessive = await gif(Array.from({ length: 101 }, (_, i) => i % 2 ? 255 : 0));
  await assert.rejects(inspectStickerImage(excessive, 'image/gif'));
});

test('inspection composites transparent images onto a visible background', async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const inspected = await inspectStickerImage(png, 'image/png');
  const pixel = await sharp(inspected.images[0]!).raw().toBuffer();
  assert.ok(pixel[0]! > 240 && pixel[1]! > 240 && pixel[2]! > 240);
});
