import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ImageAttachmentLimits } from '../src/lib/companion/client/contracts.ts';
import { partnerPaths } from './storage-paths.ts';

export const imageLimits: ImageAttachmentLimits = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxImagesPerMessage: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxMessageImageBytes: 20 * 1024 * 1024,
};
export const messageBodyLimit = Math.ceil(imageLimits.maxMessageImageBytes / 3) * 4 + 128 * 1024;
export const imageInputSchema = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().max(Math.ceil(imageLimits.maxImageBytes / 3) * 4),
  name: z.string().max(160).optional(),
}).strict();

export type ImageInput = z.infer<typeof imageInputSchema>;
export type InputImage = {
  id: string;
  operation_id: string;
  name: string;
  media_type: ImageInput['mediaType'];
  data: Uint8Array;
};
export type MaterializedInputImage = Omit<InputImage, 'data'> & { path: string };
export type MaterializedGeneratedImage = {
  id: string;
  operation_id: string;
  name: string;
  media_type: 'image/png';
  path: string;
};

export class InvalidImageInput extends Error {}

function decodeImageDataUrl(value: string): { data: Uint8Array; mediaType: InputImage['media_type'] } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match || !match[1] || match[2] === '' || match[2].length % 4 !== 0 || /=[^=]/u.test(match[2]) || (match[2].includes('=') && !/={1,2}$/u.test(match[2]))) {
    throw new InvalidImageInput('Invalid image encoding');
  }
  const data = Buffer.from(match[2], 'base64');
  if (!data.byteLength || data.toString('base64') !== match[2]) throw new InvalidImageInput('Invalid image encoding');
  return { data, mediaType: match[1] as InputImage['media_type'] };
}

function hasSignature(data: Uint8Array, mediaType: InputImage['media_type']): boolean {
  const bytes = Buffer.from(data);
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mediaType === 'image/gif') return /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString());
  return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}

export function inputImages(id: string, values: readonly ImageInput[]): InputImage[] {
  if (values.length > imageLimits.maxImagesPerMessage) throw new InvalidImageInput('Too many images');
  let total = 0;
  return values.map((value, index) => {
    let decoded: ReturnType<typeof decodeImageDataUrl>;
    try { decoded = decodeImageDataUrl(`data:${value.mediaType};base64,${value.data}`); }
    catch { throw new InvalidImageInput('Invalid image encoding'); }
    const { data, mediaType } = decoded;
    total += data.byteLength;
    if (data.byteLength > imageLimits.maxImageBytes || total > imageLimits.maxMessageImageBytes) throw new InvalidImageInput('Images are too large');
    if (!hasSignature(data, mediaType as InputImage['media_type'])) throw new InvalidImageInput('Image format does not match its contents');
    const name = value.name ?? `image-${index + 1}.${mediaType.slice(6)}`;
    return {
      id: createHash('sha256').update(JSON.stringify([id, index, mediaType, name])).update(data).digest('hex'),
      operation_id: id,
      name,
      media_type: mediaType as InputImage['media_type'],
      data,
    };
  });
}

export function imagePath(workspace: string, image: Pick<InputImage, 'id' | 'media_type'>): string {
  const extension = image.media_type === 'image/jpeg' ? 'jpg' : image.media_type.slice(6);
  return join(partnerPaths(workspace).attachments, `${image.id}.${extension}`);
}

/** Materialize once; the content-addressed name makes this idempotent. */
export async function materializeImages(workspace: string, images: readonly InputImage[]): Promise<MaterializedInputImage[]> {
  const materialized: MaterializedInputImage[] = [];
  for (const image of images) {
    const path = imagePath(workspace, image);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(path);
      if (!Buffer.from(existing).equals(Buffer.from(image.data))) throw new Error(`Attachment path already contains different bytes: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(path, image.data, { flag: 'wx', mode: 0o600 });
    }
    materialized.push({ ...image, path });
  }
  return materialized;
}

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

function generatedPath(workspace: string, id: string): string {
  return join(partnerPaths(workspace).attachments, `${id}.png`);
}

function pngBytes(value: Uint8Array): boolean {
  return Buffer.from(value).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function decodeGeneratedResult(value: string): Uint8Array {
  const encoded = value.trim();
  if (!encoded || encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) {
    throw new Error('Native image result is empty or too large');
  }
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.toString('base64') !== encoded || !pngBytes(data)) {
    throw new Error('Native image result is not a PNG');
  }
  return data;
}

/** Materialize the official image-generation artifact without storing a second protocol blob. */
export async function materializeGeneratedImage(
  workspace: string,
  operationId: string,
  item: { id?: unknown; savedPath?: unknown; result?: unknown },
): Promise<MaterializedGeneratedImage | undefined> {
  const itemId = typeof item.id === 'string' ? item.id : '';
  if (!itemId) return undefined;
  let data: Uint8Array | undefined;
  if (typeof item.savedPath === 'string' && item.savedPath.trim()) {
    const source = await readFile(item.savedPath);
    if (source.byteLength > MAX_GENERATED_IMAGE_BYTES || !pngBytes(source)) throw new Error('Native image artifact is not a PNG or is too large');
    data = source;
  } else if (typeof item.result === 'string' && item.result.trim()) {
    data = decodeGeneratedResult(item.result);
  }
  if (!data) return undefined;
  const id = createHash('sha256').update(data).digest('hex');
  const path = generatedPath(workspace, id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path);
    if (!Buffer.from(existing).equals(Buffer.from(data))) throw new Error(`Generated attachment path already contains different bytes: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  }
  return { id, operation_id: operationId, name: `image-${itemId.slice(0, 12)}.png`, media_type: 'image/png', path };
}
