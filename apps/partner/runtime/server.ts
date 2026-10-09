import { matrixEvent } from './matrix.ts';
import { APPEARANCE_PATH } from '@lamplit/contracts';
import { imageHttp } from '@lamplit/contracts/server';
import { createChatSocket } from './chat.ts';
import { createVoiceHost, type VoiceDependencies } from './voice.ts';
import { VOICE_CAPABILITY_PATH, VOICE_STREAM_PATH } from '@lamplit/contracts/voice';
import { MAX_MESSAGE_LENGTH } from "./message-input.ts";
import { InvalidImageInput, imageInputSchema, messageBodyLimit } from './images.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { keetEvent } from './keet.ts';
import sirv from 'sirv';
import { z } from 'zod';
import { MAX_VOICE_DATA_URL_BYTES, normalizeVoiceMediaType } from './voice-contract.ts';
import type { Partner } from './partner.ts';
import { PET_ACTIVITIES } from './pet.ts';
import type { ConversationSearch } from './conversation-search.ts';

const keetEventBodyLimit = 128 * 1024;

async function body(request: IncomingMessage, limit = 65536): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** Cancellation drains the HTTP body rather than destroying the response socket. */
function requestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      request.on('data', chunk => { if (!cancelled) controller.enqueue(chunk); });
      request.once('end', () => { if (!cancelled) controller.close(); });
      request.once('error', error => { if (!cancelled) controller.error(error); });
    },
    cancel() { cancelled = true; request.resume(); },
  });
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export function isLoopbackPeer(peer: string | undefined): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

