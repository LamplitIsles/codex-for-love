import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { imagePath } from '../runtime/images.ts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';

// Two-frame APNG and WebP generated from testsrc using ffmpeg, with no external data.
const apng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAIAAAACAAAAAAAAAAAAAEAAgAA/F3r2gAAADlJREFUeJxjYGBg+A/G/8HUfzDrP5gDkvgPJv6jsBggNIoEDFBJAsQ+wFAPohxAjrL/3wCi9uOUAADpnlKu0JPIDwAAABpmY1RMAAAAAQAAAAgAAAACAAAAAAAAAAYAAQACAABj8UkiAAAAJGZkQVQAAAACeJxj+N/AsP8/AwMIHWCo/+/A8P8/CNkz4JIAAFYQF+nP29pEAAAAAElFTkSuQmCC', 'base64');
const webp = Buffer.from('UklGRjYBAABXRUJQVlA4WAoAAAACAAAABwAABwAAQU5JTQYAAAD/////AABBTk1GnAAAAAAAAAAAAAcAAAcAAPQBAAJWUDgghAAAAJACAJ0BKggACAACADQlsAJ0MoA6QApUpcrXQxZgAP7xvH4Mzb5PUl9i8SYs9LsFD/mLNfTXj+3K+k/E8uCJ8vCnQEvw9SdXs9lPAjJ3odwBPlSj/8dnY7CkJkH77/lRVtH//KBw/5UP9ORJax/E7974hFQGF5P97z3xQ9bdz/mhn0gAAEFOTUZmAAAAAAAAAwAABwAAAQAA9AEAAFZQOCBOAAAAtAIAnQEqCAACAAAANCWoAnRHAH8AygD9AAUqbGagAP7nSYH9b/tXyV8HYjP/+PlcTv+O9//x8rid4aP/+i118n//gN1//sWuvk/9FgAA', 'base64');

