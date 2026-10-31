import { createHash } from 'node:crypto';

export const authMarkerPath = 'dist/cfl-browser-host-auth.js';
const authMarker = 'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n';
export const authMarkerHash = createHash('sha256').update(authMarker).digest('hex');

export function requireAuthMarker(contracts: Record<string, string> | undefined, context: string): void {
  if (contracts?.[authMarkerPath] !== authMarkerHash) {
    throw new Error(`${context} lacks the expected Better Auth browser-host protocol marker; select a compatible App revision or prepare CFL from one`);
  }
}
