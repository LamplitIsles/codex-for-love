// Actual FlickLog CLI and Meilisearch; every source log, index and process belongs to this fixture.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConversationSearch } from '../runtime/conversation-search.ts';
import { eventually } from './fixture.ts';

export async function seedNativeConversationSearch(root: string, workspace: string, codexHome: string) {
  const source = process.env.CFL_ACCEPTANCE_FLICKLOG_SOURCE;
  const meilisearch = process.env.CFL_ACCEPTANCE_MEILISEARCH_BIN;
  if (!source || !meilisearch) throw new Error('Native acceptance requires explicit FlickLog source CLI and a test-owned Meilisearch binary.');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(done => reserve.close(() => done()));
  const index = spawn(resolve(meilisearch), ['--http-addr', `127.0.0.1:${port}`, '--db-path', join(root, 'meili'), '--no-analytics', '--max-indexing-threads', '2', '--master-key', 'synthetic-native-acceptance-key'], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; index.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const closed = once(index, 'close');
  try {
    await eventually(async () => { if (index.exitCode !== null) throw new Error(stderr); try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 30000);
    const sessions = join(codexHome, 'sessions'); await mkdir(sessions, { recursive: true });
    const timestamp = '2026-10-02T12:00:00Z';
    const text = (content: string, id: string) => ({ timestamp, type: 'response_item', payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text: content }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
    const summary = (content: string) => ({ timestamp, type: 'compacted', payload: { message: content, replacement_history: [] } });
    const meta = (id: string) => ({ timestamp, type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: workspace, source: 'cli', thread_source: 'user' } });
    const archive: unknown[] = [meta('archive-session')], imported: unknown[] = [meta('import-session')];
    for (let i = 0; i < 23; i++) {
      const rows = i === 22 ? imported : archive;
      // Preserve real source ordering and keep repeated targets beyond each other's context window.
      for (let n = 0; n < 9; n++) rows.push(text(`path filler ${i}:${n}`, `filler-${i}-${n}`));
      rows.push(text(i === 1 || i === 22 ? 'before imported branch' : 'before original branch', `before-${i}`));
      const content = `灯塔 lighthouse ${i < 2 ? 'repeated' : i === 2 ? 'archiveSummary3142' : `record ${i}`}${i === 22 ? ' archiveImported3142' : ''} <img src=x onerror=alert(1)>`;
      rows.push(i === 2 ? summary(content) : text(content, `record-${i}`));
      rows.push(summary('nearby summary ' + '🌙'.repeat(13000)));
      for (let n = 0; n < 9; n++) rows.push(text(`after filler ${i}:${n}`, `after-${i}-${n}`));
    }
    await writeFile(join(sessions, 'archive.jsonl'), archive.map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(join(sessions, 'import.jsonl'), imported.map(row => JSON.stringify(row)).join('\n') + '\n');
    const log = join(root, 'search-calls.jsonl'); await writeFile(log, '');
    const binary = join(root, 'flicklog-test-owned');
    // Delegates every command to unchanged native source; no public DTO or matcher in the fixture.
    await writeFile(binary, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.CODEX_HOME})+'\\n');\nconst result=spawnSync('bun',[${JSON.stringify(resolve(source))},...process.argv.slice(2)],{env:process.env,stdio:'inherit'});\nprocess.exit(result.status??1);\n`, { mode: 0o755 });
    const search = createConversationSearch({ workspace, codexHome, env: { FLICKLOG_BIN: binary, FLICKLOG_STATE_DIR: join(root, 'flicklog-state'), FLICKLOG_MEILI_URL: `http://127.0.0.1:${port}`, FLICKLOG_MEILI_KEY: 'synthetic-native-acceptance-key', CREDENTIALS_DIRECTORY: root } });
    const hits = (await search.search('lighthouse')).hits;
    const original = hits.filter(hit => hit.snippet.includes('repeated'));
    const ids: string[] = [];
    for (const hit of original) {
      const { context } = await search.read(hit.id);
      if (context.items.some(item => item.content === 'before original branch')) ids[0] = hit.id;
      if (context.items.some(item => item.content === 'before imported branch')) ids[1] = hit.id;
    }
    const summaryId = (await search.search('archiveSummary3142')).hits[0]!.id;
    const importedId = (await search.search('archiveImported3142')).hits[0]!.id;
    if (!ids[0] || !ids[1]) throw new Error('Native ranking omitted required repeated records; fixture cannot fabricate them.');
    await writeFile(join(root, 'native-search-identity.json'), JSON.stringify({ source: resolve(source), meilisearch: resolve(meilisearch), port, recordIds: ids }, null, 2));
    return { search, log, recordIds: { original: ids[0], repeated: ids[1], summary: summaryId, imported: importedId },
      async close() { index.kill('SIGTERM'); await closed; } };
  } catch (error) { index.kill('SIGTERM'); await closed; throw error; }
}
