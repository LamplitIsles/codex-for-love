import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Initialize the separate authentication database while holding its write lock. */
export function initializeAuthSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL CHECK(counter >= 0),
        transports TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash BLOB PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_pairing (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        code_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        generation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_ceremonies (
        handle_hash BLOB PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        pairing_generation TEXT,
        credential_epoch INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_metadata (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        credential_epoch INTEGER NOT NULL CHECK(credential_epoch >= 0),
        user_id BLOB NOT NULL
      );
    `);
    db.prepare('INSERT OR IGNORE INTO auth_metadata(id, credential_epoch, user_id) VALUES(1, 0, ?)').run(randomBytes(32));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
