import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { receiveElevenLabsAudio } from '../runtime/elevenlabs-audio.ts';

const audio = Buffer.alloc(417); audio.set([0xff, 0xfb, 0x90, 0x00]);
const url = 'https://elevenlabsusercontent.com/test-audio';
const signal = new AbortController().signal;

const padded = Buffer.from(audio); padded[2] |= 0x02;
const paddedFrame = Buffer.concat([padded, Buffer.alloc(1)]);
const id3v1 = Buffer.alloc(128); id3v1.write('TAG');
const id3v23 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
const id3v24Footer = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 0, 0x33, 0x44, 0x49, 4, 0, 0x10, 0, 0, 0, 0]);

test('accepts a complete MP3 and same-host HTTPS redirects', async () => {
  let calls = 0;
  const result = await receiveElevenLabsAudio(url, signal, async (_input, init) => {
    assert.equal(init?.redirect, 'manual'); calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { location: '/next' } }) : new Response(audio);
  });
  assert.deepEqual(result, audio); assert.equal(calls, 2);
});

test('accepts complete multi-frame MP3 with supported ID3 metadata and frame padding', async () => {
  for (const prefix of [Buffer.alloc(0), id3v23, id3v24Footer]) {
    for (const suffix of [Buffer.alloc(0), id3v1]) {
      const bytes = Buffer.concat([prefix, audio, paddedFrame, audio, suffix]);
      assert.deepEqual(await receiveElevenLabsAudio(url, signal, async () => new Response(bytes)), bytes);
    }
  }
});

test('accepts encoded synthetic multi-frame MP3 with ID3v2 and optional ID3v1', async () => {
  // 700 Hz synthetic sine, generated with FFmpeg/libmp3lame and ID3v2.4.
  const encoded = await readFile(new URL('./fixtures/synthetic-tone.mp3', import.meta.url));
  for (const bytes of [encoded, Buffer.concat([encoded, id3v1])]) {
    assert.deepEqual(await receiveElevenLabsAudio(url, signal, async () => new Response(bytes)), bytes);
  }
  await assert.rejects(receiveElevenLabsAudio(url, signal, async () => new Response(encoded.subarray(0, encoded.length - 1))));
});

test('rejects truncated or corrupt later frames and malformed metadata without accepting a valid prefix', async () => {
  const badHeader = Buffer.from(audio); badHeader[1] = 0;
  const badFooter = Buffer.from(id3v24Footer); badFooter[10] = 0;
  const invalidFlags = Buffer.from(id3v23); invalidFlags[5] = 0x10;
  const missingTagBytes = Buffer.from(id3v23); missingTagBytes[9] = 127;
  const changedRate = Buffer.from(audio); changedRate[2] = 0x94;
  for (const bytes of [
    Buffer.concat([audio, audio.subarray(0, 100)]), Buffer.concat([audio, Buffer.from('garbage')]),
    Buffer.concat([audio, badHeader]), Buffer.concat([audio, changedRate]),
    Buffer.concat([badFooter, audio]), Buffer.concat([invalidFlags, audio]),
    Buffer.concat([missingTagBytes, audio]), Buffer.concat([id3v23, id3v1]),
  ]) {
    await assert.rejects(receiveElevenLabsAudio(url, signal, async () => new Response(bytes)));
  }
});

test('rejects unsafe URLs, cross-host redirects, invalid and oversized media', async () => {
  for (const unsafe of ['http://elevenlabsusercontent.com/a', 'https://elevenlabsusercontent.com.evil.invalid/a', 'https://user@elevenlabsusercontent.com/a', 'https://127.0.0.1/a']) {
    await assert.rejects(receiveElevenLabsAudio(unsafe, signal, async () => { throw new Error('unexpected fetch'); }));
  }
  let calls = 0;
  await assert.rejects(receiveElevenLabsAudio(url, signal, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/a' } }); }));
  assert.equal(calls, 1);
  for (const body of [Buffer.from('ID3'), Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    await assert.rejects(receiveElevenLabsAudio(url, signal, async () => new Response(body)));
  }
  await assert.rejects(receiveElevenLabsAudio(url, signal, async () => new Response(audio, { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } })));
  await assert.rejects(receiveElevenLabsAudio(url, signal, async () => new Response(null, { status: 302, headers: { location: '/loop' } })));
  await assert.rejects(receiveElevenLabsAudio(url, AbortSignal.abort(), async () => { throw new Error('unexpected fetch'); }));
});
