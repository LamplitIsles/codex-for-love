import sharp from 'sharp';
import { writeFile, open } from 'node:fs/promises';
import { postEndpoint } from './config.ts';
import { Asset, Id, type AssetV1 } from './post-contract.ts';
import { imageLimits, inputImages, materializeImages, type MaterializedInputImage } from './images.ts';

export const postAssetLimit = 16 * 1024 * 1024;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Post asset unavailable'); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('Post asset exceeds limit'); chunks.push(value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function assetUrl(endpoint: string, id: string): URL {
  const path = `/assets/${encodeURIComponent(Id.parse(id))}`;
  const url = new URL(path, postEndpoint(endpoint));
  if (url.pathname !== path) throw new Error('Post asset route is unavailable');
  return url;
}
export async function fetchPostAsset(endpoint: string, token: string, asset: Pick<AssetV1, 'asset_id' | 'mime' | 'size'>, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(assetUrl(endpoint, asset.asset_id), {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  if (response.headers.get('content-type')?.split(';')[0].trim() !== asset.mime) { await response.body?.cancel(); throw new Error('Post asset MIME mismatch'); }
  const bytes = await boundedBody(response, postAssetLimit);
  if (!bytes.length || (asset.size !== null && bytes.length !== asset.size)) throw new Error('Post asset size mismatch');
  return bytes;
}
async function validateImage(bytes: Buffer, mime: string): Promise<void> {
  if (!(mime in formats)) throw new Error('Unsupported Post image');
  const source = sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'error' });
  const meta = await source.metadata();
  if (meta.format !== formats[mime as keyof typeof formats] || !meta.width || !meta.height || meta.width > 20_000 || meta.height > 20_000) throw new Error('Invalid Post image');
  await source.stats();
}
export async function postImage(workspace: string, endpoint: string, token: string, inputId: string, asset: AssetV1, signal: AbortSignal): Promise<MaterializedInputImage> {
  const bytes = await fetchPostAsset(endpoint, token, asset, signal);
  await validateImage(bytes, asset.mime);
  if (bytes.length > imageLimits.maxImageBytes) throw new Error('Post image exceeds model limit');
  signal.throwIfAborted();
  return (await materializeImages(workspace, inputImages(inputId, [{ type: 'image', mediaType: asset.mime as keyof typeof formats, name: `post-${asset.asset_id.slice(0, 80)}.${asset.mime.slice(6)}`, data: bytes.toString('base64') }])))[0]!;
}
/** Explicit terminal helper: token comes from private credentials, never argv/output. */
export async function uploadPostAsset(endpoint: string, token: string, path: string, mime: string): Promise<AssetV1> {
  if (!/^[\w.+-]+\/[\w.+-]+$/u.test(mime)) throw new Error('Invalid Post upload MIME');
  const file = await open(path, 'r');
  const chunks: Buffer[] = []; let size = 0;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > postAssetLimit) throw new Error('Invalid Post upload');
    for await (const chunk of file.createReadStream()) { size += chunk.length; if (size > postAssetLimit) throw new Error('Post upload exceeds limit'); chunks.push(chunk); }
  } finally { await file.close(); }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length || bytes.length > postAssetLimit) throw new Error('Invalid Post upload size');
  if (mime.startsWith('image/')) await validateImage(bytes, mime);
  const response = await fetch(`${postEndpoint(endpoint)}/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': mime }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 201) { await response.body?.cancel(); throw new Error('Post upload unavailable'); }
  return Asset.parse(JSON.parse((await boundedBody(response, 32 * 1024)).toString()));
}
export async function savePostAsset(endpoint: string, token: string, assetId: string, mime: string, path: string): Promise<void> {
  const bytes = await fetchPostAsset(endpoint, token, { asset_id: assetId, mime, size: null });
  if (mime.startsWith('image/')) await validateImage(bytes, mime);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}
