import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConversationSearch } from '../runtime/conversation-search.ts';

/** All records, process logs, Codex home and controls belong to the caller's fixture. */
export async function seedConversationSearch(root: string, workspace: string, codexHome: string) {
  const ids = Array.from({ length: 23 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  const records = ids.map((id, i) => ({ id, cwd: workspace, kind: i === 2 ? 'compaction' as const : 'message' as const,
    sessionId: i === 22 ? 'import-session' : 'archive-session', sessionName: i === 22 ? 'Imported branch' : 'Archive',
    ...(i === 2 ? {} : { role: 'user' as const, phase: 'final_answer' as const }), createdAt: '2026-10-02T12:00:00Z',
    content: `灯塔 lighthouse ${i < 2 ? 'repeated' : i === 2 ? 'archiveSummary3142' : `record ${i}`}${i === 22 ? ' archiveImported3142' : ''} <img src=x onerror=alert(1)>` }));
  const paths = Object.fromEntries(records.map((r, i) => [r.id, [
    { sourceRecordIndex: i * 30 + 9, kind: 'message', role: 'assistant', phase: 'final_answer', content: i === 1 || i === 22 ? 'before imported branch' : 'before original branch' },
    { sourceRecordIndex: i * 30 + 10, kind: r.kind, ...(r.role ? { role: r.role } : {}), content: r.content },
    { sourceRecordIndex: i * 30 + 11, kind: 'compaction', content: 'nearby summary ' + '🌙'.repeat(13000) },
  ]]));
  const data = join(root, 'search-data.json'), log = join(root, 'search-calls.jsonl'), control = join(root, 'search-control.json');
  await writeFile(data, JSON.stringify({ records, paths, targets: Object.fromEntries(ids.map((id, i) => [id, i * 30 + 10])) })); await writeFile(log, ''); await writeFile(control, '{}');
  const binary = join(root, 'flicklog-fake');
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./conversation-search-cli.mjs', import.meta.url).href)};\n`, { mode: 0o755 });
  const search = createConversationSearch({ workspace, codexHome, env: { FLICKLOG_BIN: binary, FLICKLOG_TEST_DATA: data, FLICKLOG_TEST_LOG: log, FLICKLOG_TEST_CONTROL: control,
    FLICKLOG_MEILI_KEY: '', CREDENTIALS_DIRECTORY: root } });
  return { search, data, log, control, recordIds: { original: ids[0]!, repeated: ids[1]!, summary: ids[2]!, imported: ids[22]! } };
}
