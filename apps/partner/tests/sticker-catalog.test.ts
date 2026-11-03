import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { StickerCatalog, packStickerId } from '../runtime/sticker-catalog.ts';

test('participants independently favorite shared chat images and uploads with first saved metadata', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-shared-favorites-'));
  const human = await StickerCatalog.open(workspace), agent = await StickerCatalog.open(workspace);
  const png = async (color: string) => sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
  const red = await png('red'), blue = await png('blue');
  const humanInput = { name: 'Human name', tags: ['human'], bytes: red, mediaType: 'image/png' as const };
  const agentInput = { name: 'Partner name', tags: ['partner'], bytes: red, mediaType: 'image/png' as const };
  const chat = { kind: 'chat' as const, imageId: 'a'.repeat(64) };
  try {
    const firstChat = await human.favoriteImage('human', chat, humanInput);
    const secondChat = await agent.favoriteImage('agent', chat, agentInput);
    assert.equal(secondChat.id, firstChat.id);
    assert.equal(secondChat.version, firstChat.version);
    assert.equal(secondChat.name, humanInput.name);
    assert.deepEqual(secondChat.tags, humanInput.tags);
    assert.deepEqual((await human.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstChat.id]);
    assert.deepEqual((await agent.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstChat.id]);
    await human.favorite('human', firstChat.id, false);
    assert.equal((await human.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 0);
    assert.deepEqual((await agent.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstChat.id]);
    await assert.rejects(human.favoriteImage('human', chat, { ...humanInput, bytes: blue }), /Sticker source identity conflict/u);
    assert.equal((await human.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 0);
    assert.deepEqual((await agent.media(firstChat.version, 'original'))?.bytes, red);

    const firstUpload = await agent.favoriteImage('agent', { kind: 'upload' }, agentInput);
    const secondUpload = await human.favoriteImage('human', { kind: 'upload' }, humanInput);
    assert.equal(secondUpload.id, firstUpload.id);
    assert.equal(secondUpload.version, firstUpload.version);
    assert.equal(secondUpload.name, agentInput.name);
    assert.deepEqual(secondUpload.tags, agentInput.tags);
    assert.deepEqual((await human.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstUpload.id]);
    assert.deepEqual(new Set((await agent.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.map(item => item.id)), new Set([firstChat.id, firstUpload.id]));
    await agent.favorite('agent', firstUpload.id, false);
    assert.deepEqual((await human.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstUpload.id]);
    assert.deepEqual((await agent.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.map(item => item.id), [firstChat.id]);
    assert.deepEqual((await human.media(firstUpload.version, 'original'))?.bytes, red);

    const db = new DatabaseSync(join(workspace, '.lamplit', 'stickers', 'catalog.sqlite'), { readOnly: true });
    try { assert.equal((db.prepare('SELECT count(*) AS count FROM sticker_assets').get() as { count: number }).count, 1); }
    finally { db.close(); }
    const files = await readdir(join(workspace, '.lamplit', 'stickers', 'assets'));
    assert.equal(files.filter(file => file.startsWith(firstChat.version)).length, 3);
  } finally { human.close(); agent.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('catalog preserves actor favorites and immutable prior media across reimport', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-catalog-'));
  const png = async (color: string) => sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
  const first = await png('red'), second = await png('blue');
  const manifest = { id: 'cats', name: '猫', description: '测试', stickers: [{ id: 'hello', file: 'hello.png', name: '你好', tags: ['开心'] }] };
  let catalog = await StickerCatalog.open(workspace);
  try {
    const files = (bytes: Buffer) => new Map([['hello.png', { bytes, mediaType: 'image/png' as const }]]);
    await catalog.importPack(manifest, files(first));
    const stickerId = packStickerId('cats', 'hello');
    const old = (await catalog.get(stickerId))!;
    assert.equal(old.available, true);
    assert.deepEqual((await catalog.listStickers({ cursor: null, limit: 1, query: '开心' })).stickers.map(s => s.id), [stickerId]);
    await catalog.favorite('human', stickerId, true);
    assert.equal((await catalog.listStickers({ cursor: null, limit: 10, participant: 'agent' })).stickers.length, 0);
    await catalog.favorite('agent', stickerId, true);
    await catalog.favorite('human', stickerId, false);
    await catalog.importPack(manifest, files(second));
    const next = (await catalog.get(stickerId))!;
    assert.notEqual(next.version, old.version);
    assert.deepEqual((await catalog.media(old.version, 'original'))?.bytes, first);
    assert.deepEqual((await catalog.media(next.version, 'original'))?.bytes, second);
    await assert.rejects(catalog.asset(stickerId, old.version));
    catalog.close(); catalog = await StickerCatalog.open(workspace);
    assert.equal((await catalog.listStickers({ cursor: null, limit: 10, participant: 'human' })).stickers.length, 0);
    assert.equal((await catalog.listStickers({ cursor: null, limit: 10, participant: 'agent' })).stickers[0]?.id, stickerId);
    await assert.rejects(catalog.importPack({ ...manifest, stickers: [{ ...manifest.stickers[0], file: '../x' }] }, files(first)));
    assert.equal((await catalog.get(stickerId))?.version, next.version);
    const asset = await catalog.asset(stickerId, next.version);
    await writeFile(asset.previewPath, Buffer.from('corrupted'));
    assert.equal(await catalog.media(next.version, 'preview'), null);
    await assert.rejects(catalog.asset(stickerId, next.version));
    assert.deepEqual((await catalog.media(next.version, 'original'))?.bytes, second);
  } finally { catalog.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('concurrent imports resolve to one complete pack and identical retries remain idempotent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-race-'));
  const a = await StickerCatalog.open(workspace), b = await StickerCatalog.open(workspace);
  const manifest = { id: 'race', name: 'Race', description: '', stickers: [{ id: 'one', file: 'one.png', name: 'One', tags: [] }] };
  const image = async (color: string) => sharp({ create: { width: 4, height: 4, channels: 3, background: color } }).png().toBuffer();
  const red = await image('red'), blue = await image('blue');
  const files = (bytes: Buffer) => new Map([['one.png', { bytes, mediaType: 'image/png' as const }]]);
  try {
    const race = await Promise.allSettled([a.importPack(manifest, files(red)), b.importPack(manifest, files(blue))]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected').length, 1);
    const winner = race[0]!.status === 'fulfilled' ? red : blue;
    const pack = (await a.getPack('race'))!;
    assert.deepEqual((await a.media(pack.cover.version, 'original'))?.bytes, winner);
    const identical = await Promise.allSettled([a.importPack(manifest, files(winner)), b.importPack(manifest, files(winner))]);
    assert.equal(identical.every(result => result.status === 'fulfilled'), true);
  } finally { a.close(); b.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('removing and restoring a pack member keeps its stable identity and favorites', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-return-'));
  const catalog = await StickerCatalog.open(workspace);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'green' } }).png().toBuffer();
  const first = { id: 'first', file: 'first.png', name: 'First', tags: [] }, second = { id: 'second', file: 'second.png', name: 'Second', tags: [] };
  const manifest = { id: 'pack', name: 'Pack', description: '', stickers: [first, second] };
  const files = new Map([['first.png', { bytes: png, mediaType: 'image/png' as const }], ['second.png', { bytes: png, mediaType: 'image/png' as const }]]);
  try {
    await catalog.importPack(manifest, files); const secondId = packStickerId('pack', 'second');
    await catalog.favorite('human', secondId, true);
    await catalog.importPack({ ...manifest, stickers: [first] }, new Map([['first.png', files.get('first.png')!]]));
    assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers[0]?.id, secondId);
    assert.deepEqual((await catalog.listStickers({ packId: 'pack', cursor: null, limit: 10 })).stickers.map(item => item.name), ['First']);
    await catalog.importPack(manifest, files);
    assert.deepEqual((await catalog.listStickers({ packId: 'pack', cursor: null, limit: 10 })).stickers.map(item => item.id), [packStickerId('pack', 'first'), secondId]);
    assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers[0]?.id, secondId);
  } finally { catalog.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('catalog label and tag limits count Unicode code points like the shared contract', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-unicode-'));
  const catalog = await StickerCatalog.open(workspace);
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  const input = { name: '😀'.repeat(160), tags: ['😀'.repeat(80)], bytes: png, mediaType: 'image/png' as const };
  try {
    const sticker = await catalog.favoriteImage('human', { kind: 'upload' }, input);
    assert.equal(sticker.name, input.name); assert.deepEqual(sticker.tags, input.tags);
    await assert.rejects(catalog.favoriteImage('agent', { kind: 'upload' }, { ...input, name: '😀'.repeat(161) }));
  } finally { catalog.close(); await rm(workspace, { recursive: true, force: true }); }
});
