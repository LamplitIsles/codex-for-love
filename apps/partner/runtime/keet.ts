import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import { keetImage } from './images.ts';
import type { StoredImage } from './store.ts';

const id = z.object({ deviceId: z.string().min(1).max(512), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const destination = z.object({ groupName: z.string().min(1).max(512), kind: z.enum(['group', 'broadcast', 'dm']) }).strict();
const image = z.object({ filename: z.string().min(1).max(128), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), name: z.string().max(160).optional() }).strict();
export const messageFrame = z.object({ type: z.literal('message'), sequence: z.number().int().positive(), messageId: id, timestamp: z.number().finite(), destination, senderLabel: z.string().min(1).max(512), text: z.string().max(16_000), images: z.array(image).max(16).optional(), replyTo: id.optional(), trigger: z.enum(['mention', 'label', 'reply', 'dm']).optional() }).strict()
  .superRefine((value, ctx) => { if (value.destination.kind === 'dm' ? value.trigger !== 'dm' : value.trigger === 'dm') ctx.addIssue({ code: 'custom', message: 'Invalid trigger' }); if (value.destination.kind === 'broadcast' && value.trigger) ctx.addIssue({ code: 'custom', message: 'Broadcast cannot trigger' }); if (value.destination.kind !== 'dm' && value.images?.length) ctx.addIssue({ code: 'custom', message: 'Only DMs carry images' }); });
const range = z.object({ first: z.number().int().positive(), last: z.number().int().positive() }).strict().refine(value => value.first <= value.last);
export const readyFrame = z.object({ type: z.literal('ready'), retained: range.nullable(), destinations: z.array(destination).max(256) }).strict();
export const resyncFrame = z.object({ type: z.literal('resync_required'), retained: range }).strict();
export type KeetMessage = z.infer<typeof messageFrame>;

export function keetInputId(endpoint: string, message: KeetMessage): string { return `keet:${createHash('sha256').update(JSON.stringify([endpoint, message.destination, message.messageId])).digest('hex')}`; }
export function keetMessageKey(message: KeetMessage): string { return `${message.messageId.deviceId}:${message.messageId.seq}`; }
export async function keetImages(root: string, inputId: string, values: readonly z.infer<typeof image>[]): Promise<StoredImage[]> {
  const stats: Awaited<ReturnType<typeof keetImage>>[] = []; for (const value of values) stats.push(await keetImage(root, value.filename, value.mediaType, value.name));
  return stats.map(({ data: _data, ...value }, index) => ({ id: createHash('sha256').update(`${inputId}:${index}:${value.path}`).digest('hex'), operation_id: inputId, ...value }));
}

export type KeetFeed = { close(): void };
export function connectKeetFeed(endpoint: string, token: string, after: number, frames: { ready(frame: z.infer<typeof readyFrame>): void; resync(frame: z.infer<typeof resyncFrame>): void; message(frame: KeetMessage): Promise<void>; failed(error: Error): void; closed(intentional: boolean): void }): KeetFeed {
  const socket = new WebSocket(`${endpoint.replace(/^http/u, 'ws')}/cfl`, { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false, maxPayload: 64 * 1024 });
  let framesTail: Promise<void> = Promise.resolve();
  let intentional = false; let failed = false; let ready = false;
  socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', afterSequence: after })));
  socket.on('message', (raw, binary) => { framesTail = framesTail.then(async () => {
    try {
      if (binary) throw new Error('Keet feed sent a binary frame');
      const parsed: unknown = JSON.parse(raw.toString());
      const parsedReady = readyFrame.safeParse(parsed); if (parsedReady.success) { if (ready) throw new Error('Keet feed sent a duplicate ready frame'); ready = true; return frames.ready(parsedReady.data); }
      const resync = resyncFrame.safeParse(parsed); if (resync.success) return frames.resync(resync.data);
      const message = messageFrame.safeParse(parsed); if (message.success) { if (!ready) throw new Error('Keet feed sent message before ready'); return await frames.message(message.data); }
      throw new Error('Keet feed sent an invalid frame');
    } catch (error) { if (!failed) { failed = true; frames.failed(error instanceof Error ? error : new Error(String(error))); } socket.terminate(); }
  }); });
  socket.once('error', (error) => { if (!failed) { failed = true; frames.failed(error); } });
  socket.once('close', () => frames.closed(intentional));
  return { close: () => { intentional = true; socket.terminate(); } };
}

export async function validateKeetMediaRoot(root: string): Promise<void> { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Keet media_root must be a real directory'); }
