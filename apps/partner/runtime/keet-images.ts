import sharp from 'sharp';
import { imageLimits, inputImages, materializeImages, type MaterializedInputImage } from './images.ts';
import type { KeetEventBody } from './keet.ts';

const MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
const imageFormats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;

async function original(endpoint: string, token: string, ref: string, mediaType: keyof typeof imageFormats): Promise<Buffer> {
  const url = new URL(endpoint);
  url.pathname = `/images/${ref}`;
  url.search = '';
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || response.headers.get('content-type') !== mediaType || !response.body) {
    await response.body?.cancel();
    throw new Error('Keet image unavailable');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_ORIGINAL_BYTES) throw new Error('Keet image too large');
    chunks.push(chunk);
  }
  if (!total) throw new Error('Keet image empty');
  return Buffer.concat(chunks);
}

async function modelImage(bytes: Buffer, mediaType: keyof typeof imageFormats): Promise<{ bytes: Buffer; mediaType: keyof typeof imageFormats }> {
  const source = sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'error' });
  const metadata = await source.metadata();
  if (metadata.format !== imageFormats[mediaType] || !metadata.width || !metadata.height || metadata.width > 20_000 || metadata.height > 20_000) throw new Error('Keet image format mismatch');
  await source.stats();
  if (bytes.byteLength <= imageLimits.maxImageBytes) return { bytes, mediaType };
  for (const width of [2560, 2048, 1600, 1280, 1024]) {
    for (const quality of [85, 70]) {
      const resized = await sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'error' }).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
      if (resized.byteLength <= imageLimits.maxImageBytes) return { bytes: resized, mediaType: 'image/webp' };
    }
  }
  throw new Error('Keet image cannot fit model input');
}

/** Fetch only triggered DM images. Failures become a count, never a credential-bearing error. */
export async function materializeKeetImages(workspace: string, endpoint: string, token: string, inputId: string, entries: NonNullable<KeetEventBody['images']>): Promise<{ images: MaterializedInputImage[]; unavailable: number }> {
  const images: MaterializedInputImage[] = [];
  let unavailable = Math.max(0, entries.length - imageLimits.maxImagesPerMessage);
  let total = 0;
  for (const [index, entry] of entries.slice(0, imageLimits.maxImagesPerMessage).entries()) {
    if (entry.status === 'unavailable') { unavailable++; continue; }
    let validated: ReturnType<typeof inputImages>;
    try {
      const converted = await modelImage(await original(endpoint, token, entry.ref, entry.mediaType), entry.mediaType);
      if (total + converted.bytes.byteLength > imageLimits.maxMessageImageBytes) throw new Error('Keet image budget exceeded');
      validated = inputImages(inputId, [{ type: 'image', mediaType: converted.mediaType, data: converted.bytes.toString('base64'), name: `keet-image-${index + 1}.${converted.mediaType === 'image/jpeg' ? 'jpg' : converted.mediaType.slice(6)}` }]);
    } catch { unavailable++; continue; }
    images.push(...await materializeImages(workspace, validated));
    total += validated[0]!.data.byteLength;
  }
  return { images, unavailable };
}
