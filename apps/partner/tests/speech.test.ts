import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { synthesizeSpeech, transcribeAudio } from '../runtime/speech.ts';
import { parseTtsSegments } from '../src/lib/companion/tts.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';

test('STT forwards bounded audio, preserves recognized emotion and never admits a model turn', async () => {
  const f = await fixture(); let calls = 0;
  const upstream = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls++;
    assert.equal(request.headers.authorization, 'Bearer fixture-speech');
    assert.equal(body.model, 'qwen3-asr-flash');
    assert.equal(body.input.messages[0].content[0].audio, 'data:audio/webm;codecs=opus;base64,AQID');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ output: { choices: [{ message: { content: [{ text: ' 今天下雨了。 ' }], annotations: [{ emotion: 'happy' }] } }] } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  f.config.speech = { endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }; f.credentials.speech = 'fixture-speech';
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/voice/transcribe`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'audio/webm;codecs=opus' }, body: new Uint8Array([1,2,3]) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: '今天下雨了。', expression: 'happy' });
    assert.equal((await partner.snapshot()).speech, true);
    assert.equal((await partner.snapshot()).messages.length, 0); assert.equal((await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length, 0);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'invalid' })).status, 415);
    assert.equal(calls, 1);
    const aborted = AbortSignal.abort();
    await assert.rejects(transcribeAudio(f.config.speech.endpoint, 'fixture', new Uint8Array([1]), 'audio/wav', aborted));
    await assert.rejects(transcribeAudio(f.config.speech.endpoint, 'fixture', new Uint8Array(8 * 1024 * 1024), 'audio/wav', new AbortController().signal));
    assert.equal(calls, 1);
  } finally { await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await f.close(); }
});

test('voice drafts preserve transcript and allowlisted expression without inventing unknown emotions', async () => {
  const { formatVoiceTurn } = await import('../src/lib/companion/client/voice-input.ts');
  for (const [emotion, expected] of [[' HAPPY ', 'happy'], ['unknown', undefined], [null, undefined]]) {
    const result = await transcribeAudio('http://fixture.invalid', 'fixture', new Uint8Array([1]), 'audio/wav', new AbortController().signal,
      async () => Response.json({ output: { choices: [{ message: { content: [{ text: '你好' }], annotations: [{ emotion }] } }] } }));
    assert.equal(result.expression, expected);
    assert.equal(formatVoiceTurn(result), expected ? '🎙️ 你好 [happy]' : '🎙️ 你好');
  }
});

test('tagged TTS preserves surrounding prose and leaves invalid or fenced tags as text', async () => {
  assert.deepEqual(parseTtsSegments('before [[tts:text]] hello\nfriend [[/tts:text]] after'), [{ kind: 'text', text: 'before ' }, { kind: 'voice', text: 'hello friend' }, { kind: 'text', text: ' after' }]);
  for (const text of ['[[tts:text]]unclosed', '[[tts:text]]a[[/tts:text]] [[tts:text]]b[[/tts:text]]', '```\n[[tts:text]]no[[/tts:text]]\n```', `[[tts:text]]${'x'.repeat(241)}[[/tts:text]]`]) assert.deepEqual(parseTtsSegments(text), [{ kind: 'text', text }]);
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-audio-test-')); let calls = 0;
  try {
    const options = { endpoint: 'http://fixture.invalid', provider: 'alibaba' as const, model: 'qwen3-tts-flash', voice: 'Cherry', credential: 'fixture', text: 'hello', audioDir: directory,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => { calls += 1; assert.deepEqual(JSON.parse(String(init?.body)), { model: 'qwen3-tts-flash', input: { text: 'hello', voice: calls === 1 ? 'Cherry' : 'Ryan', language_type: 'Chinese' }, parameters: { format: 'mp3' }, stream: false }); return Response.json({ output: { audio: { data: 'SUQz' } } }); } };
    const first = await synthesizeSpeech(options); const again = await synthesizeSpeech(options);
    assert.equal(first, again); assert.equal(calls, 1);
    const changed = await synthesizeSpeech({ ...options, voice: 'Ryan' });
    assert.notEqual(changed, first); assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ByteDance uses its SSE protocol and one cache miss is single-flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-audio-test-')); let calls = 0;
  try {
    const options = { endpoint: 'ignored', provider: 'bytedance' as const, model: 'seed-tts-2.0', voice: 'voice', credential: 'secret', text: '你好', audioDir: directory, fetchImpl: async (url: string | URL | Request, init?: RequestInit) => { calls += 1; assert.equal(String(url), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'); const headers = new Headers(init?.headers); assert.equal(headers.get('x-api-key'), 'secret'); assert.equal(headers.get('x-api-resource-id'), 'seed-tts-2.0'); assert.deepEqual(JSON.parse(String(init?.body)), { user: { uid: 'dsh-speech' }, req_params: { text: '你好', speaker: 'voice', audio_params: { format: 'mp3', sample_rate: 24000 } } }); await new Promise(resolve => setTimeout(resolve, 15)); return new Response('event: 352\ndata: {"code":0,"data":"SUQ="}\n\ndata: {"code":0,"data":"M0E="}\n\ndata: {"code":20000000}\n', { headers: { 'content-type': 'text/event-stream' } }); } };
    const [first, second] = await Promise.all([synthesizeSpeech(options), synthesizeSpeech(options)]); assert.equal(first, second); assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('synthesis forwards cancellation to a hanging provider without publishing audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-audio-test-')); const controller = new AbortController(); let observed = false;
  try {
    const work = synthesizeSpeech({ endpoint: 'http://fixture.invalid', provider: 'alibaba', model: 'qwen3-tts-flash', voice: 'Maia', credential: 'fixture', text: 'wait', audioDir: directory, signal: controller.signal, fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { const abort = () => { observed = true; reject(new DOMException('aborted', 'AbortError')); }; if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true }); }) });
    controller.abort(); await assert.rejects(work); assert.equal(observed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential CLI accepts non-printing tts stdin credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-cli-test-')); const config = join(directory, 'partner.toml');
  try {
    await writeFile(config, `name = "test"\npersona = "persona.md"\nstate = "state"\n`);
    const result = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => { const child = spawn(process.execPath, ['runtime/cli.ts', 'credential', config, 'tts', '--stdin'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] }); let out=''; let err=''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data); child.once('error', reject); child.once('close', code => resolve({ out, err, code })); child.stdin.end('test-tts-secret\n'); });
    assert.equal(result.code, 0); assert.match(result.out, /Credential saved/); assert.doesNotMatch(result.out + result.err, /test-tts-secret/); assert.deepEqual(JSON.parse(await readFile(join(directory, 'state', 'credentials.json'), 'utf8')), { tts: 'test-tts-secret' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('oversized messages are rejected before admission with a definite validation response', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), input: 'a'.repeat(16001) }),
    });
    assert.equal(response.status, 422); assert.equal((await response.json()).code, 'invalid_message');
    assert.equal((await partner.snapshot()).messages.length, 0); assert.equal((await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length, 0);
  } finally { await app.close(); await f.close(); }
});
