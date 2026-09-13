import { MAX_MESSAGE_LENGTH } from "../src/lib/message-input.ts";
import { normalizeVoiceExpression, normalizeVoiceMediaType, MAX_VOICE_DATA_URL_BYTES } from '../src/lib/companion/voice-contract.ts';

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
