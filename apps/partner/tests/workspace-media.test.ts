import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openWorkspaceMedia, MAX_WORKSPACE_MEDIA_BYTES } from '../runtime/workspace-media.ts';
import type { Partner } from '../runtime/partner.ts';
import { createWebServer } from './web-server.ts';

function wav(length = 128, byte = 0x5a) {
  const data = Buffer.alloc(44 + length, byte);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(length, 40); return data;
}
function mp3() {
  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x00]); return Buffer.concat([frame, frame]);
}
function box(name: string, payload = Buffer.alloc(0)) { const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(name, 4); return Buffer.concat([header, payload]); }
// Test-owned two-frame 32x32 synthetic colors: ffmpeg libx264 for the ordinary
// file, mpeg4 and +empty_moov+frag_keyframe for the fragmented file.
// Neither fixture requires ffmpeg at test time.
const mp4 = () => readFileSync(new URL('./fixtures/workspace-video.mp4', import.meta.url));
const fragmentedMp4 = () => readFileSync(new URL('./fixtures/workspace-video-fragmented.mp4', import.meta.url));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-media-')), workspace = join(directory, 'workspace');
  await mkdir(workspace);
  let authorized = true, checks = 0, denyAfter = Infinity;
  let onCheck: (count: number) => Promise<void> = async () => {};
  const partner = { workspaceMedia: (path: string | null, kind: 'audio' | 'video') => openWorkspaceMedia(workspace, path, kind), close: async () => {} } as Partner;
  const app = createWebServer(partner, directory, { authorize: async () => { checks++; await onCheck(checks); return authorized && checks <= denyAfter; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { directory, workspace, origin, url: (path: string, kind = 'audio') => `${origin}/api/chat/workspace-media?${new URLSearchParams({ kind, path })}`,
    auth: (v: boolean) => { authorized = v; }, setCheck: (fn: (count: number) => Promise<void>) => { checks = 0; onCheck = fn; }, limitChecks: (n: number) => { checks = 0; denyAfter = n; },
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('workspace media serves supported signatures and literal query paths with current contents', async () => {
  const f = await fixture();
  try {
    for (const [name, kind, bytes, mime] of [['file%20name.wav', 'audio', wav(), 'audio/wav'], ['music.mp3', 'audio', mp3(), 'audio/mpeg'], ['movie.mp4', 'video', mp4(), 'video/mp4'], ['fragmented.mp4', 'video', fragmentedMp4(), 'video/mp4']] as const) {
      await writeFile(join(f.workspace, name), bytes);
      const response = await fetch(f.url(name, kind));
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('content-length'), String(bytes.length)); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('etag') ?? '', /^W\/"[a-f0-9]{64}"$/u);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    const literal = '..%2foutside.wav'; await writeFile(join(f.workspace, literal), wav());
    assert.equal((await fetch(f.url(literal))).status, 200, 'query is decoded once; a literal percent sequence is not traversal');
    assert.equal((await fetch(f.url('../outside.wav'))).status, 404);
    await writeFile(join(f.workspace, 'file%20name.wav'), wav(128, 0x33));
    assert.deepEqual(Buffer.from(await (await fetch(f.url('file%20name.wav'))).arrayBuffer()), wav(128, 0x33));
    await rm(join(f.workspace, 'file%20name.wav'));
    assert.equal((await fetch(f.url('file%20name.wav'))).status, 404);
  } finally { await f.close(); }
});

test('MP4 rejects empty, malformed, incomplete and non-video metadata', async () => {
  const f = await fixture();
  try {
    const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
    const mdat = box('mdat', Buffer.from('<script>not video</script>'));
    const mutateType = (bytes: Buffer, type: string) => {
      const result = Buffer.from(bytes), index = result.indexOf(Buffer.from(type));
      assert.ok(index >= 0, type); result.write('xxxx', index); return result;
    };
    const zeroCount = (bytes: Buffer, type: string) => {
      const result = Buffer.from(bytes), index = result.indexOf(Buffer.from(type));
      assert.ok(index >= 0, type); result.writeUInt32BE(0, index + (type === 'stsz' ? 12 : 8)); return result;
    };
    const fragment = fragmentedMp4(), moofStart = fragment.indexOf(Buffer.from('moof')) - 4;
    assert.ok(moofStart >= 0);
    const afterMoof = moofStart + fragment.readUInt32BE(moofStart);
    const emptyMoofWithInit = Buffer.concat([fragment.subarray(0, moofStart), box('moof'), fragment.subarray(afterMoof)]);
    const emptyTrafWithInit = Buffer.concat([fragment.subarray(0, moofStart), box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf')])), fragment.subarray(afterMoof)]);
    const truncated = mp4().subarray(0, mp4().length - 1);
    const impossibleRun = fragmentedMp4();
    const runOffset = impossibleRun.indexOf(Buffer.from('trun'));
    assert.ok(runOffset >= 0); impossibleRun.writeUInt32BE(0x0f01, runOffset + 4); impossibleRun.writeUInt32BE(0xffffffff, runOffset + 8);
    const highBitType = mp4(); highBitType[4] = highBitType[4]! | 0x80;
    const tooManyBoxes = Buffer.concat([ftyp, ...Array.from({ length: 4096 }, () => box('free')), mp4().subarray(28)]);
    const malformed = Buffer.concat([ftyp, box('moov', Buffer.from([0, 0, 0, 1, 0x74, 0x72, 0x61, 0x6b])), mdat]);
    const examples = [
      Buffer.concat([ftyp, box('moov'), mdat]),
      Buffer.concat([ftyp, box('moof'), mdat]),
      Buffer.concat([ftyp, box('moov', box('free', Buffer.from('not metadata'))), mdat]),
      malformed, truncated, emptyMoofWithInit, emptyTrafWithInit,
      mutateType(mp4(), 'trak'), mutateType(mp4(), 'hdlr'), mutateType(mp4(), 'stsd'),
      zeroCount(mp4(), 'stsz'), zeroCount(mp4(), 'stco'),
      mutateType(fragmentedMp4(), 'tfhd'), zeroCount(fragmentedMp4(), 'trun'), impossibleRun, highBitType, tooManyBoxes,
    ];
    for (const [index, bytes] of examples.entries()) {
      const name = `invalid-${index}.mp4`; await writeFile(join(f.workspace, name), bytes);
      assert.equal((await fetch(f.url(name, 'video'))).status, 404, name);
    }
  } finally { await f.close(); }
});

test('single ranges, weak conditions and descriptor-version preconditions are explicit', async () => {
  const f = await fixture(), name = 'audio.wav', bytes = wav(1024);
  try {
    await writeFile(join(f.workspace, name), bytes);
    const initial = await fetch(f.url(name));
    const version = initial.headers.get('x-cfl-media-version')!, etag = initial.headers.get('etag')!;
    assert.match(version, /^[a-f0-9]{64}$/u); await initial.arrayBuffer();
    for (const [header, start, end] of [['bytes=0-9', 0, 9], ['bytes=100-', 100, bytes.length - 1], ['bytes=-13', bytes.length - 13, bytes.length - 1], ['bytes=10-99999', 10, bytes.length - 1]] as const) {
      const response = await fetch(f.url(name), { headers: { range: header, 'if-cfl-media-version': version } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1)); assert.equal(response.headers.get('x-cfl-media-version'), version);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    for (const range of ['bytes=99999-', 'bytes=0-1,3-4', 'bytes=-0', 'wat', 'bytes=20-10']) {
      const response = await fetch(f.url(name), { headers: { range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    }
    assert.equal((await fetch(f.url(name), { headers: { 'if-none-match': etag } })).status, 304);
    const ifRange = await fetch(f.url(name), { headers: { range: 'bytes=0-9', 'if-range': etag } });
    assert.equal(ifRange.status, 200); assert.equal((await ifRange.arrayBuffer()).byteLength, bytes.length);
    await writeFile(join(f.workspace, name), wav(1024, 0x21));
    const changed = await fetch(f.url(name), { headers: { range: 'bytes=0-9', 'if-cfl-media-version': version } });
    assert.equal(changed.status, 412); assert.notEqual(changed.headers.get('x-cfl-media-version'), version); assert.equal((await changed.arrayBuffer()).byteLength, 0);
    const next = await fetch(f.url(name)); const nextVersion = next.headers.get('x-cfl-media-version'); await next.arrayBuffer();
    await writeFile(join(f.workspace, 'replacement.wav'), wav(1024, 0x42)); await rename(join(f.workspace, 'replacement.wav'), join(f.workspace, name));
    assert.equal((await fetch(f.url(name), { headers: { range: 'bytes=0-9', 'if-cfl-media-version': nextVersion! } })).status, 412);
    assert.equal((await fetch(f.url(name), { headers: { 'if-none-match': etag } })).status, 200);
  } finally { await f.close(); }
});

test('authorization, exact query shape, paths and signature mismatches fail closed', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, 'good.wav'), wav()); await writeFile(join(f.directory, 'private.wav'), wav());
    await symlink(join(f.directory, 'private.wav'), join(f.workspace, 'escape.wav'));
    await symlink(f.directory, join(f.workspace, 'escape-dir'));
    await mkdir(join(f.workspace, 'directory.wav'));
    for (const [name, data] of [['bad.wav', '<html>not audio</html>'], ['bad.mp3', 'ID3<html>bad</html>'], ['bad.mp4', '<script>bad</script>'], ['wrong.wav', mp3()], ['wrong.mp3', wav()], ['wrong.mp4', wav()]] as const) await writeFile(join(f.workspace, name), data);
    const huge = await open(join(f.workspace, 'huge.wav'), 'w'); try { await huge.truncate(MAX_WORKSPACE_MEDIA_BYTES + 1); } finally { await huge.close(); }
    for (const name of ['', '../private.wav', join(f.directory, 'private.wav'), 'escape.wav', 'escape-dir/private.wav', 'directory.wav', 'bad.wav', 'bad.mp3', 'wrong.wav', 'wrong.mp3', 'huge.wav', 'x\0.wav', 'x\n.wav', 'x\\y.wav', 'https://other/good.wav']) assert.equal((await fetch(f.url(name))).status, 404, name);
    for (const name of ['bad.mp4', 'wrong.mp4']) assert.equal((await fetch(f.url(name, 'video'))).status, 404, name);
    for (const query of ['kind=audio&kind=audio&path=good.wav', 'kind=audio&path=good.wav&path=good.wav', 'kind=audio&path=good.wav&extra=1', 'kind=bad&path=good.wav', 'path=good.wav', 'kind=audio']) assert.equal((await fetch(`${f.origin}/api/chat/workspace-media?${query}`)).status, 404, query);
    assert.equal((await fetch(f.url('good.wav'), { headers: { origin: 'https://other.test' } })).status, 403);
    assert.equal((await fetch(f.url('good.wav'), { method: 'POST' })).status, 405);
    f.auth(false); assert.equal((await fetch(f.url('good.wav'))).status, 401);
  } finally { await f.close(); }
});

test('descriptor remains within workspace when a parent is swapped for an external symlink', async () => {
  const f = await fixture(); let stop = false;
  await mkdir(join(f.workspace, 'media')); await mkdir(join(f.directory, 'outside'));
  await writeFile(join(f.workspace, 'media', 'audio.wav'), wav(128, 0x11)); await writeFile(join(f.directory, 'outside', 'audio.wav'), wav(128, 0xee));
  const moving = (async () => { while (!stop) { await rename(join(f.workspace, 'media'), join(f.workspace, 'held')); await symlink(join(f.directory, 'outside'), join(f.workspace, 'media')); await rm(join(f.workspace, 'media')); await rename(join(f.workspace, 'held'), join(f.workspace, 'media')); } })();
  try {
    for (let i = 0; i < 100; i++) { const file = await openWorkspaceMedia(f.workspace, 'media/audio.wav', 'audio'); if (file) { try { const bytes = Buffer.alloc(file.size); await file.handle.read(bytes, 0, bytes.length, 0); assert.deepEqual(bytes, wav(128, 0x11)); } finally { await file.close(); } } }
  } finally { stop = true; await moving; await f.close(); }
});

test('disconnect and authorization revocation stop bounded streaming', async () => {
  const f = await fixture(); const name = 'large.wav';
  try {
    await writeFile(join(f.workspace, name), wav(8 * 1024 * 1024));
    const full = await fetch(f.url(name));
    assert.equal(full.status, 200); assert.equal((await full.arrayBuffer()).byteLength, 44 + 8 * 1024 * 1024);
    const controller = new AbortController(); const response = await fetch(f.url(name), { signal: controller.signal });
    const reader = response.body!.getReader(); assert.equal((await reader.read()).done, false); controller.abort();
    await reader.cancel().catch(() => {});
    // Deny after initial admission and some streaming checks; no complete body may be delivered.
    f.limitChecks(8); let received = 0;
    try { const limited = await fetch(f.url(name)); if (limited.body) { const stream = limited.body.getReader(); for (;;) { const part = await stream.read(); if (part.done) break; received += part.value.length; } } } catch {}
    assert.ok(received < 8 * 1024 * 1024);
    f.limitChecks(Infinity);
    const retry = await fetch(f.url(name), { headers: { range: 'bytes=0-43' } }); assert.equal(retry.status, 206); assert.equal((await retry.arrayBuffer()).byteLength, 44);
  } finally { await f.close(); }
});

test('a file changed between chunk reads terminates the response', async () => {
  const f = await fixture(); const name = 'changing.wav'; const total = 4 * 1024 * 1024;
  try {
    await writeFile(join(f.workspace, name), wav(total));
    f.setCheck(async count => { if (count === 8) await writeFile(join(f.workspace, name), wav(total, 0x24)); });
    let received = 0;
    try {
      const response = await fetch(f.url(name));
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      for (;;) { const part = await reader.read(); if (part.done) break; received += part.value.length; }
    } catch { /* The partial response is deliberately destroyed on mutation. */ }
    assert.ok(received < total, 'a changing descriptor cannot complete the old response');
    f.setCheck(async () => {});
    const current = await fetch(f.url(name), { headers: { range: 'bytes=44-51' } });
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), Buffer.alloc(8, 0x24));
  } finally { await f.close(); }
});

test('a sparse file at the 256 MiB limit supports a bounded end range', async () => {
  const f = await fixture();
  try {
    const file = await open(join(f.workspace, 'boundary.wav'), 'w');
    try {
      const header = wav(2).subarray(0, 44);
      header.writeUInt32LE(MAX_WORKSPACE_MEDIA_BYTES - 8, 4);
      header.writeUInt32LE(MAX_WORKSPACE_MEDIA_BYTES - 44, 40);
      await file.write(header, 0, header.length, 0);
      await file.truncate(MAX_WORKSPACE_MEDIA_BYTES);
    } finally { await file.close(); }
    const response = await fetch(f.url('boundary.wav'), { headers: { range: 'bytes=-16' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${MAX_WORKSPACE_MEDIA_BYTES - 16}-${MAX_WORKSPACE_MEDIA_BYTES - 1}/${MAX_WORKSPACE_MEDIA_BYTES}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(16));
  } finally { await f.close(); }
});
