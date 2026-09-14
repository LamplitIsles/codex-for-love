import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateRelationshipJournal } from '../runtime/migrate-relationship-journal.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { readRelationshipJournal } from '../runtime/relationship-journal.ts';

test('migration validates a candidate before publishing and stays retryable after bad source', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'relationship-migration-'));
  const paths = partnerPaths(workspace); await mkdir(paths.managedRoot, { recursive: true });
  const database = new DatabaseSync(paths.database);
  database.exec('CREATE TABLE relationship(data TEXT NOT NULL)');
  database.prepare('INSERT INTO relationship(data) VALUES(?)').run(JSON.stringify({ at: 'bad', changes: {}, state: {} }));
  database.close();
  try {
    await assert.rejects(migrateRelationshipJournal(workspace));
    await assert.rejects(readFile(paths.relationshipJournal));
    const repaired = new DatabaseSync(paths.database);
    repaired.exec('DELETE FROM relationship');
    repaired.prepare('INSERT INTO relationship(data) VALUES(?)').run(JSON.stringify({ at: '2026-01-01T00:00:00.000Z', changes: { seed: true }, state: { mood: 'neutral', affinity: 50, signature: '' } }));
    repaired.close();
    assert.deepEqual(await migrateRelationshipJournal(workspace), { records: 1 });
    assert.equal((await readRelationshipJournal(paths.relationshipJournal)).length, 1);
    await assert.rejects(migrateRelationshipJournal(workspace), /already exists/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
