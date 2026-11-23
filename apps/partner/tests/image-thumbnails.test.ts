import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { conversationImageId } from '../runtime/conversation-images.ts';
import { createImageThumbnails, THUMBNAIL_SOURCE_LIMIT } from '../runtime/image-thumbnails.ts';
import { eventually, fixture } from './fixture.ts';
import { seedPanels } from './panels-seed.ts';
import { createWebServer } from './web-server.ts';

test('thumbnail HTTP routes preserve scopes, geometry, source availability and authorization', async () => {
  const f = await fixture();
  const data = await seedPanels(f.workspace, f.appServer.env.FAKE_SERVER_STATE!);
  const path = data.images[0]!.path;
  const albumId = data.images[0]!.id;
  const chatId = conversationImageId('historical', 'fixture-image-0');
  const oriented = await sharp({ create: { width: 1200, height: 600, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  await writeFile(path, oriented);
  const partner = await f.createPartner();
  let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: (() => authorized) as unknown as () => Promise<boolean> });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const chat = `${origin}/api/image-thumbnails/chat/${chatId}`;
  const album = `${origin}/api/image-thumbnails/album/${albumId}`;
  try {
    for (const [url, dimensions] of [[chat, [256, 512]], [album, [384, 384]]] as const) {
      const result = await fetch(url); assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/webp');
      assert.equal(result.headers.get('cache-control'), 'private, no-store');
      const bytes = Buffer.from(await result.arrayBuffer());
      const meta = await sharp(bytes, { animated: true }).metadata();
      assert.equal(meta.format, 'webp'); assert.equal(meta.pages ?? 1, 1); assert.deepEqual([meta.width, meta.height], dimensions);
      assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
    }
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/chat/media/${chatId}/original`)).arrayBuffer()), oriented);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/conversation-images/${albumId}`)).arrayBuffer()), oriented);
    assert.equal((await fetch(`${origin}/api/image-thumbnails/chat/${albumId}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/image-thumbnails/album/${chatId}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/image-thumbnails/album/not-an-id`)).status, 404);
    assert.equal((await fetch(`${origin}/api/image-thumbnails/chat/missing`)).status, 404);
    for (const url of [chat, album]) assert.equal((await fetch(url, { headers: { origin: 'https://foreign.invalid' } })).status, 403);
    authorized = false;
    for (const url of [chat, album]) assert.equal((await fetch(url)).status, 401);
    authorized = true;
    const small = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
    await writeFile(path, small);
    for (const [url, dimensions] of [[chat, [30, 20]], [album, [20, 20]]] as const) {
      const meta = await sharp(Buffer.from(await (await fetch(url)).arrayBuffer())).metadata();
      assert.deepEqual([meta.width, meta.height], dimensions);
    }
    const bands = Buffer.alloc(60 * 20 * 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 60; x++) bands[(y * 60 + x) * 3 + (x < 20 ? 0 : x < 40 ? 1 : 2)] = 255;
    await writeFile(path, await sharp(bands, { raw: { width: 60, height: 20, channels: 3 } }).png().toBuffer());
    const center = await sharp(Buffer.from(await (await fetch(album)).arrayBuffer())).raw().toBuffer();
    assert.ok(center[1]! > 200 && center[0]! < 30 && center[2]! < 30);
    const animation = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
    await writeFile(path, animation);
    for (const url of [chat, album]) {
      const meta = await sharp(Buffer.from(await (await fetch(url)).arrayBuffer()), { animated: true }).metadata();
      assert.equal(meta.format, 'webp'); assert.equal(meta.pages ?? 1, 1);
    }
    await writeFile(path, 'invalid image');
    for (const url of [chat, album]) assert.equal((await fetch(url)).status, 404);
    await writeFile(path, await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer());
    for (const url of [chat, album]) assert.equal((await fetch(url)).status, 404);
    await writeFile(path, Buffer.alloc(THUMBNAIL_SOURCE_LIMIT + 1));
    for (const url of [chat, album]) assert.equal((await fetch(url)).status, 404);
    await rm(path);
    for (const url of [chat, album]) assert.equal((await fetch(url)).status, 404);

    // Hold the first source read across revocation/session loss, then release it.
    await writeFile(path, small);
    const original = partner.thumbnailSource;
    let reached!: () => void, release!: () => void;
    let held = new Promise<void>(resolve => { reached = resolve; });
    let gate = new Promise<void>(resolve => { release = resolve; });
    partner.thumbnailSource = async (...args) => { const result = await original(...args); reached(); await gate; return result; };
    let pending = fetch(chat); await held; authorized = false; release(); assert.equal((await pending).status, 401);
    authorized = true;
    held = new Promise<void>(resolve => { reached = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
    const allowed = partner.fileReadAllowed;
    let session = true;
    partner.fileReadAllowed = (...args) => session && allowed(...args);
    pending = fetch(album); await held; session = false; release(); assert.equal((await pending).status, 403);
    session = true;
    held = new Promise<void>(resolve => { reached = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
    pending = fetch(chat); await held; await rm(path); release(); assert.equal((await pending).status, 404);
    await writeFile(path, small);
    let lookups = 0;
    held = new Promise<void>(resolve => { reached = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
    partner.thumbnailSource = async (...args) => { const result = await original(...args); if (++lookups === 2) { reached(); await gate; } return result; };
    pending = fetch(chat); await held;
    await writeFile(path + '.replacement', small); await rename(path + '.replacement', path);
    release(); assert.equal((await pending).status, 404);
    let count = 0, allReached!: () => void;
    const allHeld = new Promise<void>(resolve => { allReached = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    partner.thumbnailSource = async (...args) => { const result = await original(...args); if (++count === 4) allReached(); await gate; return result; };
    let arrived = 0;
    app.server.on('request', request => { if (request.headers['x-burst']) arrived++; });
    const requests = data.images.filter(image => image.available).slice(0, 16).map(image =>
      fetch(`${origin}/api/image-thumbnails/album/${image.id}`, { headers: { 'x-burst': '1' } }));
    await allHeld;
    await eventually(async () => arrived === 16); assert.equal(count, 4);
    release(); assert.deepEqual((await Promise.all(requests)).map(response => response.status), Array(16).fill(200));
    partner.thumbnailSource = original;
    const before = Buffer.from(await (await fetch(chat)).arrayBuffer());
    const replacement = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'yellow' } }).png().toBuffer();
    await writeFile(path + '.replacement', replacement); await rename(path + '.replacement', path);
    assert.notDeepEqual(Buffer.from(await (await fetch(chat)).arrayBuffer()), before);

    count = 0; arrived = 0;
    let reachedFour!: () => void;
    const fourHeld = new Promise<void>(resolve => { reachedFour = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    partner.thumbnailSource = async (...args) => { const result = await original(...args); if (++count === 4) reachedFour(); await gate; return result; };
    let disconnected = false;
    app.server.on('request', (request, response) => { if (request.headers['x-cancel']) response.once('close', () => { disconnected = true; }); });
    const saturated = Array.from({ length: 35 }, () => fetch(chat, { headers: { 'x-burst': '1' } }));
    const cancel = new AbortController();
    const cancelledRequest = fetch(chat, { headers: { 'x-burst': '1', 'x-cancel': '1' }, signal: cancel.signal }).catch(() => undefined);
    await fourHeld; await eventually(async () => arrived === 36); assert.equal(count, 4);
    assert.equal((await fetch(album)).status, 503);
    cancel.abort(); await cancelledRequest; await eventually(async () => disconnected);
    saturated.push(fetch(album, { headers: { 'x-burst': '1' } }));
    await eventually(async () => arrived === 37);
    assert.equal((await fetch(album)).status, 503);
    release(); assert.deepEqual((await Promise.all(saturated)).map(response => response.status), Array(36).fill(200));

    // A queued request must be reauthorized before it can resolve or read a source.
    count = 0; arrived = 0;
    let reachedAgain!: () => void;
    const heldAgain = new Promise<void>(resolve => { reachedAgain = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    partner.thumbnailSource = async (...args) => { const result = await original(...args); if (++count === 4) reachedAgain(); await gate; return result; };
    const revoked = Array.from({ length: 5 }, () => fetch(chat, { headers: { 'x-burst': '1' } }));
    await heldAgain; await eventually(async () => arrived === 5);
    authorized = false; release();
    assert.deepEqual((await Promise.all(revoked)).map(response => response.status), Array(5).fill(401));
    assert.equal(count, 4); authorized = true;
    count = 0; arrived = 0;
    const heldSession = new Promise<void>(resolve => { reachedAgain = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    const wrongSession = Array.from({ length: 5 }, () => fetch(album, { headers: { 'x-burst': '1' } }));
    await heldSession; await eventually(async () => arrived === 5);
    session = false; release();
    assert.deepEqual((await Promise.all(wrongSession)).map(response => response.status), Array(5).fill(403));
    assert.equal(count, 4);
  } finally { await app.close(); await f.close(); }
});

test('thumbnail processing deduplicates, bounds concurrency and rejects excessive pixels', async () => {
  const pipeline = createImageThumbnails();
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++) assert.equal(await pipeline.acquire(signal), true);
  const cancelled = new AbortController(); const waiting = pipeline.acquire(cancelled.signal);
  cancelled.abort(); assert.equal(await waiting, false);
  for (let i = 0; i < 4; i++) pipeline.release();
  const bytes = await sharp({ create: { width: 80, height: 50, channels: 3, background: 'green' } }).png().toBuffer();
  let reads = 0; const load = async () => { reads++; return bytes; };
  const [a, b] = await Promise.all([pipeline.render('chat', 'same', load), pipeline.render('chat', 'same', load)]);
  assert.ok(a); assert.strictEqual(a, b); assert.strictEqual(await pipeline.render('chat', 'same', load), a); assert.equal(reads, 1);
  assert.notStrictEqual(await pipeline.render('album', 'same', load), a);
  const excessive = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal(await pipeline.render('chat', 'excessive', async () => excessive), undefined);
});
