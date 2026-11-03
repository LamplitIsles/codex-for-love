import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeStickerSchema } from '../runtime/sticker-schema.ts';

test('sticker schema persists independent favorites and enforces membership integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-sticker-schema-'));
  const path = join(root, 'stickers.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    initializeStickerSchema(db);
    initializeStickerSchema(db);
    db.prepare('INSERT INTO sticker_assets VALUES (?,?,?,?,?,?,?,?)')
      .run('asset', 'image/gif', 'original', 'preview', 'model', 100, 20, 20);
    db.prepare('INSERT INTO stickers VALUES (?,?,?,?,?)').run('sticker', 'asset', 'Hello', '[]', 1);
    db.prepare('INSERT INTO sticker_packs VALUES (?,?,?,?)').run('pack', 'Pack', 'Description', 1);
    db.prepare('INSERT INTO sticker_pack_members VALUES (?,?,?)').run('pack', 'sticker', 0);
    const favorite = db.prepare('INSERT INTO sticker_favorites VALUES (?,?,?)');
    favorite.run('human', 'sticker', 2);
    favorite.run('agent', 'sticker', 3);
    assert.throws(() => favorite.run('human', 'sticker', 4));
    assert.throws(() => favorite.run('other', 'sticker', 4));
    assert.throws(() => favorite.run('human', 'missing', 4));
    assert.throws(() => db!.prepare('DELETE FROM sticker_assets WHERE hash = ?').run('asset'));
    db.close();
    db = new DatabaseSync(path);
    initializeStickerSchema(db);
    db.prepare('DELETE FROM sticker_favorites WHERE participant = ?').run('human');
    assert.deepEqual(db.prepare('SELECT participant, sticker_id FROM sticker_favorites').all().map(row => ({ ...row })), [
      { participant: 'agent', sticker_id: 'sticker' },
    ]);
    assert.equal(db.prepare('SELECT sticker_id FROM sticker_pack_members WHERE pack_id = ? AND position = 0').get('pack')?.sticker_id, 'sticker');
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});
