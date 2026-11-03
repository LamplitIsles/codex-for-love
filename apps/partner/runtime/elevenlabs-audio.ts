const MAX_BYTES = 10 * 1024 * 1024;
const HOST = 'elevenlabsusercontent.com';

function safeUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password || url.port || url.hash) throw new Error('Invalid audio URL');
  return url;
}

// Validate the complete bounded MPEG Layer III frame sequence, allowing common
// leading ID3v2 and trailing ID3v1 metadata. Frame payload decoding is separate.
function hasMp3Frames(bytes: Uint8Array): boolean {
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes.length < 10) return false;
    const major = bytes[3], flags = bytes[5];
    if (![2, 3, 4].includes(major) || bytes[4] === 0xff || (flags & (major === 2 ? 0x3f : major === 3 ? 0x1f : 0x0f))) return false;
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some(b => b & 0x80)) return false;
    offset = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9]);
    if (offset > bytes.length) return false;
    if (major === 4 && (flags & 0x10)) {
      if (offset + 10 > bytes.length || bytes[offset] !== 0x33 || bytes[offset + 1] !== 0x44 || bytes[offset + 2] !== 0x49) return false;
      for (let i = 3; i < 10; i++) if (bytes[offset + i] !== bytes[i]) return false;
      offset += 10;
    }
  }
  let end = bytes.length;
  if (end - offset >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) end -= 128;
  let frameCount = 0, firstVersion = -1, firstSampleRate = -1;
  while (offset < end) {
    if (offset + 4 > end) return false;
    const [a, b, c, d] = bytes.subarray(offset, offset + 4);
    const version = (b >> 3) & 3, layer = (b >> 1) & 3, bitrate = c >> 4, sampleRate = (c >> 2) & 3;
    if (a !== 0xff || (b & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || sampleRate === 3 || (d & 3) === 2) return false;
    if (frameCount && (version !== firstVersion || sampleRate !== firstSampleRate)) return false;
    firstVersion = version; firstSampleRate = sampleRate;
    const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const samples = [44100,48000,32000][sampleRate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * rates[bitrate] * 1000 / samples) + ((c >> 1) & 1);
    if (offset + length > end) return false;
    offset += length;
    frameCount++;
  }
  return frameCount > 0;
}

export async function receiveElevenLabsAudio(value: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let url = safeUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Invalid audio redirect');
      url = safeUrl(location, url.href);
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Invalid audio response'); }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BYTES)) { await response.body.cancel(); throw new Error('Audio too large'); }
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw new Error('Audio too large');
        parts.push(chunk);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    signal.throwIfAborted();
    const bytes = Buffer.concat(parts);
    if (!hasMp3Frames(bytes)) throw new Error('Invalid MP3');
    return bytes;
  }
  throw new Error('Invalid audio redirect');
}
