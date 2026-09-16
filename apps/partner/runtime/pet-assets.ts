import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';
import { z } from 'zod';
import { PET_ACTIVITIES, type PetActivity } from './pet.ts';

const clip = z.object({ file: z.string().regex(/^[a-z]+\.webp$/u), frameCount: z.union([z.literal(6), z.literal(8)]), fps: z.number().int().min(1).max(24), loop: z.boolean() }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(2), character: z.literal('shio'), revision: z.string().min(1).max(80), clips: z.object(Object.fromEntries(PET_ACTIVITIES.map(a => [a, clip])) as Record<PetActivity, typeof clip>).strict() }).strict();
export type PetManifest = z.infer<typeof manifestSchema>;
const MAX_SHEET_BYTES = 1_500_000;

export async function localPetManifest(state: string): Promise<PetManifest | undefined> {
  const root = join(state, 'pet-assets');
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
    if (!parsed.success) return undefined;
    for (const activity of PET_ACTIVITIES) if (!await readClip(root, parsed.data.clips[activity].file, parsed.data.clips[activity].frameCount)) return undefined;
    return parsed.data;
  } catch { return undefined; }
}
export async function localPetClip(state: string, activity: PetActivity): Promise<{ data: Buffer; manifest: PetManifest } | undefined> {
  const root = join(state, 'pet-assets'); let manifest: PetManifest;
  try { const parsed = manifestSchema.safeParse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))); if (!parsed.success) return undefined; manifest = parsed.data; } catch { return undefined; }
  let selected: Buffer | undefined;
  for (const candidate of PET_ACTIVITIES) { const data = await readClip(root, manifest.clips[candidate].file, manifest.clips[candidate].frameCount); if (!data) return undefined; if (candidate === activity) selected = data; }
  return selected ? { data: selected, manifest } : undefined;
}
export function webpDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 20 || Buffer.from(data.subarray(0, 4)).toString() !== 'RIFF' || Buffer.from(data.subarray(8, 12)).toString() !== 'WEBP') return undefined;
  for (let offset = 12; offset + 8 <= data.length;) { const type = Buffer.from(data.subarray(offset, offset + 4)).toString(); const size = data[offset + 4]! | data[offset + 5]! << 8 | data[offset + 6]! << 16 | data[offset + 7]! << 24; const body = offset + 8; if (body + size > data.length) return undefined;
    if (type === 'VP8X' && size >= 10) return { width: 1 + data[body + 4]! + (data[body + 5]! << 8) + (data[body + 6]! << 16), height: 1 + data[body + 7]! + (data[body + 8]! << 8) + (data[body + 9]! << 16) };
    if (type === 'VP8 ' && size >= 10 && data[body + 3] === 0x9d && data[body + 4] === 1 && data[body + 5] === 0x2a) return { width: data[body + 6]! | (data[body + 7]! & 0x3f) << 8, height: data[body + 8]! | (data[body + 9]! & 0x3f) << 8 };
    if (type === 'VP8L' && size >= 5 && data[body] === 0x2f) return { width: 1 + data[body + 1]! + ((data[body + 2]! & 0x3f) << 8), height: 1 + (data[body + 2]! >> 6) + (data[body + 3]! << 2) + ((data[body + 4]! & 0x0f) << 10) };
    offset = body + size + (size % 2);
  } return undefined;
}
async function readClip(root: string, name: string, frameCount: number): Promise<Buffer | undefined> {
  if (extname(name) !== '.webp') return undefined;
  const path = resolve(root, name);
  if (relative(resolve(root), path).startsWith('..')) return undefined;
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SHEET_BYTES) return undefined; const [actualRoot, actual, data] = await Promise.all([realpath(root), realpath(path), readFile(path)]); const dimensions = webpDimensions(data); return dimensions?.height === 512 && dimensions.width === frameCount * 512 && (actual === actualRoot || actual.startsWith(`${actualRoot}/`)) ? data : undefined; } catch { return undefined; }
}
