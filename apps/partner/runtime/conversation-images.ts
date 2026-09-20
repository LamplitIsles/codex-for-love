import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type ConversationImageOrigin = 'human' | 'agent' | 'historical';
export type ConversationImage = { id: string; filename: string; path: string; mediaType: string; created: number; origin: ConversationImageOrigin; available: boolean };
export type ConversationImagePage = { images: ConversationImage[]; nextCursor?: string };

const CURSOR_BYTES = 40;
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{54}$/u;
const IMAGE_ID = /^[a-f0-9]{64}$/u;

function cursorFor(image: ConversationImage): string {
  if (!Number.isSafeInteger(image.created) || image.created < 0 || !IMAGE_ID.test(image.id)) throw new Error('Invalid conversation image cursor data');
  const value = Buffer.alloc(CURSOR_BYTES);
  value.writeBigUInt64BE(BigInt(image.created));
  Buffer.from(image.id, 'hex').copy(value, 8);
  return value.toString('base64url');
}
function readCursor(cursor?: string): [number, string] | undefined {
  if (!cursor) return undefined;
  if (!CURSOR_TOKEN.test(cursor)) return undefined;
  try {
    const value = Buffer.from(cursor, 'base64url');
    if (value.length !== CURSOR_BYTES) return undefined;
    const created = Number(value.readBigUInt64BE());
    if (!Number.isSafeInteger(created)) return undefined;
    return [created, value.subarray(8).toString('hex')];
  } catch { return undefined; }
}
export function conversationImageId(origin: ConversationImageOrigin, source: string): string { return createHash('sha256').update(`${origin}:${source}`).digest('hex'); }
export function pageConversationImages(images: readonly ConversationImage[], limit = 5, cursor?: string): ConversationImagePage {
  const after = readCursor(cursor); if (cursor && !after) throw new Error('Invalid conversation image cursor');
  const ordered = images.filter((image) => !after || image.created < after[0] || (image.created === after[0] && image.id < after[1]))
    .sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
  const page = ordered.slice(0, limit);
  return { images: page, ...(ordered.length > page.length ? { nextCursor: cursorFor(page.at(-1)!) } : {}) };
}
export async function readConversationImages(path: string): Promise<ConversationImage[]> {
  try { const value = JSON.parse(await readFile(path, 'utf8')); return Array.isArray(value) ? value : []; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function withAvailability(images: readonly ConversationImage[]): Promise<ConversationImage[]> {
  return Promise.all(images.map(async (image) => {
    try { await access(image.path); return { ...image, available: true }; }
    catch { return { ...image, available: false }; }
  }));
}
/** Atomic metadata projection shared by the HTTP host and the standalone MCP. */
export async function writeConversationImages(path: string, images: readonly ConversationImage[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = resolve(path); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(images)}\n`, { mode: 0o600 }); await rename(temporary, target);
}
