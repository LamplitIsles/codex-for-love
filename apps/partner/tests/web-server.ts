import type { IncomingMessage } from 'node:http';
import type { AuthStore } from '../runtime/auth.ts';
import { createWebServer as createServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';

/** Existing host fixtures inject a synthetic owner; security tests use the real AuthStore. */
export function createWebServer(partner: Partner, assets: string, options: Omit<Parameters<typeof createServer>[2], 'auth' | 'keetReceiver'> & { authorize?: (request: IncomingMessage) => Promise<boolean> } = {}) {
  const { authorize, ...rest } = options;
  let origin = 'http://localhost';
  const auth = {
    get origin() { return origin; },
    authorize: authorize ?? (() => true),
    sameOrigin(request: IncomingMessage) {
      if (request.headers['sec-fetch-site'] === 'cross-site') return false;
      if (!request.headers.origin) return request.url !== '/api/voice/stream';
      const valid = request.headers.origin === `http://${request.headers.host}` || request.headers.origin === `https://${request.headers.host}`;
      if (valid) origin = request.headers.origin!;
      return valid;
    },
    close() {},
  } as unknown as AuthStore;
  return createServer(partner, assets, { ...rest, auth, keetReceiver: 'synthetic-keet-receiver' });
}
