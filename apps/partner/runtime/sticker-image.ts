import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { imageLimits, inputImages, type ImageInput } from './images.ts';

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 25_000_000;
const MAX_FRAMES = 100;
const PROCESSING_SECONDS = 5;
const formats: Record<ImageInput['mediaType'], string> = {
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif',
};
export type StickerImage = {
  hash: string; mediaType: ImageInput['mediaType']; original: Buffer;
  preview: Buffer; model: Buffer; width: number; height: number; frames: number;
};

async function jpeg(bytes: Buffer, size: number, maxBytes: number, page = 0, whiteBackground = false): Promise<Buffer> {
  for (const quality of [80, 60, 40, 25]) {
    let image = sharp(bytes, { page, pages: 1, limitInputPixels: MAX_PIXELS })
      .timeout({ seconds: PROCESSING_SECONDS }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true });
    if (whiteBackground) image = image.flatten({ background: '#ffffff' });
    const result = await image.jpeg({ quality }).toBuffer();
    if (result.length <= maxBytes) return result;
  }
  throw new Error('Sticker image variant exceeds its size limit');
}

/** Validate and fully decode the bounded animation before retaining original bytes. */
async function validateAndDecode(bytes: Buffer, mediaType: ImageInput['mediaType']): Promise<{ width: number; height: number; frames: number }> {
  if (!bytes.length || bytes.length > imageLimits.maxImageBytes) throw new Error('Sticker image is empty or too large');
  inputImages('sticker-validation', [{ type: 'image', name: 'sticker', mediaType, data: bytes.toString('base64') }]);
  const metadata = await sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS }).timeout({ seconds: PROCESSING_SECONDS }).metadata();
  const width = metadata.width ?? 0;
  const frames = metadata.pages ?? 1;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  if (metadata.format !== formats[mediaType] || !width || !height || !Number.isSafeInteger(frames) || frames < 1 || frames > MAX_FRAMES || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height * frames > MAX_PIXELS) throw new Error('Invalid or excessive sticker image');
  // Metadata alone does not prove every compressed frame can be decoded.
  await sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS }).timeout({ seconds: PROCESSING_SECONDS }).raw().toBuffer();
  return { width, height, frames };
}

export async function validateStickerImage(bytes: Buffer, mediaType: ImageInput['mediaType']): Promise<StickerImage> {
  const { width, height, frames } = await validateAndDecode(bytes, mediaType);
  const [preview, model] = await Promise.all([jpeg(bytes, 512, 160_000), jpeg(bytes, 1024, 320_000)]);
  return { hash: createHash('sha256').update(bytes).digest('hex'), mediaType, original: bytes, preview, model, width, height, frames };
}

/** Decode and sample at most six frames in playback order, without retaining variants. */
export async function inspectStickerImage(bytes: Buffer, mediaType: ImageInput['mediaType']): Promise<{ frames: number; sampledFrames: number[]; images: Buffer[] }> {
  const { frames } = await validateAndDecode(bytes, mediaType);
  const count = Math.min(frames, 6);
  const sampledFrames = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (frames - 1) / (count - 1)));
  const images: Buffer[] = [];
  for (const page of sampledFrames) images.push(await jpeg(bytes, 1024, 320_000, page, true));
  return { frames, sampledFrames, images };
}
