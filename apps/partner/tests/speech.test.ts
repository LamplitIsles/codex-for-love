import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { synthesizeSpeech } from '../runtime/speech.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';

test('provider synthesis caches provider and voice identities', async () => {
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

test('MiniMax uses a noninteractive selected-voice command and validates its output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-minimax-test-')); let command: unknown[] = [];
  try {
    const exec = (async (file: string, args: readonly string[] | null | undefined, options: unknown) => { command = [file, args, options]; const values = args as string[]; await writeFile(String(values[values.indexOf('--out') + 1]), 'ID3'); return { stdout: '', stderr: '' }; }) as never;
    const id = await synthesizeSpeech({ provider: 'minimax', voice: 'Chinese (Mandarin)_Soft_Girl', speed: 1.15, text: '你好', audioDir: directory, execFileImpl: exec });
    assert.equal(id.length, 64); assert.deepEqual((command[1] as string[]).slice(0, 11), ['--non-interactive', 'speech', 'synthesize', '--model', 'speech-2.8-hd', '--text', '你好', '--voice', 'Chinese (Mandarin)_Soft_Girl', '--speed', '1.15']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ByteDance uses its SSE protocol and one cache miss is single-flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-audio-test-')); let calls = 0;
  try {
    const options = { endpoint: 'ignored', provider: 'bytedance' as const, model: 'seed-tts-2.0', voice: 'voice', speed: 1.15, credential: 'secret', text: '你好', audioDir: directory, fetchImpl: async (url: string | URL | Request, init?: RequestInit) => { calls += 1; assert.equal(String(url), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'); const headers = new Headers(init?.headers); assert.equal(headers.get('x-api-key'), 'secret'); assert.equal(headers.get('x-api-resource-id'), 'seed-tts-2.0'); assert.deepEqual(JSON.parse(String(init?.body)), { user: { uid: 'dsh-speech' }, req_params: { text: '你好', speaker: 'voice', audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 15 } } }); await new Promise(resolve => setTimeout(resolve, 15)); return new Response('event: 352\ndata: {"code":0,"data":"SUQ="}\n\ndata: {"code":0,"data":"M0E="}\n\ndata: {"code":20000000}\n', { headers: { 'content-type': 'text/event-stream' } }); } };
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
    await writeFile(config, `name = "test"\nprompts = { persona = "persona.md" }\nstate = "state"\n`);
    const result = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => { const child = spawn(process.execPath, ['runtime/cli.ts', 'credential', config, 'tts', '--stdin'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] }); let out=''; let err=''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data); child.once('error', reject); child.once('close', code => resolve({ out, err, code })); child.stdin.end('test-tts-secret\n'); });
    assert.equal(result.code, 0); assert.match(result.out, /Credential saved/); assert.doesNotMatch(result.out + result.err, /test-tts-secret/); assert.deepEqual(JSON.parse(await readFile(join(directory, 'state', 'credentials.json'), 'utf8')), { tts: 'test-tts-secret' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('oversized messages are rejected before admission with a definite validation response', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    await assert.rejects(partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'a'.repeat(16001) }));
    assert.equal((await partner.snapshot()).messages.length, 0); assert.equal((await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length, 0);
  } finally { await app.close(); await f.close(); }
});

test('removed whole-audio route returns authenticated no-store 404 without native admission', async () => {
  const f = await fixture();
  f.config.speech = {}; f.credentials.speech = 'legacy-stream-and-tts-key';
  const partner = await f.createPartner();
  let allowed = true;
  const app = createWebServer(partner,join(f.directory,'assets'),{authorize:async()=>allowed});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const oldRoute = () => fetch(`${origin}/api/voice/transcribe`,{method:'POST',headers:{origin,'content-type':'audio/webm'},body:'retired'});
  try {
    for (const method of ['GET','POST']) {
      const response = method === 'POST' ? await oldRoute() : await fetch(`${origin}/api/voice/transcribe`);
      assert.equal(response.status,404);
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    allowed = false;
    assert.equal((await oldRoute()).status,401);
    allowed = true;
    assert.deepEqual(await (await fetch(`${origin}/api/voice/capability`)).json(),{available:true});
    assert.equal(partner.voiceCredential(),'legacy-stream-and-tts-key');
    assert.equal((await f.requests()).some(value=>value.method==='turn/start' || value.method==='turn/steer'),false);
  } finally { await app.close(); await f.close(); }
});
