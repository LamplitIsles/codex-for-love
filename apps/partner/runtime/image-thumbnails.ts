import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import sharp from 'sharp';

export const THUMBNAIL_SOURCE_LIMIT = 32 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_DIMENSION = 8192;
const MAX_OUTPUT = 1024 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_ENTRIES = 64;
const formats = new Set(['jpeg', 'png', 'webp', 'gif']);

/** Read at most the stated bound even if the file grows while being read. */
export type ThumbnailSource = { path: string; noFollow: boolean; stickerVersion?: string };

function identity(stat: import('node:fs').BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Freshly open the resolved original, including catalogue symlinks where supported. */
export async function thumbnailIdentity(source: ThumbnailSource): Promise<string | undefined> {
  try {
    const file = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK | (source.noFollow ? constants.O_NOFOLLOW : 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(THUMBNAIL_SOURCE_LIMIT)) return undefined;
      return JSON.stringify([source.path, source.noFollow, source.stickerVersion ?? null, identity(stat)]);
    } finally { await file.close(); }
  } catch { return undefined; }
}

/** Read at most the stated bound even if the file grows while being read. */
export async function readThumbnailSource(source: ThumbnailSource, expected: string): Promise<Buffer | undefined> {
  try {
    const file = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK | (source.noFollow ? constants.O_NOFOLLOW : 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(THUMBNAIL_SOURCE_LIMIT) || JSON.stringify([source.path, source.noFollow, source.stickerVersion ?? null, identity(stat)]) !== expected) return undefined;
      const size = Number(stat.size);
      const bytes = Buffer.allocUnsafe(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== size || identity(await file.stat({ bigint: true })) !== identity(stat)) return undefined;
      const result = bytes.subarray(0, offset);
      if (source.stickerVersion && thumbnailDigest(result) !== source.stickerVersion) return undefined;
      return result;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export function thumbnailDigest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Per-server, disposable LRU and in-flight deduplication. Source access is always checked by the caller. */
export function createImageThumbnails() {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer | undefined>>();
  const waiters: Array<{ admit: (value: boolean) => void; cancel: () => void }> = [];
  let cacheBytes = 0;
  let active = 0;
  return {
    acquire(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (active < 4) { active++; return Promise.resolve(true); }
      if (waiters.length >= 32) return Promise.resolve(false);
      return new Promise(resolve => {
        const waiter = {
          admit(value: boolean) { signal.removeEventListener('abort', waiter.cancel); resolve(value); },
          cancel() { const index = waiters.indexOf(waiter); if (index >= 0) { waiters.splice(index, 1); waiter.admit(false); } },
        };
        signal.addEventListener('abort', waiter.cancel, { once: true });
        waiters.push(waiter);
      });
    },
    release() { const next = waiters.shift(); if (next) next.admit(true); else active--; },
    async render(kind: 'chat' | 'album', fingerprint: string, load: () => Promise<Buffer | undefined>): Promise<Buffer | undefined> {
      const key = `${kind}:${fingerprint}`;
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
      const existing = pending.get(key); if (existing) return existing;
      const task = (async () => {
        try {
          const bytes = await load(); if (!bytes) return undefined;
          const options = { page: 0, pages: 1, limitInputPixels: MAX_PIXELS };
          const metadata = await sharp(bytes, options).timeout({ seconds: 5 }).metadata();
          const width = metadata.width ?? 0, height = metadata.pageHeight ?? metadata.height ?? 0;
          if (!formats.has(metadata.format ?? '') || !width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) return undefined;
          const size = kind === 'chat' ? 512 : Math.min(384, width, height);
          const result = await sharp(bytes, options).timeout({ seconds: 5 }).rotate()
            .resize(size, size, { fit: kind === 'chat' ? 'inside' : 'cover', position: 'centre', withoutEnlargement: true })
            .webp({ quality: 80 }).toBuffer();
          if (result.length > MAX_OUTPUT) return undefined;
          cache.set(key, result); cacheBytes += result.length;
          while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
            const oldest = cache.keys().next().value!;
            cacheBytes -= cache.get(oldest)!.length; cache.delete(oldest);
          }
          return result;
        } catch { return undefined; }
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    },
  };
}
