import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevenLabsSpeech, elevenLabsVoices } from '../runtime/elevenlabs-voice.ts';
import { VoicesClient } from '@elevenlabs/elevenlabs-js/api/resources/voices/client/Client.js';
import { synthesizeSpeech } from '../runtime/speech.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const audio = Buffer.alloc(417); audio.set([0xff, 0xfb, 0x90, 0x00]);
const signal = new AbortController().signal;
test('SDK sends one v4 request with exact voice and output, then caches validated audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tts-sdk-')); let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/text-to-speech/voice-id');
    assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'hello', model_id: 'eleven_v4' });
    return new Response(audio);
  };
  try {
    const options = { provider: 'elevenlabs' as const, voice: 'voice-id', text: 'hello', audioDir: directory, elevenLabs: (text: string, signal: AbortSignal) => elevenLabsSpeech({ apiKey: 'fixture-key', text, voice: 'voice-id', signal, fetchImpl }) };
    assert.equal(await synthesizeSpeech(options), await synthesizeSpeech(options)); assert.equal(calls, 1);
    await assert.rejects(elevenLabsSpeech({apiKey:'fixture',text:'x',voice:'v',signal,fetchImpl:async () => new Response(audio.subarray(0,100))}));
    await assert.rejects(elevenLabsSpeech({apiKey:'fixture',text:'x',voice:'v',signal,fetchImpl:async () => new Response(Buffer.alloc(10*1024*1024+1))}));
    await assert.rejects(elevenLabsSpeech({apiKey:'fixture',text:'x',voice:'v',signal:AbortSignal.abort(),fetchImpl:async () => { throw new Error('unexpected'); }}));
    const controller = new AbortController();
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const hanging = elevenLabsSpeech({apiKey:'fixture',text:'x',voice:'v',signal:controller.signal,fetchImpl:async () => new Response(new ReadableStream({start() { began(); }}))});
    await started; controller.abort(); await assert.rejects(hanging);
    let failures = 0;
    await assert.rejects(elevenLabsSpeech({apiKey:'fixture',text:'x',voice:'v',signal,fetchImpl:async () => { failures++; return new Response('failed', {status: 503}); }}));
    assert.equal(failures, 1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('voice search requests saved voices and maps bounded pages only', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async input => {
    calls++; const url = new URL(String(input));
    assert.equal(url.pathname,'/v2/voices'); assert.equal(url.searchParams.get('voice_type'),'saved');
    assert.equal(url.searchParams.get('page_size'),'50');
    assert.equal(url.searchParams.get('next_page_token'), calls === 1 ? null : 'next');
    return Response.json({ voices: calls === 1 ? [{voice_id:'id',name:'name',category:'cloned'}] : [], has_more: calls === 1, next_page_token: calls === 1 ? 'next' : null, total_count: 1 });
  };
  assert.deepEqual(await elevenLabsVoices('fixture',undefined,fetchImpl),{voices:[{id:'id',name:'name'}],nextCursor:'next'});
  assert.deepEqual(await elevenLabsVoices('fixture','next',fetchImpl),{voices:[],nextCursor:null});
  await assert.rejects(elevenLabsVoices('',undefined,fetchImpl));
  await assert.rejects(elevenLabsVoices('fixture',undefined,async () => new Response('denied',{status:403})));
  await assert.rejects(elevenLabsVoices('fixture',undefined,async () => Response.json({voices:[{voice_id:'',name:'x'}],has_more:false,total_count:1})));
});

test('voice search rejects missing or invalid next tokens while more pages exist', async () => {
  const base = { voices: [], has_more: true, total_count: 0 };
  for (const page of [
    { ...base, next_page_token: null },
    base,
    { ...base, next_page_token: '' },
    { ...base, next_page_token: 'bad\nvalue' },
    { ...base, next_page_token: 'x'.repeat(2049) },
    { ...base, next_page_token: 42 },
  ]) {
    await assert.rejects(elevenLabsVoices('fixture', undefined, async () => Response.json(page)));
  }
  assert.deepEqual(await elevenLabsVoices('fixture', undefined, async () => Response.json({ ...base, has_more: false, next_page_token: null })), { voices: [], nextCursor: null });
});

test('SDK voice results require a valid next token whenever hasMore is true', async t => {
  let result: Record<string, unknown> = {};
  t.mock.method(VoicesClient.prototype, 'search', (() => Promise.resolve(result)) as never);
  for (const token of [null, undefined, '', 'bad\nvalue', 'x'.repeat(2049), 42]) {
    result = { voices: [], hasMore: true, nextPageToken: token };
    await assert.rejects(elevenLabsVoices('fixture'), /Invalid cursor/);
  }
  result = { voices: [], hasMore: true };
  await assert.rejects(elevenLabsVoices('fixture'), /Invalid cursor/);
  result = { voices: [], hasMore: true, nextPageToken: 'next' };
  assert.deepEqual(await elevenLabsVoices('fixture'), { voices: [], nextCursor: 'next' });
  result = { voices: [], hasMore: false, nextPageToken: null };
  assert.deepEqual(await elevenLabsVoices('fixture'), { voices: [], nextCursor: null });
});
