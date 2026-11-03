import type { DatabaseSync } from 'node:sqlite';

/** Each connection must enable foreign keys before it starts a transaction. */
export function initializeStickerSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sticker_assets (
      hash TEXT PRIMARY KEY,
      media_type TEXT NOT NULL CHECK(media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
      original_path TEXT NOT NULL,
      preview_path TEXT NOT NULL,
      model_path TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size > 0),
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0)
    );
    CREATE TABLE IF NOT EXISTS stickers (
      id TEXT PRIMARY KEY,
      asset_hash TEXT NOT NULL REFERENCES sticker_assets(hash) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sticker_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sticker_pack_members (
      pack_id TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
      sticker_id TEXT NOT NULL REFERENCES stickers(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(pack_id, sticker_id),
      UNIQUE(pack_id, position)
    );
    CREATE TABLE IF NOT EXISTS sticker_favorites (
      participant TEXT NOT NULL CHECK(participant IN ('human', 'agent')),
      sticker_id TEXT NOT NULL REFERENCES stickers(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(participant, sticker_id)
    );
    CREATE INDEX IF NOT EXISTS sticker_favorites_by_time
      ON sticker_favorites(participant, created_at DESC, sticker_id);
  `);
}
