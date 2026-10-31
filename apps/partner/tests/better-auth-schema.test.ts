import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getMigrations } from 'better-auth/db/migration';
import { passkey } from '@better-auth/passkey';
import { oauthProvider } from '@better-auth/oauth-provider';
import { initializeBetterAuthSchema, pairingSchema } from '../runtime/better-auth-schema.ts';

test('Better Auth schema is complete, repeatable, and preserves existing state', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE auth_metadata (id INTEGER PRIMARY KEY, sentinel TEXT NOT NULL)');
    db.prepare('INSERT INTO auth_metadata VALUES (?, ?)').run(1, 'legacy');
    initializeBetterAuthSchema(db);
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
      .run('owner', 'Owner', 'owner@invalid', 0, 1, 1);
    db.prepare('INSERT INTO "authPairing" (id, "codeHash", "expiresAt", generation) VALUES (?, ?, ?, ?)')
      .run('owner', 'hash', 100, 'generation');
    initializeBetterAuthSchema(db);

    assert.equal(db.prepare('SELECT sentinel FROM auth_metadata WHERE id = 1').get()?.sentinel, 'legacy');
    assert.equal(db.prepare('SELECT email FROM "user" WHERE id = ?').get('owner')?.email, 'owner@invalid');
    assert.equal(db.prepare('SELECT generation FROM "authPairing" WHERE id = ?').get('owner')?.generation, 'generation');

    const migration = await getMigrations({
      database: db,
      plugins: [passkey(), oauthProvider({ loginPage: '/login', consentPage: '/consent', disableJwtPlugin: true }), pairingSchema],
    });
    assert.deepEqual(migration.toBeCreated, []);
    assert.deepEqual(migration.toBeAdded, []);
    assert.deepEqual(migration.toBeAddedIndexes, []);
    assert.deepEqual(migration.schemaProblems, []);
  } finally {
    db.close();
  }
});

test('removing an authorizing session also removes its native grants', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    initializeBetterAuthSchema(db);
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
      .run('owner', 'Owner', 'owner@invalid', 0, 1, 1);
    db.prepare('INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
      .run('session', 'token', 'owner', 100, 1, 1);
    db.prepare('INSERT INTO "oauthClient" (id, "clientId", "redirectUris") VALUES (?, ?, ?)')
      .run('client', 'etos', '[]');
    db.prepare('INSERT INTO "oauthRefreshToken" (id, token, "clientId", "userId", "sessionId", "expiresAt", "createdAt", scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('refresh', 'refresh-token', 'etos', 'owner', 'session', 100, 1, '[]');
    db.prepare('INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", "sessionId", "refreshId", "expiresAt", "createdAt", scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('access', 'access-token', 'etos', 'owner', 'session', 'refresh', 100, 1, '[]');

    db.prepare('DELETE FROM "session" WHERE id = ?').run('session');

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "oauthRefreshToken"').get()?.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "oauthAccessToken"').get()?.count, 0);
  } finally {
    db.close();
  }
});
