import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { imageLimits, type ImageInput } from './images.ts';
import { stickerManifestSchema, type StickerManifest } from './sticker-catalog.ts';

const MAX_ZIP = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const MAX_FILES = 501;
const ZIP_TIMEOUT_MS = 15_000;
function safeName(name: string): boolean { return !!name && name.length <= 160 && name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/u.test(name); }
function mediaType(name: string): ImageInput['mediaType'] {
  const ext = extname(name).toLowerCase();
  if (ext === '.png') return 'image/png'; if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp'; if (ext === '.gif') return 'image/gif';
  throw new Error('Unsupported sticker image extension');
}
function parseManifest(bytes: Buffer): StickerManifest {
  if (!bytes.length || bytes.length > MAX_MANIFEST) throw new Error('Invalid manifest size');
  return stickerManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
function validateNames(names: string[]): void {
  if (names.length < 2 || names.length > MAX_FILES || new Set(names).size !== names.length || names.some(name => !safeName(name))) throw new Error('Invalid or duplicate import paths');
}
function assemble(files: Map<string, Buffer>): { manifest: StickerManifest; files: Map<string, { bytes: Buffer; mediaType: ImageInput['mediaType'] }> } {
  validateNames([...files.keys()]);
  const manifest = parseManifest(files.get('manifest.json') ?? Buffer.alloc(0));
  const expected = new Set(['manifest.json', ...manifest.stickers.map(item => item.file)]);
  if (expected.size !== files.size || [...files.keys()].some(name => !expected.has(name))) throw new Error('Manifest files do not match import');
  return { manifest, files: new Map(manifest.stickers.map(item => [item.file, { bytes: files.get(item.file)!, mediaType: mediaType(item.file) }])) };
}
async function readRegular(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > max) throw new Error('Invalid import file');
    const result = await file.readFile();
    if (result.length !== stat.size || result.length > max) throw new Error('Import file changed');
    return result;
  } finally { await file.close(); }
}
/** Explicit administrator-selected directory; only flat regular manifest members are read. */
export async function readStickerDirectory(path: string) {
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid import directory');
  const names = await readdir(path); validateNames(names);
  const files = new Map<string, Buffer>(); let total = 0;
  for (const name of names) {
    const data = await readRegular(join(path, name), name === 'manifest.json' ? MAX_MANIFEST : imageLimits.maxImageBytes);
    total += data.length; if (total > MAX_EXPANDED) throw new Error('Import exceeds expansion limit');
    files.set(name, data);
  }
  return assemble(files);
}
function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}
function entryData(zip: ZipFile, entry: Entry, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error);
    let size = 0; const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) stream.destroy(new Error('ZIP entry too large')); else chunks.push(chunk); });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  }));
}
/** ZIP entries are read lazily into bounded memory, never extracted to paths. */
export async function readStickerZip(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_ZIP) throw new Error('ZIP is empty or too large');
  const zip = await openZip(bytes); const files = new Map<string, Buffer>(); let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { zip.close(); reject(new Error('ZIP processing timed out')); }, ZIP_TIMEOUT_MS);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      zip.once('error', fail);
      zip.once('end', () => { clearTimeout(timer); resolve(); });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const name = entry.fileName;
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (!safeName(name) || files.has(name) || files.size >= MAX_FILES || entry.isEncrypted() || (entry.externalFileAttributes & 0x410) !== 0 || (unixType !== 0 && unixType !== 0o100000)) throw new Error('Invalid ZIP entry');
          const max = name === 'manifest.json' ? MAX_MANIFEST : imageLimits.maxImageBytes;
          if (!entry.uncompressedSize || entry.uncompressedSize > max || total + entry.uncompressedSize > MAX_EXPANDED) throw new Error('ZIP entry exceeds limits');
          const data = await entryData(zip, entry, max); total += data.length;
          if (crc32(data) !== entry.crc32) throw new Error('Invalid ZIP checksum');
          files.set(name, data); zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return assemble(files);
}