test('single retained images keep stage identity and project trusted album links after reload', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  let app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async req => req.headers.authorization === 'owner' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = () => ({ origin, authorization: 'owner', 'content-type': 'application/json' });
  const restart = async () => {
    await app.close(); await partner.close(); partner = await f.createPartner();
    app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async req => req.headers.authorization === 'owner' });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  try {
    assert.equal((await sharp(webp, { animated: true }).metadata()).pages, 2);
    const staticWebp = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).webp().toBuffer();
    const gif = await sharp(Buffer.from([255,0,0,255,0,255,0,255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100,100] }).toBuffer();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    const originals = [webp, apng, staticWebp, gif, jpeg];
    const input = { sessionId: partner.currentSessionId(), operationId: crypto.randomUUID(), images: originals.map((bytes, order) => ({ id: `draft-${order}`, order, name: 'same-name', mediaType: ['image/webp','image/png','image/webp','image/gif','image/jpeg'][order]!, original: bytes.toString('base64') })) };
    const post = (body: unknown) => fetch(`${origin}/api/chat/images`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    assert.equal((await post({ ...input, images: [{ ...input.images[0], preview: '/9j/2Q==' }] })).status, 400);
    assert.equal((await post({ ...input, images: [{ ...input.images[0], model: '/9j/2Q==' }] })).status, 400);
    const response = await post(input); assert.equal(response.status, 200);
    const staged = await response.json() as { images: Array<{ ref: { attachmentId: string; name: string; mediaType: 'image/webp' | 'image/png' | 'image/gif' | 'image/jpeg'; availability: 'available'; animated?: true } }> };
    assert.deepEqual(await (await post(input)).json(), staged);
    assert.ok(staged.images.every(item => !('animated' in item.ref)));
    const id = staged.images[0]!.ref.attachmentId;
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/chat/media/${id}/original`, { headers: headers() })).arrayBuffer()), webp);
    assert.equal((await fetch(`${origin}/api/chat/media/${id}/preview`, { headers: headers() })).status, 404);
    await restart();
    assert.deepEqual(await (await post(input)).json(), staged);
    const submission = { operationId: input.operationId, text: '', images: staged.images.map(item => item.ref) };
    await partner.submitNativeDelivery(submission); await partner.submitNativeDelivery(submission);
    await eventually(async () => await f.consumed(input.operationId));
    const starts = (await f.requests()).filter(req => req.method === 'turn/start'); assert.equal(starts.length, 1);
    const native = (starts[0]!.params as { input: Array<{ type: string; path?: string }> }).input.filter(part => part.type === 'localImage');
    assert.equal(native.length, originals.length);
    for (const [index, part] of native.entries()) assert.deepEqual(await readFile(part.path!), originals[index]);
    await eventually(async () => (await createCodexChatBackend(partner).read()).messages.some(message => message.operationId === input.operationId));
    const inspect = async () => {
      const backend = createCodexChatBackend(partner);
      const view = await backend.read();
      const refs = view.messages.find(message => message.operationId === input.operationId)!.images!;
      assert.deepEqual(refs, staged.images.map(item => item.ref));
      assert.ok(refs.every(ref => !('animated' in ref)));
      const catalogue = await (await fetch(`${origin}/api/conversation-images?limit=2`, { headers: headers() })).json() as { images: Array<{ id: string; attachmentId?: string; url: string }>; nextCursor?: string };
      assert.equal(catalogue.images.length, 2); assert.ok(catalogue.nextCursor);
      const second = await (await fetch(`${origin}/api/conversation-images?limit=2&cursor=${catalogue.nextCursor}`, { headers: headers() })).json() as typeof catalogue;
      assert.ok(second.nextCursor);
      const third = await (await fetch(`${origin}/api/conversation-images?limit=2&cursor=${second.nextCursor}`, { headers: headers() })).json() as typeof catalogue;
      const rows = [...catalogue.images, ...second.images, ...third.images];
      assert.deepEqual(new Set(rows.map(row => row.attachmentId)), new Set(staged.images.map(item => item.ref.attachmentId)));
      for (const [index, stagedImage] of staged.images.entries()) {
        const linked = rows.find(row => row.attachmentId === stagedImage.ref.attachmentId)!;
        assert.deepEqual(Buffer.from(await (await fetch(`${origin}${linked.url}`, { headers: headers() })).arrayBuffer()), originals[index]);
      }
      const album = await backend.album({ sessionId: input.sessionId, cursor: null });
      const item = album.images.find(image => image.id === id)!;
      const row = rows.find(image => image.attachmentId === id)!;
      assert.equal(item.previewUrl, `/api/image-thumbnails/album/${row.id}`);
      assert.equal(item.originalUrl, `/api/chat/media/${id}/original`);
      assert.equal((await fetch(`${origin}${item.previewUrl}`, { headers: headers() })).headers.get('content-type'), 'image/webp');
      assert.deepEqual(Buffer.from(await (await fetch(`${origin}${item.originalUrl}`, { headers: headers() })).arrayBuffer()), webp);
      assert.deepEqual(Buffer.from(await (await fetch(`${origin}${row.url}`, { headers: headers() })).arrayBuffer()), webp);
      assert.equal((await fetch(`${origin}/api/conversation-images`)).status, 401);
      assert.equal((await fetch(`${origin}${item.previewUrl}`)).status, 401);
      return row;
    };
    await inspect();
    await restart();
    await eventually(async () => (await createCodexChatBackend(partner).read()).messages.some(message => message.operationId === input.operationId));
    const row = await inspect();
    const retainedPath = imagePath(f.workspace, { id, media_type: 'image/webp' });
    await writeFile(retainedPath, Buffer.concat([webp, Buffer.from('changed')]));
    const changed = await (await fetch(`${origin}/api/conversation-images?limit=50`, { headers: headers() })).json() as { images: Array<{ id: string; attachmentId?: string }> };
    assert.equal(changed.images.find(image => image.id === row.id)?.attachmentId, undefined);
    await rm(retainedPath);
    const after = await (await fetch(`${origin}/api/conversation-images?limit=50`, { headers: headers() })).json() as { images: Array<{ id: string; available: boolean; attachmentId?: string }> };
    assert.equal(after.images.find(image => image.id === row.id)?.available, false);
    assert.equal(after.images.find(image => image.id === row.id)?.attachmentId, undefined);
  } finally { await app.close(); await f.close(); }
});
