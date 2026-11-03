import type { IncomingMessage, RequestListener } from 'node:http';
import type { AuthStore } from '../runtime/auth.ts';
import { createWebServer as createServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';

/** Existing host fixtures inject a synthetic owner; security tests use the real AuthStore. */
export function createWebServer(partner: Partner, assets: string, options: Omit<Parameters<typeof createServer>[2], 'auth' | 'keetReceiver'> & { authorize?: (request: IncomingMessage) => Promise<boolean> } = {}) {
  const { authorize, ...rest } = options;
  let origin = 'http://localhost';
  const ownerStatus = new WeakMap<IncomingMessage, 'signed_in' | 'signed_out'>();
  const auth = {
    get origin() { return origin; },
    authorize: authorize ?? (() => true),
    status: (request: IncomingMessage) => ownerStatus.get(request) ?? 'signed_out',
    sameOrigin(request: IncomingMessage) {
      if (request.headers['sec-fetch-site'] === 'cross-site') return false;
      if (!request.headers.origin) return request.url !== '/api/voice/stream';
      const valid = request.headers.origin === `http://${request.headers.host}` || request.headers.origin === `https://${request.headers.host}`;
      if (valid) origin = request.headers.origin!;
      return valid;
    },
    close() {},
  } as unknown as AuthStore;
  const app = createServer(partner, assets, { ...rest, auth, keetReceiver: 'synthetic-keet-receiver' });
  // Production status is synchronous; fixture owner predicates may be async.
  // Resolve only status probes first, then exercise the real route unchanged.
  const handle = app.server.listeners('request')[0] as RequestListener;
  app.server.off('request', handle);
  app.server.on('request', async (request, response) => {
    if (request.method === 'GET' && new URL(request.url ?? '/', 'http://localhost').pathname === '/api/auth/status') {
      let signedIn = false;
      try { signedIn = await auth.authorize(request); } catch { /* synthetic signed-out owner */ }
      ownerStatus.set(request, signedIn ? 'signed_in' : 'signed_out');
    }
    handle.call(app.server, request, response);
  });
  return app;
}
