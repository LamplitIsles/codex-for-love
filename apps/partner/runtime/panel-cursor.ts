import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Host-lifetime authenticated cursors. No paths or client-selected scope. */
export function panelCursors() {
  const key = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    encode(method: string, sessionId: string, position: string): string {
      const payload = Buffer.from(JSON.stringify([method, sessionId, position])).toString('base64url');
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    decode(method: string, sessionId: string, cursor: string | null): string | undefined {
      if (cursor === null) return undefined;
      const [payload, signature, extra] = cursor.split('.');
      if (!payload || !signature || extra || cursor.length > 2048) throw new Error('Invalid cursor');
      const supplied = Buffer.from(signature, 'base64url');
      const expected = sign(payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid cursor');
      const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== method || value[1] !== sessionId || typeof value[2] !== 'string') throw new Error('Invalid cursor scope');
      return value[2];
    },
  };
}
