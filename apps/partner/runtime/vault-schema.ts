import type { DatabaseSync } from 'node:sqlite';

/** The vault has its own database; schema changes must advance its user_version. */
export function initializeVaultSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version === 0) {
      const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (existing) throw new Error('Unrecognized vault database');
      db.exec(`
        CREATE TABLE vault_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          key_id TEXT NOT NULL,
          nonce BLOB NOT NULL CHECK (length(nonce) = 12),
          ciphertext BLOB NOT NULL,
          tag BLOB NOT NULL CHECK (length(tag) = 16)
        ) STRICT;
        CREATE TABLE vault_values (
          owner_id TEXT NOT NULL,
          purpose TEXT NOT NULL,
          key_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
          nonce BLOB,
          ciphertext BLOB,
          tag BLOB,
          PRIMARY KEY (owner_id, purpose),
          CHECK ((deleted = 1 AND nonce IS NULL AND ciphertext IS NULL AND tag IS NULL)
            OR (deleted = 0 AND nonce IS NOT NULL AND length(nonce) = 12 AND ciphertext IS NOT NULL AND tag IS NOT NULL AND length(tag) = 16))
        ) STRICT;
        CREATE TABLE vault_migrations (
          name TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          marker BLOB NOT NULL
        ) STRICT;
        CREATE TABLE notification_attempts (
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          attempted_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, turn_id)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    } else if (version !== 1) {
      throw new Error('Unsupported vault schema version');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
