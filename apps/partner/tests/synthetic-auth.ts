import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest();
export function authenticator(origin = 'http://localhost:3082') {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const client = (type: string, challenge: string, site = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: site }));
  return {
    register(challenge: string, site = origin) {
      const data = client('webauthn.create', challenge, site);
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, cose]);
      const attestation = isoCBOR.encode(new Map<string, string | Map<never, never> | Uint8Array>([['fmt', 'none'], ['attStmt', new Map<never, never>()], ['authData', authData]]));
      return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(data), attestationObject: b64(attestation), transports: ['internal'] } };
    },
    login(challenge: string, counter = 1, site = origin, verified = true) {
      const data = client('webauthn.get', challenge, site), count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([verified ? 0x05 : 0x01]), count]);
      const signature = sign('sha256', Buffer.concat([authData, sha(data)]), keys.privateKey);
      return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(signature), userHandle: null } };
    },
  };
}
