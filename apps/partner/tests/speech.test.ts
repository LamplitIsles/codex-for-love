import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { transcribeAudio } from '../runtime/speech.ts';

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
