import type { IncomingMessage, ServerResponse } from 'node:http';
import { WORKSPACE_MEDIA_CHUNK_BYTES, type openWorkspaceMedia } from './workspace-media.ts';

type OpenMedia = NonNullable<Awaited<ReturnType<typeof openWorkspaceMedia>>>;
function rangeOf(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return;
  return { start, end: Math.min(end, size - 1) };
}
function waitDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); };
    const drain = () => { clean(); resolve(); };
    const close = () => { clean(); reject(new Error('Media response closed')); };
    const error = (reason: Error) => { clean(); reject(reason); };
    response.once('drain', drain); response.once('close', close); response.once('error', error);
    if (response.destroyed) close();
  });
}

/** The caller owns the handle and closes it on completion, error or disconnect. */
export async function sendWorkspaceMedia(request: IncomingMessage, response: ServerResponse, file: OpenMedia, authorized: () => Promise<boolean>) {
  const allowed = async () => !response.destroyed && await authorized() && await file.check();
  if (!await allowed()) { if (!response.destroyed) { response.writeHead(401, { 'cache-control': 'private, no-store' }); response.end(); } return; }
  const etag = `W/"${file.version}"`;
  const common = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'etag': etag, 'x-cfl-media-version': file.version };
  const version = request.headers['if-cfl-media-version'];
  if (version !== undefined && (typeof version !== 'string' || version !== file.version)) { response.writeHead(412, common); response.end(); return; }
  const noneMatch = request.headers['if-none-match'];
  if (typeof noneMatch === 'string' && noneMatch.split(',').some(value => value.trim() === etag || value.trim() === `"${file.version}"` || value.trim() === '*')) {
    response.writeHead(304, common); response.end(); return;
  }
  // The metadata-derived ETag is weak: If-Range cannot establish a strong
  // validator, so a client using it receives a complete 200 response instead.
  const requested = request.headers['if-range'] === undefined ? request.headers.range : undefined;
  const range = requested === undefined ? undefined : rangeOf(requested, file.size);
  if (requested !== undefined && !range) { response.writeHead(416, { ...common, 'content-range': `bytes */${file.size}` }); response.end(); return; }
  const start = range?.start ?? 0, end = range?.end ?? file.size - 1;
  response.writeHead(range ? 206 : 200, { ...common, 'content-type': file.mediaType, 'content-length': end - start + 1,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}) });
  let position = start;
  try {
    while (position <= end) {
      if (!await allowed()) { response.destroy(); return; }
      const chunk = Buffer.allocUnsafe(Math.min(WORKSPACE_MEDIA_CHUNK_BYTES, end - position + 1));
      const { bytesRead } = await file.handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead || !await allowed()) { response.destroy(); return; }
      position += bytesRead;
      if (!response.write(chunk.subarray(0, bytesRead))) await waitDrain(response);
    }
    if (!response.destroyed) response.end();
  } catch { response.destroy(); }
}
