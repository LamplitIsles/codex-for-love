import { MAX_MESSAGE_LENGTH } from "../src/lib/message-input.ts";
import { normalizeVoiceExpression, normalizeVoiceMediaType, MAX_VOICE_DATA_URL_BYTES } from '../src/lib/companion/voice-contract.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64 * 1024;
const pending = new Map<string, Promise<string>>();
const BTD_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
function decode(value: string): Uint8Array | undefined { const source = value.replace(/^data:[^;,]+;base64,/u, ''); if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(source) || source.length % 4 === 1) return; return new Uint8Array(Buffer.from(source, 'base64')); }
async function bounded(response: Response, limit: number): Promise<Uint8Array> { if (!response.body) throw new Error('Missing provider response'); const parts: Uint8Array[]=[]; let total=0; for await (const part of response.body as any as AsyncIterable<Uint8Array>) { total += part.byteLength; if (total > limit) throw new Error('Provider response too large'); parts.push(part); } return Buffer.concat(parts); }
async function provider(options: { endpoint: string; provider: 'alibaba' | 'bytedance'; model: string; voice: string; credential: string; text: string; signal: AbortSignal; fetchImpl: typeof fetch }): Promise<Uint8Array> {
  const init: RequestInit = options.provider === 'alibaba' ? { method:'POST', signal:options.signal, headers:{ authorization:`Bearer ${options.credential}`, 'content-type':'application/json' }, body:JSON.stringify({ model:options.model, input:{ text:options.text, voice:options.voice, language_type:'Chinese' }, parameters:{ format:'mp3' }, stream:false }) } : { method:'POST', signal:options.signal, headers:{ accept:'text/event-stream', 'content-type':'application/json', 'X-Api-Key':options.credential, 'X-Api-Resource-Id':options.model }, body:JSON.stringify({ user:{uid:'dsh-speech'}, req_params:{ text:options.text, speaker:options.voice, audio_params:{format:'mp3',sample_rate:24000} } }) };
  const response = await options.fetchImpl(options.provider === 'bytedance' ? BTD_ENDPOINT : options.endpoint, init); if (!response.ok) throw new Error('Speech provider rejected the request'); const raw=await bounded(response,MAX_RESPONSE_BYTES);
  if (options.provider === 'alibaba') { const audio=(JSON.parse(new TextDecoder().decode(raw)) as any)?.output?.audio; let bytes=audio?.data ? decode(audio.data) : undefined; if (!bytes && audio?.url) { const r=await options.fetchImpl(audio.url,{signal:options.signal}); if (!r.ok) throw new Error('Invalid provider audio'); bytes=await bounded(r,MAX_AUDIO_BYTES); } if (!bytes?.byteLength || bytes.byteLength>MAX_AUDIO_BYTES) throw new Error('Invalid provider audio'); return bytes; }
  const chunks: Uint8Array[]=[]; let total=0; for (const line of new TextDecoder().decode(raw).split(/\r?\n/u)) { if (!line.trim() || line.startsWith('event:')) continue; if (!line.startsWith('data:')) throw new Error('Invalid provider response'); const frame=JSON.parse(line.slice(5)) as {code:number;data?:string}; if (frame.code===0 && frame.data) { const b=decode(frame.data); if (!b || (total+=b.byteLength)>MAX_AUDIO_BYTES) throw new Error('Invalid provider audio'); chunks.push(b); } else if (frame.code!==0 && frame.code!==20000000) throw new Error('Speech provider rejected the request'); } const bytes=Buffer.concat(chunks); if (!bytes.byteLength) throw new Error('Invalid provider audio'); return bytes;
}
export async function synthesizeSpeech(options: { endpoint: string; provider: 'alibaba' | 'bytedance'; model: string; voice: string; credential: string; text: string; audioDir: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<string> {
  const text=options.text.replace(/[\s\u00a0]+/gu,' ').trim(); if (!text || Array.from(text).length>240) throw new Error('Invalid speech passage'); const key=createHash('sha256').update(JSON.stringify([2,options.provider,options.model,options.voice,text])).digest('hex'); const path=join(options.audioDir,`${key}.mp3`); try { const bytes=await readFile(path); if (bytes.byteLength) return key; } catch {} if (pending.has(path)) return pending.get(path)!;
  const task=(async()=>{ const signal=AbortSignal.any([options.signal ?? new AbortController().signal,AbortSignal.timeout(60000)]); const bytes=await provider({...options,text,signal,fetchImpl:options.fetchImpl??fetch}); await mkdir(options.audioDir,{recursive:true}); const temp=join(options.audioDir,`.${randomUUID()}.tmp`); try { await writeFile(temp,bytes,{mode:0o600,flag:'wx'}); await rename(temp,path); } finally { await unlink(temp).catch(()=>undefined); } return key; })(); pending.set(path,task); try{return await task;} finally { if(pending.get(path)===task) pending.delete(path); }
}

/** Qwen short-audio STT protocol adapted from dsh-speech; no synthesis path. */
export async function transcribeAudio(endpoint: string, credential: string, data: Uint8Array, mediaType: string,
  signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ text: string; expression?: import('../src/lib/companion/voice-contract.ts').VoiceExpression }> {
  const normalized = normalizeVoiceMediaType(mediaType);
  if (!normalized || !data.byteLength) throw new Error('Invalid audio');
  const audio = `data:${normalized};base64,${Buffer.from(data).toString('base64')}`;
  if (audio.length > MAX_VOICE_DATA_URL_BYTES) throw new Error('Audio is too large');
  signal.throwIfAborted();
  const response = await fetchImpl(endpoint, { method: 'POST', signal,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-asr-flash', input: { messages: [{ role: 'user', content: [{ audio }] }] },
      parameters: { asr_options: { enable_itn: true } }, stream: false }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Transcription provider rejected the request'); }
  if (!response.body) throw new Error('Missing transcription');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 1024 * 1024) throw new Error('Transcription response is too large'); chunks.push(value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const content = result?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content) || !content.length || content.some((part) => typeof part?.text !== 'string')) throw new Error('Invalid transcription');
  const text = content.map((part) => part.text).join('').trim();
  if (!text || text.length > MAX_MESSAGE_LENGTH) throw new Error('Empty or oversized transcription');
  const annotations = result?.output?.choices?.[0]?.message?.annotations;
  const expression = Array.isArray(annotations)
    ? annotations.map(part => normalizeVoiceExpression(part?.emotion)).find(Boolean) : undefined;
  return expression ? { text, expression } : { text };
}
