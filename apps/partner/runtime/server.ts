import { APPEARANCE_PATH, WORKSPACE_IMAGE_PATH } from '@lamplit/contracts';
import { imageHttp } from '@lamplit/contracts/server';
import { createChatSocket } from './chat.ts';
import { createVoiceHost, type VoiceDependencies } from './voice.ts';
import { VOICE_CAPABILITY_PATH, VOICE_STREAM_PATH } from '@lamplit/contracts/voice';
import { MAX_MESSAGE_LENGTH } from "./message-input.ts";
import { InvalidImageInput, imageInputSchema, messageBodyLimit } from './images.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { processLog } from './logging.ts';
import { keetEvent } from './keet.ts';
import sirv from 'sirv';
import { z } from 'zod';
import { MAX_VOICE_DATA_URL_BYTES, normalizeVoiceMediaType } from './voice-contract.ts';
import type { Partner } from './partner.ts';
import { PET_ACTIVITIES } from './pet.ts';
import type { ConversationSearch } from './conversation-search.ts';
import { AuthFailure, type AuthStore } from './auth.ts';
import { receiverAuthorized } from './post.ts';

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
export function createWebServer(partner: Partner, assets: string, options: { auth: AuthStore; keetReceiver?: string; voice?: VoiceDependencies; heartbeatMs?: number; conversationSearch?: ConversationSearch }) {
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
    try { return await options.auth.authorize(request); } catch { return false; }
  };
  const streams = new Map<ServerResponse, IncomingMessage>();
  const activeSockets = new Map<import('ws').WebSocket, IncomingMessage>();
  const transcriptions = new Map<AbortController, IncomingMessage>();
  const stillAuthorized = (request: IncomingMessage) => {
    try { return options.auth.authorize(request); } catch { return false; }
  };
  const revokeConnections = () => {
    for (const [socket, request] of activeSockets) if (!stillAuthorized(request)) socket.terminate();
    for (const [response, request] of streams) if (!stillAuthorized(request)) response.end();
    for (const [controller, request] of transcriptions) if (!stillAuthorized(request)) controller.abort();
  };
  const revocationTimer = setInterval(revokeConnections, 1000);
  revocationTimer.unref();
  const voice = createVoiceHost(() => partner.voiceCredential(), options.voice);
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-frame-options', 'DENY');
    let human = false;
    const unauthorized = () => json(response, { error: { code: 'unauthorized', message: 'Sign in to continue.' } }, 401);
    const humanJson = (value: unknown, status = 200) => stillAuthorized(request) ? json(response, value, status) : unauthorized();
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/api/post/events' && request.method === 'POST') response.once('close', () => processLog('post.receiver', { status: response.writableFinished ? response.statusCode : 0 }));
      if (path === '/.well-known/oauth-authorization-server/api/auth') {
        if (request.method !== 'GET') return json(response, { error: 'Method not allowed' }, 405);
        await options.auth.handle(request, response, revokeConnections); return;
      }
      if (!path.startsWith('/api/')) {
        if (path === '/chat' || path === '/consent') request.url = '/';
        return serve(request, response, () => json(response, { error: 'Not found' }, 404));
      }
      const serviceRoute = request.method === 'POST' && (path === '/api/post/events' || path === '/api/keet/events');
      if (path.startsWith('/api/auth/')) {
        const fail = (code: string, message: string, status: number) => json(response, { error: { code, message } }, status);
        if (path === '/api/auth/status') {
          if (request.method !== 'GET') return fail('method_not_allowed', 'Method not allowed', 405);
          return json(response, { mode: 'passkey', state: options.auth.status(request) });
        }
        if (path === '/api/auth/pairing' || path === '/api/auth/consent-details') {
          if (request.method !== 'POST') return fail('method_not_allowed', 'Method not allowed', 405);
          if (!options.auth.sameOrigin(request)) return fail('forbidden_origin', 'Open the configured site origin and try again.', 403);
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('invalid_request', 'Expected a JSON request.', 400);
          if (path === '/api/auth/consent-details' && !options.auth.authorizeSession(request)) return fail('unauthorized', 'Sign in to continue.', 401);
          let input: unknown;
          try { input = await body(request); } catch { return fail('invalid_request', 'Invalid JSON request.', 400); }
          if (path === '/api/auth/pairing') {
            const parsed = z.object({ code: z.string().min(1).max(256) }).strict().safeParse(input);
            if (!parsed.success) return fail('invalid_request', 'Enter a pairing code.', 400);
            try { response.setHeader('set-cookie', options.auth.pairingCookie(parsed.data.code)); return json(response, { ok: true }); }
            catch (error) { if (error instanceof AuthFailure) return fail(error.code, 'Pairing code is invalid or expired; generate a new code on the host.', 401); throw error; }
          }
          const parsed = z.object({ oauth_query: z.string().min(1).max(16384) }).strict().safeParse(input);
          if (!parsed.success) return fail('invalid_oauth_request', 'Authorization request is invalid or expired.', 400);
          try { return json(response, await options.auth.consentDetails(parsed.data.oauth_query)); }
          catch { return fail('invalid_oauth_request', 'Authorization request is invalid or expired.', 400); }
        }
        const allowed = new Set([
          '/api/auth/passkey/generate-register-options', '/api/auth/passkey/verify-registration',
          '/api/auth/passkey/generate-authenticate-options', '/api/auth/passkey/verify-authentication',
          '/api/auth/get-session', '/api/auth/sign-out', '/api/auth/oauth2/authorize',
          '/api/auth/oauth2/consent', '/api/auth/oauth2/continue', '/api/auth/oauth2/token',
          '/api/auth/oauth2/revoke', '/api/auth/oauth2/introspect',
        ]);
        if (!allowed.has(path)) return fail('invalid_request', 'Not found.', 404);
        const authorizationNavigation = path === '/api/auth/oauth2/authorize' && request.method === 'GET';
        const nativeEndpoint = ['/api/auth/oauth2/token', '/api/auth/oauth2/revoke', '/api/auth/oauth2/introspect'].includes(path);
        if (request.method !== 'GET' && !nativeEndpoint && !options.auth.sameOrigin(request)) return fail('forbidden_origin', 'Open the configured site origin and try again.', 403);
        if (!authorizationNavigation && request.headers['sec-fetch-site'] === 'cross-site') return fail('forbidden_origin', 'Open the configured site origin and try again.', 403);
        if (!authorizationNavigation && request.headers.origin && !options.auth.sameOrigin(request)) return fail('forbidden_origin', 'Open the configured site origin and try again.', 403);
        response.setHeader('cache-control', 'no-store');
        await options.auth.handle(request, response, revokeConnections);
        return;
      }
      if (!serviceRoute) {
        human = true;
        if (!await authorize(request)) return unauthorized();
        if ((request.method !== 'GET' && request.method !== 'HEAD') || request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') {
          if (!options.auth.sameOrigin(request)) return json(response, { error: { code: 'forbidden_origin', message: 'Open the configured site origin and try again.' } }, 403);
        }
      }
      if (path === APPEARANCE_PATH) {
        if (request.method !== 'GET') return json(response, { error: 'Method not allowed' }, 405);
        return json(response, partner.appearance());
      }
      if (path === WORKSPACE_IMAGE_PATH) {
        if (request.method !== 'GET') return json(response, { error: 'Method not allowed' }, 405);
        // searchParams has already decoded the query; preserve literal % paths.
        const image = await partner.workspaceImage(new URL(request.url!, 'http://localhost').searchParams.get('path'));
        if (!stillAuthorized(request)) return unauthorized();
        if (!image) return json(response, { error: 'Workspace image unavailable' }, 404);
        response.writeHead(200, { 'content-type': image.mediaType, 'cache-control': 'no-store' });
        response.end(image.bytes); return;
      }
      if (path === '/api/chat/images' || path.startsWith('/api/chat/media/')) {
        // The same-host Origin above is validated before reconstructing the external POST URL.
        const origin = options.auth.origin;
        const webRequest = new Request(`${origin}${request.url}`, {
          method: request.method,
          headers: new Headers(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value] as [string,string]])),
          ...(request.method === 'POST' ? { body: requestBody(request), duplex: 'half' } : {}),
        } as RequestInit);
        const result = await imageHttp(webRequest, { upload: value => partner.uploadImages(value, () => authorize(request), () => stillAuthorized(request)), media: (id, variant) => partner.sharedMedia(id, variant) }, async () => {
          if (!await authorize(request)) return null;
          return { sessionId: (await partner.snapshot()).sessionId, limits: await partner.sharedImageLimits() };
        });
        const bytes = Buffer.from(await result!.arrayBuffer());
        if (!stillAuthorized(request)) return unauthorized();
        response.writeHead(result!.status, Object.fromEntries(result!.headers));
        response.end(bytes); return;
      }
      if (path === VOICE_CAPABILITY_PATH) return json(response, request.method === 'GET' ? { available: voice.available() } : { code: 'method_not_allowed' }, request.method === 'GET' ? 200 : 405);
      if (path === VOICE_STREAM_PATH) return json(response, { code: 'upgrade_required' }, 426);
      if (path === '/api/post/events' && request.method === 'POST') {
        if (!partner.postEnabled) return json(response, { error: 'Post ingress unavailable' }, 404);
        if (!partner.authorizePost(request.headers.authorization)) return json(response, { error: 'Unauthorized' }, 401);
        let raw: string;
        const timer = setTimeout(() => request.destroy(), 10_000);
        try {
          if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(response, { error: 'Invalid Post content type' }, 415);
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) return json(response, { error: 'Post event too large' }, 413);
            chunks.push(chunk);
          }
          let value: unknown;
          try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); value = JSON.parse(raw); } catch { return json(response, { error: 'Invalid Post event' }, 400); }
          try { await partner.ingestPost(value,raw); }
          catch (error) {
            const code = (error as { code?: string }).code;
            return json(response, { error: code === 'INVALID_POST_EVENT' ? 'Invalid Post event' : code === 'MESSAGE_IDENTITY_CONFLICT' ? 'Post identity conflict' : 'Post receipt unavailable' }, code === 'INVALID_POST_EVENT' ? 422 : code === 'MESSAGE_IDENTITY_CONFLICT' ? 409 : 503);
          }
        } finally { clearTimeout(timer); }
        return json(response, { accepted: true }, 202);
      }
      if (path === '/api/keet/events' && request.method === 'POST') {
        if (!partner.keetEnabled) return json(response, { error: 'Keet ingress unavailable' }, 404);
        if (!options.keetReceiver || !receiverAuthorized(request.headers.authorization, options.keetReceiver)) return json(response, { error: 'Unauthorized' }, 401);
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
          if (!stillAuthorized(request)) return unauthorized();
          transcriptions.set(abort, request);
          const result = await partner.transcribe(Buffer.concat(chunks), mediaType, signal);
          humanJson(result); return;
        } finally { transcriptions.delete(abort); response.off('close', onClose); signal.removeEventListener('abort', onAbort); }
      }
      if (path === '/api/session' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
        const options = z.object({ before: cursor.optional(), after: cursor.optional() }).strict().refine(value => value.before === undefined || value.after === undefined).parse(params);
        return humanJson(await partner.snapshot(options));
      }
      if (path === '/api/conversation-search' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const parsed = z.object({ q: z.string().trim().min(1).max(500) }).strict().safeParse(params);
        if (!parsed.success) return json(response, { error: 'Invalid search query' }, 400);
        try {
          if (!options.conversationSearch) throw new Error('Search unavailable');
          return humanJson(await options.conversationSearch.search(parsed.data.q));
        } catch { return humanJson({ error: 'Search unavailable' }, 503); }
      }
      if (path.startsWith('/api/conversation-search/') && request.method === 'GET') {
        const id = path.slice('/api/conversation-search/'.length);
        if (!z.uuid().safeParse(id).success) return json(response, { error: 'Invalid record id' }, 400);
        try {
          if (!options.conversationSearch) throw new Error('Search unavailable');
          return humanJson(await options.conversationSearch.read(id));
        } catch { return humanJson({ error: 'Record unavailable' }, 404); }
      }
      if (path === '/api/diary' && request.method === 'GET') {
        try { return humanJson({ entries: await partner.diary() }); }
        catch { return humanJson({ error: 'Diary unavailable' }, 500); }
      }
      if (path === '/api/alarms' && request.method === 'GET') return json(response, { alarms: partner.alarms() });
      if (path.startsWith('/api/diary/') && request.method === 'GET') {
        const name = path.slice('/api/diary/'.length);
        try {
          const text = await partner.diaryEntry(name);
          if (!stillAuthorized(request)) return unauthorized();
          return text === 'too-large' ? json(response, { error: 'Diary entry too large' }, 413) : text === undefined ? json(response, { error: 'Diary entry not found' }, 404) : json(response, { name, text });
        } catch { return humanJson({ error: 'Diary unavailable' }, 500); }
      }
      if (path.startsWith('/api/images/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(path.slice('/api/images/'.length));
        const image = await partner.image(id);
        if (!stillAuthorized(request)) return unauthorized();
        if (!image) return json(response, { error: 'Image not found' }, 404);
        response.writeHead(200, { 'content-type': image.media_type, 'cache-control': 'no-store' });
        response.end(image.data); return;
      }
      if (path === '/api/conversation-images' && request.method === 'GET') {
        const params = Object.fromEntries(new URL(request.url!, 'http://localhost').searchParams);
        const options = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(500).optional() }).strict().parse(params);
        return humanJson(await partner.conversationImages(options));
      }
      if (path.startsWith('/api/conversation-images/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(path.slice('/api/conversation-images/'.length));
        const image = await partner.conversationImage(id);
        if (!stillAuthorized(request)) return unauthorized();
        if (!image) return json(response, { error: 'Image not found' }, 404);
        response.writeHead(200, { 'content-type': image.media_type, 'cache-control': 'no-store' }); response.end(image.data); return;
      }
      if (path.startsWith('/api/audio/') && request.method === 'GET') {
        const id = z.string().regex(/^[a-f0-9]{64}\.mp3$/u).parse(path.slice('/api/audio/'.length));
        const audio = await partner.audio(id.slice(0, -4));
        if (!stillAuthorized(request)) return unauthorized();
        if (!audio) return json(response, { error: 'Audio not found' }, 404);
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); response.end(audio); return;
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
        if (!stillAuthorized(request)) return unauthorized();
        if (!asset) return json(response, { error: 'Pet asset not found' }, 404);
        const metadata = asset.manifest.clips[activity as typeof PET_ACTIVITIES[number]];
        response.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store', 'x-pet-frame-count': String(metadata.frameCount), 'x-pet-fps': String(metadata.fps), 'x-pet-loop': String(metadata.loop) });
        response.end(asset.data); return;
      }
      if (path === '/api/messages' && request.method === 'POST') {
        const parsed = z.object({ id: z.uuid(), input: z.string().trim().max(MAX_MESSAGE_LENGTH), images: z.array(imageInputSchema).max(5).default([]), replaces: z.array(z.uuid()).max(20).default([]) }).strict().refine(value => value.input.length > 0 || value.images.length > 0).safeParse(await body(request, messageBodyLimit));
        if (!parsed.success) return json(response, { error: '消息内容无效，请检查文字长度和图片后重新发送。', code: 'invalid_message' }, 422);
        if (!stillAuthorized(request)) return unauthorized();
        const { id, input, images, replaces } = parsed.data;
        await partner.submit(id, input, images, replaces, () => stillAuthorized(request));
        return humanJson({ id }, 202);
      }
      if (path === '/api/compact' && request.method === 'POST') {
        const { sessionId } = await partner.snapshot();
        if (!stillAuthorized(request)) return unauthorized();
        const result = await partner.compact({ sessionId, authorize: () => authorize(request) });
        if (!result.accepted) throw new Error('Cannot compact while the conversation is working');
        return humanJson({ ok: true }, 202);
      }
      if (path === '/api/cancel' && request.method === 'POST') {
        const { id } = z.object({ id: z.string().min(1).max(300) }).strict().parse(await body(request));
        if (!stillAuthorized(request)) return unauthorized();
        await partner.cancel(id, () => authorize(request)); return humanJson({ ok: true });
      }
      if (path === '/api/events' && request.method === 'GET') {
        if (!stillAuthorized(request)) return unauthorized();
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        streams.set(response, request);
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
      if (!response.headersSent && human && !stillAuthorized(request)) return unauthorized();
      if (!response.headersSent && error instanceof InvalidImageInput) return json(response, { error: '消息内容无效，请检查文字长度和图片后重新发送。', code: 'invalid_message' }, 422);
      if (!response.headersSent) json(response, { error: '未能完成请求，请稍后重试' }, 400);
      else response.end();
    }
  });
  const chat = createChatSocket(partner, authorize, options.conversationSearch, stillAuthorized);
  server.on('upgrade', async (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const target = path === '/api/chat/socket' ? chat.sockets : path === VOICE_STREAM_PATH ? voice.sockets : undefined;
    if (request.method !== 'GET' || !target || !options.auth.sameOrigin(request) || (!await authorize(request))) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    target.handleUpgrade(request, socket, head, ws => {
      if (!stillAuthorized(request)) { ws.terminate(); return; }
      activeSockets.set(ws, request);
      ws.once('close', () => activeSockets.delete(ws));
      target.emit('connection', ws, request);
    });
  });
  let closePromise: Promise<void> | undefined;
  return { server, chatSockets: chat.sockets, close() {
    return closePromise ??= (async () => {
      clearInterval(revocationTimer);
      for (const controller of transcriptions.keys()) controller.abort();
      try {
        voice.close();
        await chat.close();
        for (const response of streams.keys()) response.end();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await partner.close();
      } finally { options.auth.close(); }
    })();
  } };
}
