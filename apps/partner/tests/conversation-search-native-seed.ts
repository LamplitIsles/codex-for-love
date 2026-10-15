// Unchanged Rust release artifact, owned foreground daemon and synthetic source/session/HTTP endpoint.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConversationSearch } from '../runtime/conversation-search.ts';
import { eventually } from './fixture.ts';

export async function seedNativeConversationSearch(root: string, workspace: string, codexHome: string) {
  const binarySource = process.env.CFL_ACCEPTANCE_FLICKLOG_BIN;
  if (!binarySource) throw new Error('Native acceptance requires an explicit unchanged Rust FlickLog release artifact.');
  const binary = resolve(binarySource), data = join(root, 'flicklog-data');
  await mkdir(data, { recursive: true });
  const http = createHttpServer(async (request, response) => {
    // Only this synthetic endpoint participates. Never forward credentials or requests.
    for await (const _chunk of request) { /* drain synthetic upload */ }
    if (request.url?.startsWith('/rest/v1/entries')) { response.writeHead(201); response.end('{}'); }
    else { response.writeHead(503); response.end('synthetic sync unavailable'); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await writeFile(join(data, 'config.json'), JSON.stringify({ supabase_url: endpoint, powersync_url: endpoint, publishable_key: 'synthetic-key' }));
  await writeFile(join(data, 'session.json'), JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: null, user: { id: '11111111-1111-1111-1111-111111111111', email: null } }));
  await writeFile(join(data, 'identity.json'), JSON.stringify({ user_id: '11111111-1111-1111-1111-111111111111', device_id: 'test-device' }));
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root,'config'), XDG_DATA_HOME: join(root,'xdg-data'), CODEX_HOME: codexHome, FLICKLOG_DATA_DIR: data };
  const daemon = spawn(binary, ['daemon', 'run'], { cwd: workspace, env, stdio: ['ignore','ignore','pipe'] });
  let stderr = ''; daemon.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const closed = once(daemon, 'close');
  const run = promisify(execFile);
  async function stop() { daemon.kill('SIGTERM'); await closed; await new Promise<void>(done => http.close(() => done())); }
  try {
    await eventually(async () => {
      if (daemon.exitCode !== null) throw new Error(stderr);
      return stderr.includes('FlickLog daemon ready');
    }, 30000);
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
      const content = `灯塔 lighthouse ${i < 2 ? 'repeated' : i === 2 ? 'archiveSummary3142' : `record ${i}`}${i === 22 ? ' archiveImported3142' : ''} <mark>literal</mark> \`<img src=x onerror=alert(1)>\` 中文😀𠮷`;
      rows.push(i === 2 ? summary(content) : text(content, `record-${i}`));
      rows.push(summary('nearby summary ' + '🌙'.repeat(13000)));
      for (let n = 0; n < 9; n++) rows.push(text(`after filler ${i}:${n}`, `after-${i}-${n}`));
    }
    await writeFile(join(sessions, 'archive.jsonl'), archive.map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(join(sessions, 'import.jsonl'), imported.map(row => JSON.stringify(row)).join('\n') + '\n');
    const log = join(root, 'search-calls.jsonl'); await writeFile(log, '');
    const wrapper = join(root, 'flicklog-test-owned');
    await writeFile(wrapper, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');\nconst result=spawnSync(${JSON.stringify(binary)},process.argv.slice(2),{env:process.env,stdio:'inherit'});\nprocess.exit(result.status??1);\n`, { mode: 0o755 });
    const ingest = await run(binary, ['ingest','--codex-home',codexHome], { cwd: workspace, env, timeout: 30000 });
    await writeFile(join(root,'ingest.json'), ingest.stdout);
    const search = createConversationSearch({ workspace, env: { ...env, FLICKLOG_BIN: wrapper } });
    const hits = (await search.search('lighthouse')).hits;
    const original = hits.filter(hit => hit.snippet.segments.map(segment => segment.text).join('').includes('repeated'));
    const ids: string[] = [];
    for (const hit of original) {
      const { context } = await search.read(hit.id);
      if (context.items.some(item => item.content === 'before original branch')) ids[0] = hit.id;
      if (context.items.some(item => item.content === 'before imported branch')) ids[1] = hit.id;
    }
    const summaryId = (await search.search('archiveSummary3142')).hits[0]!.id;
    const importedId = (await search.search('archiveImported3142')).hits[0]!.id;
    if (!ids[0] || !ids[1]) throw new Error('Native ranking omitted required repeated records; fixture cannot fabricate them.');
    await writeFile(join(root, 'native-search-identity.json'), JSON.stringify({ binary, sha256: createHash('sha256').update(await readFile(binary)).digest('hex'), recordIds: ids, ingest: JSON.parse(ingest.stdout) }, null, 2));
    return { search, log, recordIds: { original: ids[0], repeated: ids[1], summary: summaryId, imported: importedId },
      close: stop };
  } catch (error) { await stop(); throw error; }
}