export function createWebServer(partner: Partner, assets: string, options: { authorize?: (request: IncomingMessage) => Promise<boolean>; voice?: VoiceDependencies; heartbeatMs?: number; conversationSearch?: ConversationSearch } = {}) {
  const serve = sirv(assets, {
    single: false,
    setHeaders(response, pathname) {
      if (/\/assets\/[^/]+-[\w-]{8,}\.[\w.]+$/u.test(pathname))
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else if (pathname === '/' || pathname.endsWith('.html') || extname(pathname) === '')
        response.setHeader('cache-control', 'no-cache');
    },
  });
  const authorize = async (request: IncomingMessage) => {
    try { return options.authorize ? await options.authorize(request) : true; } catch { return false; }
  };
  const streams = new Set<ServerResponse>();
  const voice = createVoiceHost(() => partner.voiceCredential(), options.voice);
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-frame-options', 'DENY');
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/api/')) {
        if (path === '/chat') request.url = '/';
        return serve(request, response, () => json(response, { error: 'Not found' }, 404));
      }
      if (!await authorize(request)) return json(response, { error: 'Unauthorized' }, 401);
      if (request.headers.origin && ![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(request.headers.origin)) return json(response, { error: 'Forbidden origin' }, 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, { error: 'Forbidden origin' }, 403);
      if (path === APPEARANCE_PATH) {
        if (request.method !== 'GET') return json(response, { error: 'Method not allowed' }, 405);
        return json(response, partner.appearance());
      }
      if (path === '/api/chat/images' || path.startsWith('/api/chat/media/')) {
        // The same-host Origin above is validated before reconstructing the external POST URL.
        const origin = request.method === 'POST' && request.headers.origin ? request.headers.origin : `http://${request.headers.host}`;
        const webRequest = new Request(`${origin}${request.url}`, {
          method: request.method,
          headers: new Headers(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]])),
          ...(request.method === 'POST' ? { body: requestBody(request), duplex: 'half' } : {}),
        } as RequestInit);
        const result = await imageHttp(webRequest, { upload: value => partner.uploadImages(value, () => authorize(request)), media: (id, variant) => partner.sharedMedia(id, variant) }, async () => {
          if (!await authorize(request)) return null;
          return { sessionId: (await partner.snapshot()).sessionId, limits: await partner.sharedImageLimits() };
        });
        response.writeHead(result!.status, Object.fromEntries(result!.headers));
        response.end(Buffer.from(await result!.arrayBuffer())); return;
      }
      if (path === VOICE_CAPABILITY_PATH) return json(response, request.method === 'GET' ? { available: voice.available() } : { code: 'method_not_allowed' }, request.method === 'GET' ? 200 : 405);
      if (path === VOICE_STREAM_PATH) return json(response, { code: 'upgrade_required' }, 426);
      if (path === '/api/matrix/events' && request.method === 'POST') {
        if (!partner.matrixEnabled) return json(response, { error: 'Matrix ingress unavailable' }, 404);
        if (!isLoopbackPeer(request.socket.remoteAddress)) return json(response, { error: 'Local delivery only' }, 403);
        let raw: unknown;
        try { raw = await body(request, 256 * 1024); }
        catch { return json(response, { error: 'Invalid Matrix event' }, 400); }
        const parsed = matrixEvent.safeParse(raw);
        if (!parsed.success) return json(response, { error: 'Invalid Matrix event' }, 422);
        try { await partner.ingestMatrix(parsed.data); }
        catch { return json(response, { error: 'Matrix admission unavailable' }, 503); }
        return json(response, { accepted: true }, 202);
      }
      if (path === '/api/keet/events' && request.method === 'POST') {
        if (!partner.keetEnabled) return json(response, { error: 'Keet ingress unavailable' }, 404);
        const peer = request.socket.remoteAddress;
        if (!isLoopbackPeer(peer))
          return json(response, { error: 'Local delivery only' }, 403);
        let raw: unknown;
        try { raw = await body(request, keetEventBodyLimit); }
        catch { return json(response, { error: 'Invalid Keet event' }, 400); }
        const parsed = keetEvent.safeParse(raw);
        if (!parsed.success) return json(response, { error: 'Invalid Keet event' }, 422);
        try { await partner.ingestKeet(parsed.data); }
        catch { return json(response, { error: 'Keet admission unavailable' }, 503); }
        return json(response, { accepted: true }, 202);
      }
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
      if (path === '/api/conversation-search' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const parsed = z.object({ q: z.string().trim().min(1).max(500) }).strict().safeParse(params);
        if (!parsed.success) return json(response, { error: 'Invalid search query' }, 400);
        try {
          if (!options.conversationSearch) throw new Error('Search unavailable');
          return json(response, await options.conversationSearch.search(parsed.data.q));
        } catch { return json(response, { error: 'Search unavailable' }, 503); }
      }
      if (path.startsWith('/api/conversation-search/') && request.method === 'GET') {
        const id = path.slice('/api/conversation-search/'.length);
        if (!/^[a-f0-9]{64}$/u.test(id)) return json(response, { error: 'Invalid record id' }, 400);
        try {
          if (!options.conversationSearch) throw new Error('Search unavailable');
          return json(response, await options.conversationSearch.read(id));
        } catch { return json(response, { error: 'Record unavailable' }, 404); }
      }
      if (path === '/api/diary' && request.method === 'GET') {
        try { return json(response, { entries: await partner.diary() }); }
        catch { return json(response, { error: 'Diary unavailable' }, 500); }
      }
      if (path === '/api/alarms' && request.method === 'GET') return json(response, { alarms: partner.alarms() });
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
      if (path === '/api/conversation-images' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const options = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(500).optional() }).strict().parse(params);
        return json(response, await partner.conversationImages(options));
      }
      if (path.startsWith('/api/conversation-images/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(path.slice('/api/conversation-images/'.length));
        const image = await partner.conversationImage(id);
        if (!image) return json(response, { error: 'Image not found' }, 404);
        response.writeHead(200, { 'content-type': image.media_type, 'cache-control': 'private, max-age=31536000, immutable' }); response.end(image.data); return;
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
      if (path.startsWith('/api/backgrounds/') && request.method === 'GET') {
        const kind = z.enum(['landscape', 'portrait']).parse(path.slice('/api/backgrounds/'.length));
        const background = partner.background(kind);
        if (!background) return json(response, { error: 'Background not found' }, 404);
        response.writeHead(200, { 'content-type': background.mediaType, 'cache-control': 'no-store' });
        response.end(background.data); return;
      }
      if (path.startsWith('/api/pet-assets/') && request.method === 'GET') {
        const activity = path.slice('/api/pet-assets/'.length);
        if (!PET_ACTIVITIES.includes(activity as typeof PET_ACTIVITIES[number])) return json(response, { error: 'Pet asset not found' }, 404);
        const asset = await partner.petAsset(activity as typeof PET_ACTIVITIES[number]);
        if (!asset) return json(response, { error: 'Pet asset not found' }, 404);
        const metadata = asset.manifest.clips[activity as typeof PET_ACTIVITIES[number]];
        response.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store', 'x-pet-frame-count': String(metadata.frameCount), 'x-pet-fps': String(metadata.fps), 'x-pet-loop': String(metadata.loop) });
        response.end(asset.data); return;
      }
      if (path === '/api/messages' && request.method === 'POST') {
        const parsed = z.object({ id: z.uuid(), input: z.string().trim().max(MAX_MESSAGE_LENGTH), images: z.array(imageInputSchema).max(5).default([]), replaces: z.array(z.uuid()).max(20).default([]) }).strict().refine(value => value.input.length > 0 || value.images.length > 0).safeParse(await body(request, messageBodyLimit));
        if (!parsed.success) return json(response, { error: '消息内容无效，请检查文字长度和图片后重新发送。', code: 'invalid_message' }, 422);
        const { id, input, images, replaces } = parsed.data;
        await partner.submit(id, input, images, replaces);
        return json(response, { id }, 202);
      }
      if (path === '/api/compact' && request.method === 'POST') {
        const { sessionId } = await partner.snapshot();
        const result = await partner.compact({ sessionId, authorize: () => authorize(request) });
        if (!result.accepted) throw new Error('Cannot compact while the conversation is working');
        return json(response, { ok: true }, 202);
      }
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
        // Comments are invisible to EventSource consumers.  A named event lets
        // the page distinguish a live stream from a silently stale carrier.
        const heartbeat = setInterval(() => response.write('event: heartbeat\ndata: live\n\n'), options.heartbeatMs ?? 15000);
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
  const chat = createChatSocket(partner, authorize, options.conversationSearch);
  server.on('upgrade', async (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const origin = request.headers.origin;
    const authority = request.headers.host;
    const sameOrigin = origin === `http://${authority}` || origin === `https://${authority}`;
    const allowed = sameOrigin || (path === '/api/chat/socket' && !origin && isLoopbackPeer(request.socket.remoteAddress));
    const target = path === '/api/chat/socket' ? chat.sockets : path === VOICE_STREAM_PATH ? voice.sockets : undefined;
    if (request.method !== 'GET' || !target || !allowed || (!await authorize(request))) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request));
  });
  return { server, chatSockets: chat.sockets, async close() {
    voice.close();
    await chat.close();
    for (const response of streams) response.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await partner.close();
  } };
}
