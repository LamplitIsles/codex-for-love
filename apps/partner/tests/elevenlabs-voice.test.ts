import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAppServerClient } from '@jaminzhou/codex-app-server-client';
import { elevenLabsSpeech } from '../runtime/elevenlabs-voice.ts';
import { synthesizeSpeech } from '../runtime/speech.ts';

const threadId = '12345678-1234-1234-1234-123456789abc';
const start = { flow_id: 'flow', session_ids: ['session'], results: [{ success: true, session_id: 'session' }], summary: { generations_started: 1, failed: 0 }, pending: [{ generation_id: 'generation', kind: 'audio' }], poll_after_seconds: 0 };
const completed = { flow_id: 'flow', session_id: 'session', session_ids: ['session'], all_completed: true, has_failures: false, generations: [{ id: 'generation', status: 'completed', modality: 'audio', model_id: 'eleven_v4', content_url: 'https://elevenlabsusercontent.com/fake' }] };
const audio = Buffer.alloc(417); audio.set([0xff, 0xfb, 0x90, 0]);

async function fixture(run: (ctx: { workspace: string; audioDir: string }) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'cfl-elevenlabs-'));
  await mkdir(join(workspace, '.lamplit'));
  await writeFile(join(workspace, '.lamplit/thread.json'), JSON.stringify({ threadId }));
  try { await run({ workspace, audioDir: join(workspace, '.lamplit/audio') }); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

test('one generation, read-only polling, cache and concurrent callers', async () => fixture(async ({ workspace, audioDir }) => {
  const calls: any[] = []; let closes = 0;
  const client = { connect: async () => ({}), close: async () => { closes++; }, call: async (_method: string, request: any) => {
    calls.push(request);
    const content = calls.length === 1 ? start : calls.length === 2 ? { ...completed, all_completed: false, generations: [{ id: 'generation', status: 'unverified-intermediate' }] } : completed;
    return { isError: false, structuredContent: content };
  } } as unknown as CodexAppServerClient;
  const options = { provider: 'elevenlabs' as const, voice: 'fake-voice', text: ' hello ', audioDir, elevenLabs: (text: string, signal: AbortSignal) => elevenLabsSpeech({ workspace, voice: 'fake-voice', text, signal, clientFactory: () => client, fetchImpl: async () => new Response(audio) }) };
  const [first, second] = await Promise.all([synthesizeSpeech(options), synthesizeSpeech(options)]);
  assert.equal(first, second); assert.equal(await synthesizeSpeech(options), first); assert.equal(closes, 1);
  assert.deepEqual(calls.map(x => x.tool), ['creative_generate_speech', 'creative_get_flow_run_status', 'creative_get_flow_run_status']);
  assert.deepEqual(calls[0], { threadId, server: 'elevenlabs', tool: 'creative_generate_speech', arguments: { prompt: 'hello', model_id: 'eleven_v4', voice_id: 'fake-voice', context: 'Generate a short voice message', generations_count: 1 } });
  assert.deepEqual(calls[1].arguments, { flow_id: 'flow', session_ids: ['session'], context: 'Check the short voice message' });
  assert.deepEqual(await readdir(audioDir), [`${first}.mp3`]);
}));

test('uncertain generation and invalid completed results never retry or publish', async () => fixture(async ({ workspace, audioDir }) => {
  for (const response of [null, { ...completed, has_failures: true }, { ...completed, generations: [{ ...completed.generations[0], modality: 'text' }] }, { ...completed, generations: [{ ...completed.generations[0], content_url: 'https://invalid.example/audio' }] }]) {
    let calls = 0; let closes = 0;
    const client = { connect: async () => ({}), close: async () => { closes++; }, call: async () => { calls++; if (!response) throw new Error('unknown submission'); return { structuredContent: calls === 1 ? start : response }; } } as unknown as CodexAppServerClient;
    await assert.rejects(synthesizeSpeech({ provider: 'elevenlabs', voice: 'fake', text: 'failed', audioDir, elevenLabs: (text, signal) => elevenLabsSpeech({ workspace, text, voice: 'fake', signal, clientFactory: () => client }) }));
    assert.equal(calls, response ? 2 : 1); assert.equal(closes, 1);
    assert.deepEqual(await readdir(audioDir), []);
  }
}));

test('a truncated subsequent MP3 frame is never published or regenerated', async () => fixture(async ({ workspace, audioDir }) => {
  let calls = 0;
  const client = { connect: async () => ({}), close: async () => {}, call: async () => ({ structuredContent: ++calls === 1 ? start : completed }) } as unknown as CodexAppServerClient;
  const truncated = Buffer.concat([audio, audio.subarray(0, 100)]);
  await assert.rejects(synthesizeSpeech({ provider: 'elevenlabs', voice: 'fake', text: 'truncated', audioDir,
    elevenLabs: (text, signal) => elevenLabsSpeech({ workspace, text, voice: 'fake', signal, clientFactory: () => client, fetchImpl: async () => new Response(truncated) }) }));
  assert.equal(calls, 2); assert.deepEqual(await readdir(audioDir), []);
}));

test('cancellation closes the second connection and publishes no audio', async () => fixture(async ({ workspace, audioDir }) => {
  const controller = new AbortController(); let closes = 0;
  const client = { connect: async () => ({}), close: async () => { closes++; }, call: async () => { controller.abort(); return { structuredContent: start }; } } as unknown as CodexAppServerClient;
  await assert.rejects(synthesizeSpeech({ provider: 'elevenlabs', voice: 'fake', text: 'cancel', audioDir, signal: controller.signal, elevenLabs: (text, signal) => elevenLabsSpeech({ workspace, text, voice: 'fake', signal, clientFactory: () => client }) }));
  assert.ok(closes >= 1); assert.deepEqual(await readdir(audioDir), []);
}));

test('missing thread and unauthorized MCP fail without generation or publication', async () => fixture(async ({ workspace, audioDir }) => {
  let calls = 0; let closes = 0;
  const client = { connect: async () => ({}), close: async () => { closes++; }, call: async () => { calls++; return { isError: true }; } } as unknown as CodexAppServerClient;
  const run = () => synthesizeSpeech({ provider: 'elevenlabs', voice: 'fake', text: 'not authorized', audioDir, elevenLabs: (text, signal) => elevenLabsSpeech({ workspace, text, voice: 'fake', signal, clientFactory: () => client }) });
  await writeFile(join(workspace, '.lamplit/thread.json'), JSON.stringify({ threadId: 'invalid' }));
  await assert.rejects(run()); assert.equal(calls, 0);
  await writeFile(join(workspace, '.lamplit/thread.json'), JSON.stringify({ threadId }));
  await assert.rejects(run()); assert.equal(calls, 1); assert.equal(closes, 1);
  assert.deepEqual(await readdir(audioDir), []);
}));

test('a timeout during an uncertain generation closes the connection without retry', async () => fixture(async ({ workspace, audioDir }) => {
  const controller = new AbortController(); let calls = 0; let rejectCall: (error: Error) => void = () => {};
  const client = { connect: async () => ({}), close: async () => { rejectCall(new Error('closed')); }, call: async () => { calls++; return new Promise((_resolve, reject) => { rejectCall = reject; controller.abort(); }); } } as unknown as CodexAppServerClient;
  await assert.rejects(synthesizeSpeech({ provider: 'elevenlabs', voice: 'fake', text: 'timeout', audioDir, signal: controller.signal, elevenLabs: (text, signal) => elevenLabsSpeech({ workspace, text, voice: 'fake', signal, clientFactory: () => client }) }));
  assert.equal(calls, 1); assert.deepEqual(await readdir(audioDir), []);
}));

test('cancelling a concurrent waiter does not return another caller’s result', async () => fixture(async ({ audioDir }) => {
  let release: () => void = () => {}; let started: () => void = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const options = { provider: 'elevenlabs' as const, voice: 'fake', text: 'shared', audioDir, elevenLabs: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return audio; } };
  const first = synthesizeSpeech(options); await entered;
  const controller = new AbortController();
  const second = synthesizeSpeech({ ...options, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort();
  await assert.rejects(second); release(); await first;
}));
