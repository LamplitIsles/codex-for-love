import { access, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { readRelationshipJournal, replaceRelationshipJournal } from './relationship-journal.ts';
import { partnerPaths } from './storage-paths.ts';
import type { CompanionStateRecord } from '../src/lib/companion/domain.ts';

/** One-time, explicit conversion of a legacy CFL relationship table. */
export async function migrateRelationshipJournal(workspace: string): Promise<{ records: number }> {
  const paths = partnerPaths(workspace);
  try { await access(paths.relationshipJournal); throw new Error('Relationship Journal already exists; refusing to overwrite it'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const database = new DatabaseSync(paths.database);
  try {
    const present = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relationship'").get();
    if (!present) throw new Error('Legacy relationship table does not exist');
    const records = database.prepare('SELECT data FROM relationship ORDER BY rowid').all().map((row) => JSON.parse(String((row as { data: string }).data)) as CompanionStateRecord);
    const candidate = `${paths.relationshipJournal}.migration-candidate`;
    await rm(candidate, { force: true });
    await replaceRelationshipJournal(candidate, records);
    const verified = await readRelationshipJournal(candidate);
    if (verified.length !== records.length || verified.some((record, index) => JSON.stringify(record) !== JSON.stringify(records[index]))) {
      throw new Error('Relationship Journal verification differs from the source table');
    }
    await rename(candidate, paths.relationshipJournal);
    database.exec('DROP TABLE relationship');
    return { records: records.length };
  } finally { await rm(`${paths.relationshipJournal}.migration-candidate`, { force: true }); database.close(); }
}
