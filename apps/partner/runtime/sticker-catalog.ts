import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, link, unlink, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { initializeStickerSchema } from './sticker-schema.ts';
import { validateStickerImage, type StickerImage } from './sticker-image.ts';
import type { ImageInput } from './images.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const label = z.string().min(1).regex(/\S/u).refine(value => [...value].length <= 160);
const tags = z.array(z.string().min(1).regex(/\S/u).refine(value => [...value].length <= 80)).max(32).refine(value => new Set(value).size === value.length);
export const stickerMetadataSchema = z.object({ name: label.optional(), tags: tags.optional() }).strict().refine(value => value.name !== undefined || value.tags !== undefined, 'Provide a name or tags');
const entry = z.object({ id, file: z.string().min(1).max(160).regex(/^[^/\\\x00-\x1f]+$/u).refine(name => name !== '.' && name !== '..'), name: label, tags }).strict();
export const stickerManifestSchema = z.object({ id, name: label, description: z.string().max(2000), stickers: z.array(entry).min(1).max(500) }).strict().superRefine((value, context) => {
  if (new Set(value.stickers.map(item => item.id)).size !== value.stickers.length || new Set(value.stickers.map(item => item.file)).size !== value.stickers.length) context.addIssue({ code: 'custom', message: 'Duplicate sticker ID or file' });
});
export type StickerManifest = z.infer<typeof stickerManifestSchema>;
export function packStickerId(packId: string, memberId: string): string { return createHash('sha256').update(JSON.stringify(['pack', id.parse(packId), id.parse(memberId)])).digest('hex'); }
type AssetRow = { hash: string; media_type: ImageInput['mediaType']; original_path: string; preview_path: string; model_path: string; size: number; width: number; height: number };
type StickerRow = { id: string; asset_hash: string; name: string; tags: string; media_type: ImageInput['mediaType']; original_path: string; preview_path: string; model_path: string };
export type StickerView = { id: string; version: string; name: string; tags: string[]; mediaType: ImageInput['mediaType']; available: boolean };
const MAX_PAGE = 30;
function offset(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^[A-Za-z0-9_-]{1,16}$/u.test(cursor)) throw new Error('Invalid cursor');
  const text = Buffer.from(cursor, 'base64url').toString();
  if (!/^(0|[1-9][0-9]{0,6})$/u.test(text) || Buffer.from(text).toString('base64url') !== cursor) throw new Error('Invalid cursor');
  return Number(text);
}
function pageOffset(value: number): string { return Buffer.from(String(value)).toString('base64url'); }
function pageLimit(limit: number): number { if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error('Invalid limit'); return limit; }
async function readOwned(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size <= 0 || stat.size > max) throw new Error('Sticker asset unavailable'); const bytes = await file.readFile(); if (bytes.length !== stat.size) throw new Error('Sticker asset changed'); return bytes; } finally { await file.close(); }
}
function checkVariant(path: string, bytes: Buffer, kind: 'preview' | 'model'): void {
  const match = new RegExp(`\\.([a-f0-9]{64})\\.${kind}\\.jpg$`, 'u').exec(path);
  if (!match || createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error('Sticker variant changed');
}
async function regular(path: string): Promise<boolean> { try { return (await lstat(path)).isFile(); } catch { return false; } }
async function putImmutable(path: string, bytes: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await readOwned(path, bytes.length)).equals(bytes)) throw new Error('Conflicting immutable sticker asset');
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Independent multi-process sticker index. No chat admission occurs here. */
export class StickerCatalog {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private constructor(db: DatabaseSync, root: string) { this.db = db; this.root = root; }
  static async open(workspace: string): Promise<StickerCatalog> {
    const managed = join(workspace, '.lamplit');
    const root = join(managed, 'stickers');
    for (const directory of [managed, root, join(root, 'assets')]) {
      await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid sticker storage directory');
    }
    const databasePath = join(root, 'catalog.sqlite');
    try { const info = await lstat(databasePath); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid sticker database'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const db = new DatabaseSync(databasePath);
    try { db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); initializeStickerSchema(db); return new StickerCatalog(db, root); }
    catch (error) { db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private async saveAsset(image: StickerImage): Promise<AssetRow> {
    const extension = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice(6);
    const root = join(this.root, 'assets', image.hash);
    const previewHash = createHash('sha256').update(image.preview).digest('hex'), modelHash = createHash('sha256').update(image.model).digest('hex');
    const original_path = `${root}.${extension}`, preview_path = `${root}.${previewHash}.preview.jpg`, model_path = `${root}.${modelHash}.model.jpg`;
    await putImmutable(original_path, image.original); await putImmutable(preview_path, image.preview); await putImmutable(model_path, image.model);
    return { hash: image.hash, media_type: image.mediaType, original_path, preview_path, model_path, size: image.original.length, width: image.width, height: image.height };
  }
  private packFingerprint(packId: string): string {
    const pack = this.db.prepare('SELECT id,name,description FROM sticker_packs WHERE id=?').get(packId);
    if (!pack) return 'null';
    const members = this.db.prepare('SELECT s.id,s.asset_hash,s.name,s.tags,m.position FROM sticker_pack_members m JOIN stickers s ON s.id=m.sticker_id WHERE m.pack_id=? ORDER BY m.position').all(packId);
    return JSON.stringify({ pack, members });
  }
  async importPack(raw: unknown, files: Map<string, { bytes: Buffer; mediaType: ImageInput['mediaType'] }>, beforeCommit?: () => void): Promise<{ id: string; count: number }> {
    const manifest = stickerManifestSchema.parse(raw);
    const observed = this.packFingerprint(manifest.id);
    if (files.size !== manifest.stickers.length || manifest.stickers.some(item => !files.has(item.file))) throw new Error('Manifest files do not match the import');
    let total = 0;
    const deadline = Date.now() + 30_000;
    const images: StickerImage[] = [];
    for (const item of manifest.stickers) {
      if (Date.now() > deadline) throw new Error('Sticker import timed out');
      const file = files.get(item.file)!; total += file.bytes.length;
      if (total > 64 * 1024 * 1024) throw new Error('Sticker pack exceeds expansion limit');
      images.push(await validateStickerImage(file.bytes, file.mediaType));
      if (Date.now() > deadline) throw new Error('Sticker import timed out');
    }
    const assets: AssetRow[] = [];
    for (const image of images) { if (Date.now() > deadline) throw new Error('Sticker import timed out'); assets.push(await this.saveAsset(image)); }
    if (Date.now() > deadline) throw new Error('Sticker import timed out');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.packFingerprint(manifest.id);
      const expected = JSON.stringify({ pack: { id: manifest.id, name: manifest.name, description: manifest.description }, members: manifest.stickers.map((item, position) => ({ id: packStickerId(manifest.id, item.id), asset_hash: assets[position]!.hash, name: item.name, tags: JSON.stringify(item.tags), position })) });
      if (current !== observed && current !== expected) throw new Error('Sticker pack changed during import');
      for (const item of manifest.stickers) {
        const stickerId = packStickerId(manifest.id, item.id);
        const conflict = this.db.prepare('SELECT pack_id FROM sticker_pack_members WHERE sticker_id=? AND pack_id<>? LIMIT 1').get(stickerId, manifest.id);
        if (conflict) throw new Error('Sticker ID belongs to another source');
      }
      this.db.prepare('INSERT INTO sticker_packs(id,name,description,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description').run(manifest.id, manifest.name, manifest.description, Date.now());
      this.db.prepare('DELETE FROM sticker_pack_members WHERE pack_id=?').run(manifest.id);
      for (const [i, item] of manifest.stickers.entries()) {
        const a = assets[i]!;
        this.db.prepare('INSERT OR IGNORE INTO sticker_assets(hash,media_type,original_path,preview_path,model_path,size,width,height) VALUES(?,?,?,?,?,?,?,?)').run(a.hash, a.media_type, a.original_path, a.preview_path, a.model_path, a.size, a.width, a.height);
        const existing = this.db.prepare('SELECT media_type,original_path,preview_path,model_path,size,width,height FROM sticker_assets WHERE hash=?').get(a.hash) as Omit<AssetRow, 'hash'>;
        if (existing.media_type !== a.media_type || existing.original_path !== a.original_path || existing.preview_path !== a.preview_path || existing.model_path !== a.model_path || existing.size !== a.size || existing.width !== a.width || existing.height !== a.height) throw new Error('Conflicting asset metadata');
        this.db.prepare('INSERT INTO stickers(id,asset_hash,name,tags,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET asset_hash=excluded.asset_hash,name=excluded.name,tags=excluded.tags').run(packStickerId(manifest.id, item.id), a.hash, item.name, JSON.stringify(item.tags), Date.now());
        this.db.prepare('INSERT INTO sticker_pack_members(pack_id,sticker_id,position) VALUES(?,?,?)').run(manifest.id, packStickerId(manifest.id, item.id), i);
      }
      beforeCommit?.(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id: manifest.id, count: manifest.stickers.length };
  }
  private row(stickerId: string): StickerRow | undefined {
    id.parse(stickerId);
    return this.db.prepare('SELECT s.id,s.asset_hash,s.name,s.tags,a.media_type,a.original_path,a.preview_path,a.model_path FROM stickers s JOIN sticker_assets a ON a.hash=s.asset_hash WHERE s.id=?').get(stickerId) as StickerRow | undefined;
  }
  private async view(row: StickerRow): Promise<StickerView> {
    return { id: row.id, version: row.asset_hash, name: row.name, tags: JSON.parse(row.tags), mediaType: row.media_type, available: (await Promise.all([regular(row.original_path), regular(row.preview_path), regular(row.model_path)])).every(Boolean) };
  }
  async get(stickerId: string): Promise<StickerView | undefined> { const row = this.row(stickerId); return row ? this.view(row) : undefined; }
  async updateMetadata(stickerId: string, input: unknown): Promise<StickerView> {
    id.parse(stickerId);
    const changes = stickerMetadataSchema.parse(input);
    const result = this.db.prepare('UPDATE stickers SET name=COALESCE(?,name), tags=COALESCE(?,tags) WHERE id=?').run(changes.name ?? null, changes.tags === undefined ? null : JSON.stringify(changes.tags), stickerId);
    if (!result.changes) throw new Error('Sticker not found');
    return (await this.get(stickerId))!;
  }
  async asset(stickerId: string, version: string): Promise<{ sticker: StickerView; original: Buffer; preview: Buffer; model: Buffer; previewPath: string; modelPath: string }> {
    const row = this.row(stickerId);
    if (!row || row.asset_hash !== version) throw new Error('Sticker version unavailable');
    const [original, preview, model] = await Promise.all([readOwned(row.original_path, 5 * 1024 * 1024), readOwned(row.preview_path, 160_000), readOwned(row.model_path, 320_000)]);
    if (createHash('sha256').update(original).digest('hex') !== version) throw new Error('Sticker original changed');
    checkVariant(row.preview_path, preview, 'preview'); checkVariant(row.model_path, model, 'model');
    return { sticker: await this.view(row), original, preview, model, previewPath: row.preview_path, modelPath: row.model_path };
  }
  async historicalAsset(stickerId: string, version: string): Promise<{ path: string; mediaType: ImageInput['mediaType'] }> {
    if (!this.row(stickerId) || !/^[a-f0-9]{64}$/u.test(version)) throw new Error('Sticker version unavailable');
    const row = this.db.prepare('SELECT * FROM sticker_assets WHERE hash=?').get(version) as AssetRow | undefined;
    if (!row) throw new Error('Sticker version unavailable');
    const bytes = await readOwned(row.original_path, 5 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== version) throw new Error('Sticker original changed');
    return { path: row.original_path, mediaType: row.media_type };
  }
  async media(version: string, variant: 'original' | 'preview'): Promise<{ bytes: Buffer; mediaType: string } | null> {
    if (!/^[a-f0-9]{64}$/u.test(version)) throw new Error('Invalid version');
    const row = this.db.prepare('SELECT * FROM sticker_assets WHERE hash=?').get(version) as AssetRow | undefined;
    if (!row) return null;
    try {
      const bytes = await readOwned(variant === 'original' ? row.original_path : row.preview_path, variant === 'original' ? 5 * 1024 * 1024 : 160_000);
      if (variant === 'original' && createHash('sha256').update(bytes).digest('hex') !== version) return null;
      if (variant === 'preview') checkVariant(row.preview_path, bytes, 'preview');
      return { bytes, mediaType: variant === 'original' ? row.media_type : 'image/jpeg' };
    } catch { return null; }
  }
  async listStickers(input: { cursor: string | null; limit: number; query?: string; packId?: string; participant?: 'human' | 'agent' }): Promise<{ stickers: StickerView[]; nextCursor: string | null }> {
    const start = offset(input.cursor), limit = pageLimit(input.limit), query = (input.query ?? '').trim();
    if (query.length > 100) throw new Error('Invalid search');
    if (input.packId) id.parse(input.packId);
    const where: string[] = [], args: Array<string | number> = [];
    if (input.packId) { where.push('EXISTS (SELECT 1 FROM sticker_pack_members m WHERE m.sticker_id=s.id AND m.pack_id=?)'); args.push(input.packId); }
    if (input.participant) { where.push('EXISTS (SELECT 1 FROM sticker_favorites f WHERE f.sticker_id=s.id AND f.participant=?)'); args.push(input.participant); }
    if (query) { where.push('(instr(lower(s.name),lower(?))>0 OR EXISTS (SELECT 1 FROM json_each(s.tags) j WHERE instr(lower(j.value),lower(?))>0))'); args.push(query, query); }
    const order = input.packId ? '(SELECT position FROM sticker_pack_members m WHERE m.sticker_id=s.id AND m.pack_id=?)' : 's.id';
    if (input.packId) args.push(input.packId);
    const rows = this.db.prepare(`SELECT s.id,s.asset_hash,s.name,s.tags,a.media_type,a.original_path,a.preview_path,a.model_path FROM stickers s JOIN sticker_assets a ON a.hash=s.asset_hash ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order},s.id LIMIT ? OFFSET ?`).all(...args, limit + 1, start) as StickerRow[];
    return { stickers: await Promise.all(rows.slice(0, limit).map(row => this.view(row))), nextCursor: rows.length > limit ? pageOffset(start + limit) : null };
  }
  async listPacks(input: { cursor: string | null; limit: number; query?: string }): Promise<{ packs: Array<{ id: string; name: string; description: string; cover: StickerView }>; nextCursor: string | null }> {
    const start = offset(input.cursor), limit = pageLimit(input.limit), query = (input.query ?? '').trim();
    if (query.length > 100) throw new Error('Invalid search');
    const packs = this.db.prepare(`SELECT p.id,p.name,p.description,m.sticker_id AS cover_id FROM sticker_packs p JOIN sticker_pack_members m ON m.pack_id=p.id AND m.position=0 WHERE (?='' OR instr(lower(p.name),lower(?))>0 OR instr(lower(p.description),lower(?))>0) ORDER BY p.id LIMIT ? OFFSET ?`).all(query, query, query, limit + 1, start) as Array<{ id: string; name: string; description: string; cover_id: string }>;
    const result = await Promise.all(packs.slice(0, limit).map(async pack => ({ id: pack.id, name: pack.name, description: pack.description, cover: (await this.get(pack.cover_id))! })));
    return { packs: result, nextCursor: packs.length > limit ? pageOffset(start + limit) : null };
  }
  async getPack(packId: string): Promise<{ id: string; name: string; description: string; cover: StickerView } | undefined> {
    id.parse(packId);
    const row = this.db.prepare('SELECT p.id,p.name,p.description,m.sticker_id AS cover_id FROM sticker_packs p JOIN sticker_pack_members m ON m.pack_id=p.id AND m.position=0 WHERE p.id=?').get(packId) as { id: string; name: string; description: string; cover_id: string } | undefined;
    return row ? { id: row.id, name: row.name, description: row.description, cover: (await this.get(row.cover_id))! } : undefined;
  }
  async favoriteImage(participant: 'human' | 'agent', source: { kind: 'upload' } | { kind: 'chat'; imageId: string }, input: { name: string; tags: string[]; bytes: Buffer; mediaType: ImageInput['mediaType'] }, beforeCommit?: () => void): Promise<StickerView> {
    label.parse(input.name); tags.parse(input.tags);
    if (source.kind === 'chat' && !/^[a-f0-9]{64}$/u.test(source.imageId)) throw new Error('Invalid conversation image identity');
    const image = await validateStickerImage(input.bytes, input.mediaType);
    const stickerId = source.kind === 'chat' ? `chat_${source.imageId}` : `upload_${image.hash}`;
    const asset = await this.saveAsset(image);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT asset_hash FROM stickers WHERE id=?').get(stickerId) as { asset_hash: string } | undefined;
      if (existing && existing.asset_hash !== asset.hash) throw new Error('Sticker source identity conflict');
      this.db.prepare('INSERT OR IGNORE INTO sticker_assets(hash,media_type,original_path,preview_path,model_path,size,width,height) VALUES(?,?,?,?,?,?,?,?)').run(asset.hash, asset.media_type, asset.original_path, asset.preview_path, asset.model_path, asset.size, asset.width, asset.height);
      this.db.prepare('INSERT OR IGNORE INTO stickers(id,asset_hash,name,tags,created_at) VALUES(?,?,?,?,?)').run(stickerId, asset.hash, input.name, JSON.stringify(input.tags), Date.now());
      this.db.prepare('INSERT OR IGNORE INTO sticker_favorites(participant,sticker_id,created_at) VALUES(?,?,?)').run(participant, stickerId, Date.now());
      beforeCommit?.(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return (await this.get(stickerId))!;
  }
  async favorite(participant: 'human' | 'agent', stickerId: string, value: boolean, beforeCommit?: () => void): Promise<StickerView> {
    const row = this.row(stickerId); if (!row) throw new Error('Sticker not found');
    const sticker = await this.view(row); if (value && !sticker.available) throw new Error('Sticker unavailable');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (value) this.db.prepare('INSERT OR IGNORE INTO sticker_favorites(participant,sticker_id,created_at) VALUES(?,?,?)').run(participant, stickerId, Date.now());
      else this.db.prepare('DELETE FROM sticker_favorites WHERE participant=? AND sticker_id=?').run(participant, stickerId);
      beforeCommit?.(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return (await this.get(stickerId)) ?? sticker;
  }
}
