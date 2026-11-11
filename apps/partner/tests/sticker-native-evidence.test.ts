import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import sharp from 'sharp';
import { fixture, eventually } from './fixture.ts';
import { StickerCatalog, packStickerId } from '../runtime/sticker-catalog.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';

test('a completed mixed file operation keeps its preserved sticker and long-lived bytes', async () => {
  const f = await fixture(); const realNow = Date.now;
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
  const catalog = await StickerCatalog.open(f.workspace);
  await catalog.importPack({ id: 'cats', name: 'cats', description: '', stickers: [{ id: 'one', file: 'one.png', name: 'cat', tags: [] }] }, new Map([['one.png', { bytes: png, mediaType: 'image/png' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!;
  const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const backend = partner.stickerBackend(async () => true, () => true);
    const stage = { sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } };
    const staged = await backend.stage(stage, async () => true);
    const manifest = { sessionId, operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'f', (async function* () {})(), owner, async () => true, () => true);
    await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    Date.now = () => realNow() + 30 * 24 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    // Restaging an operation that is already recorded is idempotent, and nothing
    // is retired or deleted, so the preserved sticker bytes stay readable.
    assert.deepEqual((await backend.stage(stage, async () => true)).image, staged.image);
    assert.ok((await partner.fileOperationStatus(operationId, owner, async () => true))?.result);
    assert.deepEqual((await partner.sharedMedia(staged.image.attachmentId, 'original'))?.bytes, png);
    assert.ok(await partner.sharedMedia(staged.image.attachmentId, 'preview'));
  } finally { Date.now = realNow; await partner.close(); catalog.close(); await f.close(); }
});

test('completed Companion sticker call projects one GIF image and retains it after reimport and native restart', async () => {
  const f = await fixture();
  const pixels = Buffer.from([255,0,0,255, 0,255,0,255]);
  const gif = await sharp(pixels, { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const changed = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
  const manifest = { id: 'cats', name: '猫', description: '', stickers: [{ id: 'one', file: 'one.gif', name: '猫猫', tags: ['开心'] }] };
  const catalog = await StickerCatalog.open(f.workspace);
  await catalog.importPack(manifest, new Map([['one.gif', { bytes: gif, mediaType: 'image/gif' }]]));
  const old = (await catalog.get(packStickerId('cats', 'one')))!;
  f.appServer.env.FAKE_STICKER_RESULT = JSON.stringify({ kind: 'sticker', id: old.id, version: old.version, name: old.name, tags: old.tags, mediaType: old.mediaType });
  f.appServer.env.FAKE_STICKER_IMAGE = (await catalog.asset(old.id, old.version)).model.toString('base64');
  let partner = await f.createPartner();
  try {
    await partner.submit(crypto.randomUUID(), 'send sticker');
    await eventually(async () => (await createCodexChatBackend(partner).read()).messages.some(message => message.role === 'agent' && message.images?.length === 1));
    let view = await createCodexChatBackend(partner).read();
    const image = view.messages.find(message => message.role === 'agent' && message.images?.length)?.images?.[0]!;
    assert.deepEqual(image.sticker, { id: old.id, version: old.version });
    assert.equal(image.mediaType, 'image/gif');
    assert.deepEqual((await partner.sharedMedia(image.attachmentId, 'original'))?.bytes, gif);
    assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
    const next = { ...manifest, stickers: [{ ...manifest.stickers[0]!, file: 'one.png' }] };
    await catalog.importPack(next, new Map([['one.png', { bytes: changed, mediaType: 'image/png' }]]));
    await partner.close(); partner = await f.createPartner();
    view = await createCodexChatBackend(partner).read();
    const restored = view.messages.find(message => message.role === 'agent' && message.images?.length)?.images?.[0]!;
    assert.deepEqual(restored.sticker, image.sticker);
    assert.deepEqual((await partner.sharedMedia(restored.attachmentId, 'original'))?.bytes, gif);
  } finally { catalog.close(); await f.close(); }
});

test('authenticated Human ID staging submits a static native model frame and restores the animated original', async () => {
  const { join } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { createWebServer } = await import('./web-server.ts');
  const f = await fixture(); await f.holdProvider(true);
  const gif = await sharp(Buffer.from([255,0,0,255, 0,255,0,255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const catalog = await StickerCatalog.open(f.workspace);
  const manifest = { id: 'cats', name: '猫', description: 'animated', stickers: [{ id: 'one', file: 'one.gif', name: '挥手', tags: ['开心'] }] };
  await catalog.importPack(manifest, new Map([['one.gif', { bytes: gif, mediaType: 'image/gif' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!;
  let partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async request => request.headers.authorization === 'fixture-owner' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { origin, authorization: 'fixture-owner', 'content-type': 'application/json' };
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const stage = { sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } };
    assert.equal((await fetch(origin + '/api/stickers/stage', { method: 'POST', headers: { ...headers, authorization: 'bad' }, body: JSON.stringify(stage) })).status, 401);
    const response = await fetch(origin + '/api/stickers/stage', { method: 'POST', headers, body: JSON.stringify(stage) });
    assert.equal(response.status, 200); const staged = await response.json();
    assert.deepEqual(staged.image.sticker, stage.sticker);
    const backend = partner.stickerBackend(async () => true, () => true);
    const [thumbnail, concurrent] = await Promise.all([
      backend.media(sticker.version, 'thumbnail'), backend.media(sticker.version, 'thumbnail'),
    ]);
    assert.equal(thumbnail?.mediaType, 'image/webp');
    assert.equal((await sharp(thumbnail!.bytes).metadata()).format, 'webp');
    assert.deepEqual(concurrent?.bytes, thumbnail?.bytes);
    assert.deepEqual((await backend.media(sticker.version, 'thumbnail'))?.bytes, thumbnail?.bytes);
    const preview = await partner.sharedMedia(staged.image.attachmentId, 'preview');
    assert.equal(preview?.mediaType, 'image/jpeg');
    assert.equal((await sharp(preview!.bytes).metadata()).format, 'jpeg');
    let checks = 0;
    const revoked = partner.stickerBackend(async () => ++checks === 1, () => false);
    await assert.rejects(revoked.media(sticker.version, 'thumbnail'), /Unauthorized/u);
    await assert.rejects(partner.stickerBackend(async () => false, () => false).media(sticker.version, 'thumbnail'), /Unauthorized/u);
    assert.deepEqual((await backend.stage(stage, async () => true)).image, staged.image);
    assert.equal((await partner.conversationImages()).images.length, 0);
    const submission = { operationId, text: '', images: [staged.image] };
    await partner.submitNativeDelivery(submission); await partner.submitNativeDelivery(submission);
    await partner.submitNativeDelivery({ ...submission, images: [{ ...staged.image, sticker: { version: sticker.version, id: sticker.id } }] });
    await eventually(async () => await f.consumed(operationId));
    const starts = (await f.requests()).filter(request => request.method === 'turn/start');
    assert.equal(starts.length, 1);
    const params = starts[0]!.params as { input: Array<{ type: string; path?: string }>; additionalContext: Record<string, { value: string }> };
    const model = await readFile(params.input.find(input => input.type === 'localImage')!.path!);
    assert.equal((await sharp(model).metadata()).format, 'jpeg');
    assert.equal((await sharp(model, { animated: true }).metadata()).pages ?? 1, 1);
    assert.notDeepEqual(model, gif);
    assert.match(params.additionalContext['codex-for-love.sticker']!.value, /挥手/u);
    assert.match(params.additionalContext['codex-for-love.sticker']!.value, /开心/u);
    const media = await fetch(`${origin}/api/chat/media/${staged.image.attachmentId}/original`, { headers });
    assert.equal(media.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), gif);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    const view = await createCodexChatBackend(partner).read();
    assert.deepEqual(view.messages.find(message => message.operationId === operationId)?.images?.[0]?.sticker, stage.sticker);
    await eventually(async () => (await partner.conversationImages()).images.length === 1);
    const favoriteBackend = partner.stickerBackend(async () => true, () => true);
    await assert.rejects(favoriteBackend.favoriteImage({ sessionId, imageId: 'a'.repeat(64), name: 'bad', tags: [] }, async () => true));
    const favorite = await favoriteBackend.favoriteImage({ sessionId, imageId: staged.image.attachmentId, name: 'saved', tags: ['聊天'] }, async () => true);
    assert.equal(favorite.favorite, true);
    assert.equal((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.length, 0);
    await catalog.favorite('human', favorite.sticker.id, false);
    assert.deepEqual((await partner.sharedMedia(staged.image.attachmentId, 'original'))?.bytes, gif);
    assert.equal((await partner.conversationImages()).images.length, 1);
    await app.close(); await partner.close();
    const { DatabaseSync } = await import('node:sqlite');
    const { partnerPaths } = await import('../runtime/storage-paths.ts');
    const database = new DatabaseSync(partnerPaths(f.workspace).database);
    try {
      const row = database.prepare('SELECT payload FROM staged_images WHERE operation_id=?').get(operationId) as { payload: string };
      const variant = JSON.parse(row.payload).variants[0];
      assert.equal(typeof variant.previewPath, 'string'); assert.equal(typeof variant.modelPath, 'string');
      assert.equal(variant.preview, undefined); assert.equal(variant.model, undefined);
      assert.equal(row.payload.includes(gif.toString('base64')), false);
    } finally { database.close(); }
    partner = await f.createPartner();
    const restored = await createCodexChatBackend(partner).read();
    assert.deepEqual(restored.messages.find(message => message.operationId === operationId)?.images?.[0]?.sticker, stage.sticker);
    assert.deepEqual((await partner.sharedMedia(staged.image.attachmentId, 'original'))?.bytes, gif);
  } finally { await app.close().catch(() => undefined); catalog.close(); await f.close(); }
});

test('uncertain sticker native admission is never automatically replayed after restart', async () => {
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture(); f.appServer.env.FAKE_IMAGES_FIXTURE = 'true';
  await writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ hold: true, mode: 'uncertain' }));
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const catalog = await StickerCatalog.open(f.workspace);
  await catalog.importPack({ id: 'cats', name: '猫', description: '', stickers: [{ id: 'one', file: 'one.png', name: '猫', tags: [] }] }, new Map([['one.png', { bytes: png, mediaType: 'image/png' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!;
  let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const staged = await partner.stickerBackend(async () => true, () => true).stage({ sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } }, async () => true);
    await partner.submitNativeDelivery({ operationId, text: '', images: [staged.image] });
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/start' && (request.params as { clientUserMessageId?: string }).clientUserMessageId === operationId));
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    const count = (await f.requests()).filter(request => request.method === 'turn/start').length;
    await partner.close(); partner = await f.createPartner();
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, count);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
  } finally { catalog.close(); await f.close(); }
});

test('a corrupted staged representative frame fails before native admission', async () => {
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture(); const catalog = await StickerCatalog.open(f.workspace);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  await catalog.importPack({ id: 'cats', name: '猫', description: '', stickers: [{ id: 'one', file: 'one.png', name: '猫', tags: [] }] }, new Map([['one.png', { bytes: png, mediaType: 'image/png' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!;
  const asset = await catalog.asset(sticker.id, sticker.version); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const staged = await partner.stickerBackend(async () => true, () => true).stage({ sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } }, async () => true);
    await writeFile(asset.modelPath, Buffer.from([255, 216, 255, 1]));
    assert.equal((await partner.submitNativeDelivery({ operationId, text: '', images: [staged.image] }))?.state, 'failed');
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0);
    assert.equal((await partner.conversationImages()).images.length, 0);
  } finally { catalog.close(); await f.close(); }
});

test('corrupted historical sticker original is reported missing instead of serving changed bytes', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { imagePath } = await import('../runtime/images.ts');
  const f = await fixture(); await f.holdProvider(true);
  const catalog = await StickerCatalog.open(f.workspace);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  await catalog.importPack({ id: 'cats', name: '猫', description: '', stickers: [{ id: 'one', file: 'one.png', name: '猫', tags: [] }] }, new Map([['one.png', { bytes: png, mediaType: 'image/png' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!; const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const staged = await partner.stickerBackend(async () => true, () => true).stage({ sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } }, async () => true);
    await partner.submitNativeDelivery({ operationId, text: '', images: [staged.image] }); await eventually(async () => await f.consumed(operationId));
    await writeFile(imagePath(f.workspace, { id: staged.image.attachmentId, media_type: 'image/png' }), Buffer.concat([png, Buffer.from('changed')]));
    assert.equal((await partner.sharedImageRef(staged.image.attachmentId))?.availability, 'missing');
    assert.equal(await partner.sharedMedia(staged.image.attachmentId, 'original'), null);
  } finally { catalog.close(); await f.close(); }
});
