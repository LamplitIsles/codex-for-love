import { MAX_MESSAGE_LENGTH } from "../src/lib/message-input.ts";
import { InvalidImageInput, imageInputSchema, messageBodyLimit } from './images.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import sirv from 'sirv';
import { z } from 'zod';
import { MAX_VOICE_DATA_URL_BYTES, normalizeVoiceMediaType } from '../src/lib/companion/voice-contract.ts';
import type { Partner } from './partner.ts';

async function body(request: IncomingMessage, limit = 65536): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export function createWebServer(partner: Partner, assets: string) {
  const serve = sirv(assets, {
    single: true,
    setHeaders(response, pathname) {
      if (pathname.includes('/_app/immutable/'))
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else if (pathname === '/' || pathname.endsWith('.html') || extname(pathname) === '')
        response.setHeader('cache-control', 'no-cache');
    },
  });
  const streams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-frame-options', 'DENY');
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/api/')) return serve(request, response);
      if (path === '/api/voice/transcribe' && request.method === 'POST') {
        const mediaType = normalizeVoiceMediaType(request.headers['content-type']);
        if (!mediaType) return json(response, { error: '不支持的录音格式' }, 415);
        const abort = new AbortController();
        const onClose = () => abort.abort(); response.once('close', onClose);
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]);
        const onAbort = () => { if (!response.writableEnded) response.destroy(); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += chunk.length;
            if (Math.ceil(size / 3) * 4 + mediaType.length + 13 > MAX_VOICE_DATA_URL_BYTES) {
              json(response, { error: '录音过大，请缩短后重试' }, 413); return;
            }
            chunks.push(chunk);
          }
          const result = await partner.transcribe(Buffer.concat(chunks), mediaType, signal);
          json(response, result); return;
        } finally { response.off('close', onClose); signal.removeEventListener('abort', onAbort); }
      }
      if (path === '/api/session' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
        const options = z.object({ before: cursor.optional(), after: cursor.optional() }).strict().refine(value => value.before === undefined || value.after === undefined).parse(params);
        return json(response, await partner.snapshot(options));
      }
      if (path === '/api/diary' && request.method === 'GET') {
        try { return json(response, { entries: await partner.diary() }); }
        catch { return json(response, { error: 'Diary unavailable' }, 500); }
      }
      if (path.startsWith('/api/diary/') && request.method === 'GET') {
        const name = path.slice('/api/diary/'.length);
        try {
          const text = await partner.diaryEntry(name);
          return text === 'too-large' ? json(response, { error: 'Diary entry too large' }, 413) : text === undefined ? json(response, { error: 'Diary entry not found' }, 404) : json(response, { name, text });
        } catch { return json(response, { error: 'Diary unavailable' }, 500); }
      }
      if (path.startsWith('/api/images/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(path.slice('/api/images/'.length));
        const image = await partner.image(id);
        if (!image) return json(response, { error: 'Image not found' }, 404);
        response.writeHead(200, { 'content-type': image.media_type, 'cache-control': 'private, max-age=31536000, immutable' });
        response.end(image.data); return;
      }
      if (path === '/api/voice/synthesize' && request.method === 'POST') {
        const parsed = z.object({ text: z.string().trim().min(1).max(240) }).strict().parse(await body(request));
        const abort = new AbortController(); response.once('close', () => abort.abort());
        const id = await partner.synthesize(parsed.text, abort.signal); return json(response, { url: `/api/audio/${id}.mp3` });
      }
      if (path.startsWith('/api/audio/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}\.mp3$/u).parse(path.slice('/api/audio/'.length));
        const audio = await partner.audio(id.slice(0, -4)); if (!audio) return json(response, { error: 'Audio not found' }, 404);
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=31536000, immutable' }); response.end(audio); return;
      }
      if (path.startsWith('/api/avatars/') && request.method === 'GET') {
        const kind = z.enum(['companion', 'user']).parse(path.slice('/api/avatars/'.length));
        const avatar = partner.avatar(kind);
        if (!avatar) return json(response, { error: 'Avatar not found' }, 404);
        response.writeHead(200, { 'content-type': avatar.mediaType, 'cache-control': 'no-store' });
        response.end(avatar.data); return;
      }
      if (path === '/api/messages' && request.method === 'POST') {
        const parsed = z.object({ id: z.uuid(), input: z.string().trim().max(MAX_MESSAGE_LENGTH), images: z.array(imageInputSchema).max(5).default([]), replaces: z.array(z.uuid()).max(20).default([]) }).strict().refine(value => value.input.length > 0 || value.images.length > 0).safeParse(await body(request, messageBodyLimit));
        if (!parsed.success) return json(response, { error: '消息内容无效，请检查文字长度和图片后重新发送。', code: 'invalid_message' }, 422);
        const { id, input, images, replaces } = parsed.data;
        await partner.submit(id, input, images, replaces);
        return json(response, { id }, 202);
      }
      if (path === '/api/compact' && request.method === 'POST') { await partner.compact(); return json(response, { ok: true }); }
      if (path === '/api/cancel' && request.method === 'POST') {
        const { id } = z.object({ id: z.string().min(1).max(300) }).strict().parse(await body(request));
        await partner.cancel(id); return json(response, { ok: true });
      }
      if (path === '/api/events' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        streams.add(response);
        // Notifications only invalidate the view. Reconnect always obtains an
        // authoritative snapshot; this stream is not a replayable execution log.
        const invalidate = () => {
          if (!response.write('data: changed\n\n')) response.end();
        };
        const off = partner.subscribe(invalidate);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        invalidate();
        response.once('close', () => { off(); clearInterval(heartbeat); streams.delete(response); });
        return;
      }
      json(response, { error: 'Not found' }, 404);
    } catch (error) {
      if (!response.headersSent && error instanceof InvalidImageInput) return json(response, { error: '消息内容无效，请检查文字长度和图片后重新发送。', code: 'invalid_message' }, 422);
      if (!response.headersSent) json(response, { error: '未能完成请求，请稍后重试' }, 400);
      else response.end();
    }
  });
  return { server, async close() {
    for (const response of streams) response.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await partner.close();
  } };
}
