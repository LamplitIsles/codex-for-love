import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { hasMp3Frames } from './elevenlabs-audio.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
export async function elevenLabsSpeech(options: { apiKey: string; text: string; voice: string; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<Uint8Array> {
  if (!options.apiKey) throw new Error('Speech synthesis unavailable');
  options.signal.throwIfAborted();
  const client = new ElevenLabsClient({ apiKey: options.apiKey, fetch: options.fetchImpl, maxRetries: 0 });
  const stream = await client.textToSpeech.convert(options.voice, { text: options.text, modelId: 'eleven_v4', outputFormat: 'mp3_44100_128' }, { maxRetries: 0, abortSignal: options.signal, timeoutInSeconds: 60 });
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Audio too large');
      parts.push(value);
    }
  } finally { options.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  options.signal.throwIfAborted();
  const bytes = Buffer.concat(parts);
  if (!hasMp3Frames(bytes)) throw new Error('Invalid MP3');
  return bytes;
}
export async function elevenLabsVoices(apiKey: string, cursor?: string, fetchImpl?: typeof fetch) {
  if (!apiKey) throw new Error('Voice key unavailable');
  if (cursor !== undefined && !validText(cursor, 2048)) throw new Error('Invalid cursor');
  const client = new ElevenLabsClient({ apiKey, fetch: fetchImpl, maxRetries: 0 });
  const result = await client.voices.search({ voiceType: 'saved', pageSize: 50, ...(cursor ? { nextPageToken: cursor } : {}) }, { maxRetries: 0, timeoutInSeconds: 30 });
  if (!Array.isArray(result.voices) || result.voices.length > 100 || typeof result.hasMore !== 'boolean') throw new Error('Invalid voices');
  const voices = result.voices.map(v => {
    if (!validText(v.voiceId, 512) || !validText(v.name, 512)) throw new Error('Invalid voice');
    return { id: v.voiceId, name: v.name };
  });
  if (result.hasMore) {
    if (!validText(result.nextPageToken, 2048)) throw new Error('Invalid cursor');
    return { voices, nextCursor: result.nextPageToken };
  }
  return { voices, nextCursor: null };
}
