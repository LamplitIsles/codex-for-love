import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contained, descriptorPath, safeWorkspacePath } from './workspace-images.ts';

export const MAX_WORKSPACE_MEDIA_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_MEDIA_CHUNK_BYTES = 64 * 1024;
export type WorkspaceMediaKind = 'audio' | 'video';

type Identity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
function identity(value: Identity) { return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String); }
function same(a: Identity, b: Identity) { return identity(a).every((value, index) => value === identity(b)[index]); }

async function readAt(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(data, offset, size - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return data.subarray(0, offset);
}

function mp3Frame(data: Buffer): { length: number; format: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || (data[1]! & 0xe0) !== 0xe0) return;
  const version = (data[1]! >> 3) & 3, layer = (data[1]! >> 1) & 3;
  const bitrateIndex = data[2]! >> 4, rateIndex = (data[2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) return;
  const rates = [44100, 48000, 32000], rate = rates[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const ratesV1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const ratesV2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const bitrate = (version === 3 ? ratesV1 : ratesV2)[bitrateIndex]! * 1000;
  const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((data[2]! >> 1) & 1);
  return length >= 4 ? { length, format: (version << 2) | rateIndex } : undefined;
}
async function isMp3(file: FileHandle, size: number): Promise<boolean> {
  const header = await readAt(file, 10, 0);
  let offset = 0;
  if (header.subarray(0, 3).equals(Buffer.from('ID3'))) {
    if (header.length < 10 || header[3]! < 2 || header[3]! > 4 || [...header.subarray(6, 10)].some(value => value & 0x80)) return false;
    offset = 10 + ((header[6]! << 21) | (header[7]! << 14) | (header[8]! << 7) | header[9]!) + ((header[5]! & 0x10) && header[3] === 4 ? 10 : 0);
    if (offset > 1024 * 1024) return false;
  }
  const first = mp3Frame(await readAt(file, 4, offset));
  if (!first || offset + first.length + 4 > size) return false;
  const second = mp3Frame(await readAt(file, 4, offset + first.length));
  return !!second && first.format === second.format && offset + first.length + second.length <= size;
}
async function isWav(file: FileHandle, size: number): Promise<boolean> {
  const header = await readAt(file, 12, 0);
  if (header.length !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' || header.readUInt32LE(4) + 8 !== size) return false;
  let pos = 12, format = false, data = false;
  for (let count = 0; count < 1024 && pos + 8 <= size && pos < 1024 * 1024; count++) {
    const chunk = await readAt(file, 8, pos); if (chunk.length !== 8) return false;
    const name = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4), start = pos + 8;
    if (start + length > size) return false;
    if (name === 'fmt ') {
      if (length < 16) return false;
      const fmt = await readAt(file, 16, start);
      const tag = fmt.readUInt16LE(0), channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
      format = [1, 3, 0xfffe].includes(tag) && channels > 0 && channels <= 8 && rate > 0 && rate <= 384000 && bits > 0 && bits <= 64;
    }
    if (name === 'data') { data = length > 0; if (format && data) return true; }
    pos = start + length + (length & 1);
  }
  return false;
}
type Mp4Box = { type: string; start: number; end: number };
type BoxBudget = { remaining: number };

// Inspect only box headers and a few fixed-size metadata fields. All box
// walks share one budget, and each child must fit exactly inside its parent.
async function mp4Boxes(file: FileHandle, start: number, end: number, budget: BoxBudget): Promise<Mp4Box[] | undefined> {
  const boxes: Mp4Box[] = [];
  while (start < end) {
    if (--budget.remaining < 0 || end - start < 8) return;
    const header = await readAt(file, Math.min(16, end - start), start);
    if (header.length < 8) return;
    const length32 = header.readUInt32BE(0), type = header.toString('latin1', 4, 8);
    let length = length32 === 0 ? end - start : length32;
    let headerSize = 8;
    if (length32 === 1) {
      if (header.length < 16) return;
      const extended = header.readBigUInt64BE(8);
      if (extended > BigInt(end - start)) return;
      length = Number(extended); headerSize = 16;
    }
    if (length < headerSize || length > end - start) return;
    boxes.push({ type, start: start + headerSize, end: start + length });
    start += length;
  }
  return boxes;
}
function mp4Child(boxes: Mp4Box[], type: string): Mp4Box | undefined {
  return boxes.find(box => box.type === type);
}
async function mp4Track(file: FileHandle, track: Mp4Box, budget: BoxBudget): Promise<{ id: number; samples: boolean } | undefined> {
  const children = await mp4Boxes(file, track.start, track.end, budget);
  if (!children) return;
  const tkhd = mp4Child(children, 'tkhd'), mdia = mp4Child(children, 'mdia');
  if (!tkhd || !mdia) return;
  const trackHeader = await readAt(file, Math.min(24, tkhd.end - tkhd.start), tkhd.start);
  if (trackHeader.length < 16 || (trackHeader[0] !== 0 && trackHeader[0] !== 1)) return;
  const idOffset = trackHeader[0] === 1 ? 20 : 12;
  if (tkhd.end - tkhd.start < (trackHeader[0] === 1 ? 96 : 84) || trackHeader.length < idOffset + 4) return;
  const id = trackHeader.readUInt32BE(idOffset); if (!id) return;
  const media = await mp4Boxes(file, mdia.start, mdia.end, budget);
  if (!media) return;
  const mdhd = mp4Child(media, 'mdhd'), hdlr = mp4Child(media, 'hdlr'), minf = mp4Child(media, 'minf');
  if (!mdhd || mdhd.end - mdhd.start < 24 || !hdlr || hdlr.end - hdlr.start < 24 || !minf) return;
  const mediaVersion = await readAt(file, 1, mdhd.start);
  if (mediaVersion.length !== 1 || (mediaVersion[0] !== 0 && mediaVersion[0] !== 1) || mdhd.end - mdhd.start < (mediaVersion[0] === 1 ? 36 : 24)) return;
  const handler = await readAt(file, 12, hdlr.start);
  if (handler.length !== 12 || handler[0] !== 0 || handler.toString('latin1', 8, 12) !== 'vide') return;
  const info = await mp4Boxes(file, minf.start, minf.end, budget);
  const stbl = info && mp4Child(info, 'stbl'); if (!stbl) return;
  const tables = await mp4Boxes(file, stbl.start, stbl.end, budget);
  if (!tables) return;
  const stsd = mp4Child(tables, 'stsd'), stsz = mp4Child(tables, 'stsz');
  const offsets = mp4Child(tables, 'stco') ?? mp4Child(tables, 'co64');
  if (!stsd || stsd.end - stsd.start < 8 || !stsz || stsz.end - stsz.start < 12 || !offsets || offsets.end - offsets.start < 8) return;
  const description = await readAt(file, 8, stsd.start);
  if (description.length !== 8 || description[0] !== 0) return;
  const entryCount = description.readUInt32BE(4);
  if (!entryCount || entryCount > 64) return;
  const entries = await mp4Boxes(file, stsd.start + 8, stsd.end, budget);
  if (!entries || entries.length !== entryCount) return;
  const codecs = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01']);
  let videoDescription = false;
  for (const entry of entries) {
    if (!codecs.has(entry.type) || entry.end - entry.start < 78) continue;
    const visual = await readAt(file, 28, entry.start);
    // VisualSampleEntry: width and height are at payload offsets 24 and 26.
    if (visual.length === 28 && visual.readUInt16BE(24) && visual.readUInt16BE(26)) videoDescription = true;
  }
  if (!videoDescription) return;
  const sizes = await readAt(file, 12, stsz.start), chunks = await readAt(file, 8, offsets.start);
  if (sizes.length !== 12 || chunks.length !== 8 || sizes[0] !== 0 || chunks[0] !== 0) return;
  const defaultSize = sizes.readUInt32BE(4), sampleCount = sizes.readUInt32BE(8), chunkCount = chunks.readUInt32BE(4);
  if ((!defaultSize && sampleCount > (stsz.end - stsz.start - 12) / 4)
    || chunkCount > (offsets.end - offsets.start - 8) / (offsets.type === 'co64' ? 8 : 4)) return;
  return { id, samples: sampleCount > 0 && chunkCount > 0 };
}
async function mp4Fragment(file: FileHandle, moof: Mp4Box, tracks: Set<number>, budget: BoxBudget): Promise<boolean> {
  const children = await mp4Boxes(file, moof.start, moof.end, budget);
  if (!children || !children.some(box => box.type === 'mfhd' && box.end - box.start >= 8)) return false;
  for (const traf of children.filter(box => box.type === 'traf')) {
    const parts = await mp4Boxes(file, traf.start, traf.end, budget); if (!parts) return false;
    const tfhd = mp4Child(parts, 'tfhd'), truns = parts.filter(box => box.type === 'trun');
    if (!tfhd || tfhd.end - tfhd.start < 8) continue;
    const header = await readAt(file, 8, tfhd.start);
    if (header.length !== 8 || header[0] !== 0 || !tracks.has(header.readUInt32BE(4))) continue;
    const tfhdFlags = header.readUIntBE(1, 3);
    const tfhdRequired = 8 + (tfhdFlags & 1 ? 8 : 0) + [2, 8, 16, 32].reduce((sum, flag) => sum + (tfhdFlags & flag ? 4 : 0), 0);
    if (tfhd.end - tfhd.start < tfhdRequired) continue;
    for (const trun of truns) {
      if (trun.end - trun.start < 8) continue;
      const run = await readAt(file, 8, trun.start);
      if (run.length !== 8 || (run[0] !== 0 && run[0] !== 1)) continue;
      const flags = run.readUIntBE(1, 3), count = run.readUInt32BE(4);
      const perSample = [0x100, 0x200, 0x400, 0x800].reduce((sum, flag) => sum + (flags & flag ? 4 : 0), 0);
      const required = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + perSample * count;
      if (count > 0 && required <= trun.end - trun.start) return true;
    }
  }
  return false;
}
async function isMp4(file: FileHandle, size: number): Promise<boolean> {
  const budget = { remaining: 4096 };
  const boxes = await mp4Boxes(file, 0, size, budget);
  if (!boxes || boxes[0]?.type !== 'ftyp') return false;
  const ftyp = boxes[0], length = ftyp.end - ftyp.start;
  if (length < 8 || length > 4088 || (length - 8) % 4) return false;
  const brands = await readAt(file, length, ftyp.start);
  if (brands.length !== length) return false;
  const known = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash']);
  const candidates = [brands.toString('latin1', 0, 4)];
  for (let i = 8; i + 4 <= brands.length; i += 4) candidates.push(brands.toString('latin1', i, i + 4));
  if (!candidates.some(brand => known.has(brand)) || !boxes.some(box => box.type === 'mdat' && box.end > box.start)) return false;
  const moov = mp4Child(boxes, 'moov'); if (!moov) return false;
  const movie = await mp4Boxes(file, moov.start, moov.end, budget);
  if (!movie) return false;
  const mvhd = mp4Child(movie, 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 100) return false;
  const movieVersion = await readAt(file, 1, mvhd.start);
  if (movieVersion.length !== 1 || (movieVersion[0] !== 0 && movieVersion[0] !== 1) || mvhd.end - mvhd.start < (movieVersion[0] === 1 ? 112 : 100)) return false;
  const tracks: Array<{ id: number; samples: boolean }> = [];
  for (const track of movie.filter(box => box.type === 'trak')) {
    const parsed = await mp4Track(file, track, budget); if (budget.remaining < 0) return false; if (parsed) tracks.push(parsed);
  }
  if (!tracks.length) return false;
  if (tracks.some(track => track.samples)) return true;
  const ids = new Set(tracks.map(track => track.id));
  for (const moof of boxes.filter(box => box.type === 'moof')) if (await mp4Fragment(file, moof, ids, budget)) return true;
  return false;
}

/** Open the current workspace file and bind every read to its validated descriptor. */
export async function openWorkspaceMedia(workspace: string, path: string | null, kind: WorkspaceMediaKind) {
  if (!safeWorkspacePath(path) || !(kind === 'audio' ? /\.(?:wav|mp3)$/iu : /\.mp4$/iu).test(path)) return null;
  let rootHandle: FileHandle | undefined, file: FileHandle | undefined;
  try {
    const root = await realpath(workspace), rootIdentity = await stat(root, { bigint: true });
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedRoot = await rootHandle.stat({ bigint: true });
    if (!openedRoot.isDirectory() || openedRoot.dev !== rootIdentity.dev || openedRoot.ino !== rootIdentity.ino || await descriptorPath(rootHandle.fd) !== root) return null;
    const canonical = await realpath(resolve(root, path));
    if (!contained(root, canonical)) return null;
    file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fileHandle = file, workspaceHandle = rootHandle;
    const before = await fileHandle.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(MAX_WORKSPACE_MEDIA_BYTES)) return null;
    const check = async () => {
      try { return same(before, await fileHandle.stat({ bigint: true })) && contained(root, await descriptorPath(fileHandle.fd)) && await descriptorPath(workspaceHandle.fd) === root; }
      catch { return false; }
    };
    if (!await check()) return null;
    const size = Number(before.size);
    const mediaType = kind === 'video' ? 'video/mp4' : /\.wav$/iu.test(path) ? 'audio/wav' : 'audio/mpeg';
    const valid = mediaType === 'video/mp4' ? await isMp4(file, size) : mediaType === 'audio/wav' ? await isWav(file, size) : await isMp3(file, size);
    if (!valid || !await check()) return null;
    const version = createHash('sha256').update(JSON.stringify(identity(before))).digest('hex');
    const result = { handle: fileHandle, size, mediaType, version, check, close: async () => { await fileHandle.close(); await workspaceHandle.close(); } };
    file = undefined; rootHandle = undefined;
    return result;
  } catch { return null; }
  finally { await file?.close(); await rootHandle?.close(); }
}
