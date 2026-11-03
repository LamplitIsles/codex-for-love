import sharp from 'sharp';
import { constants, renameSync } from 'node:fs';
import { lstat, stat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspaceImage } from './workspace-images.ts';
import { acquirePrivateFileLock } from './private-file-lock.ts';

export const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;
export const MAX_BACKGROUND_PIXELS = 40_000_000;
export const BACKGROUND_EDGE = 2560;
export type BackgroundKind = 'landscape' | 'portrait';
type Image = { data: Buffer; mediaType: string };
const formats: Record<string,string> = { 'image/png':'png', 'image/jpeg':'jpeg', 'image/webp':'webp', 'image/gif':'gif' };
export class BackgroundSettingsError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
export function backgroundMediaType(value?: string) {
  const type = value?.split(';')[0].trim().toLowerCase();
  return type && Object.hasOwn(formats,type) ? type : null;
}
export async function compressBackground(data: Buffer, mediaType: string) {
  if (!data.length || data.length > MAX_BACKGROUND_BYTES) throw new BackgroundSettingsError('invalid_background',400);
  try {
    const image = sharp(data,{animated:true,limitInputPixels:MAX_BACKGROUND_PIXELS,failOn:'error'});
    const metadata = await image.metadata();
    if (metadata.format !== formats[mediaType] || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new Error('Invalid background');
    const output = await image.rotate().resize({width:BACKGROUND_EDGE,height:BACKGROUND_EDGE,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
    if (!output.length || output.length > MAX_BACKGROUND_BYTES) throw new Error('Invalid background');
    return output;
  } catch { throw new BackgroundSettingsError('invalid_background',400); }
}

export async function createBackgroundSettings(workspace: string, legacy?: Partial<Record<BackgroundKind,string>>) {
  await mkdir(workspace,{recursive:true,mode:0o700});
  const root = await realpath(workspace);
  const directory = join(root,'.lamplit','profile','background-settings');
  let current: Partial<Record<BackgroundKind,Image>> = {};
  const pathFor = (kind: BackgroundKind) => join(directory,`${kind}.webp`);
  async function readImage(path: string, managed = false) {
    const inside = [root,resolve(workspace)].some(base => {
      const part = relative(base,resolve(path));
      return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
    });
    if (!inside) throw new Error('Background files must be inside the workspace');
    const info = await (managed ? lstat(path) : stat(path));
    if (!info.isFile() || !info.size || info.size > MAX_BACKGROUND_BYTES) throw new Error('Background file size is invalid');
    const image = await readWorkspaceImage(root,path);
    if (!image) throw new Error('Background file is invalid');
    return {data:image.bytes,mediaType:image.mediaType};
  }
  for (const kind of ['landscape','portrait'] as const) {
    let exists = false;
    try { await lstat(pathFor(kind)); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A superseded TOML slot must not be opened or validated on restart.
    if (exists) current[kind] = await readImage(pathFor(kind),true);
    else if (legacy?.[kind]) current[kind] = await readImage(legacy[kind]);
  }
  async function privateDirectory() {
    let path = root;
    for (const component of ['.lamplit','profile','background-settings']) {
      path = join(path,component);
      await mkdir(path,{mode:0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Unsafe background directory');
    }
  }
  const snapshot = () => ({landscape:!!current.landscape,portrait:!!current.portrait});
  return {
    snapshot,
    effective(kind: BackgroundKind) { return current[kind] ?? current[kind === 'landscape' ? 'portrait' : 'landscape']; },
    async save(kind: BackgroundKind, data: Buffer, mediaType: string, authorized: () => boolean, changed: () => void) {
      let lock;
      let temp: string | undefined;
      try {
        await privateDirectory();
        lock = await acquirePrivateFileLock(`${pathFor(kind)}.lock`);
        if (!lock) throw new BackgroundSettingsError('background_settings_busy',409);
        const output = await compressBackground(data,mediaType);
        temp = join(directory,`.${kind}.${randomUUID()}.tmp`);
        const file = await open(temp,'wx',0o600);
        try { await file.writeFile(output); await file.sync(); } finally { await file.close(); }
        const folder = await open(directory,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (await realpath(directory) !== directory) throw new Error('Unsafe background directory');
          if (!authorized()) throw new BackgroundSettingsError('unauthorized',401);
          // Commit and publish together, merging with the latest other slot.
          renameSync(temp,pathFor(kind));
          current = {...current,[kind]:{data:output,mediaType:'image/webp'}};
          await folder.sync();
        } finally { await folder.close(); }
        changed();
        return snapshot();
      } catch (error) {
        if (error instanceof BackgroundSettingsError) throw error;
        throw new BackgroundSettingsError('background_settings_unavailable',503);
      } finally {
        if (temp) await unlink(temp).catch(() => {});
        await lock?.close();
      }
    },
  };
}
