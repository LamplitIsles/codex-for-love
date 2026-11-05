import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Store } from '../runtime/store.ts';
import { createFileOperations } from '../runtime/file-operations.ts';

const root = process.env.CFL_FAKE_ROOT, id = process.env.CFL_FAKE_ID, boundary = process.env.CFL_FAKE_BOUNDARY;
const attachments = join(root, 'workspace', '.lamplit', 'attachments');
await fs.mkdir(attachments, { recursive: true, mode: 0o700 });
const store = new Store(join(root, 'session.sqlite')), ops = createFileOperations(store, attachments);
const owner = { ownerId: 'owner', sessionId: 'session' }, guard = { check: async () => {}, commit: () => {} };
const manifest = { sessionId: 'session', operationId: id, files: [{ id: 'f', name: 'f', mediaType: '', size: 4 }] };
const originalOpen = fs.open, originalLink = fs.link, originalUnlink = fs.unlink, originalRmdir = fs.rmdir, originalMkdir = fs.mkdir;
const pause = async () => { process.send({ boundary }); await new Promise(() => {}); };
fs.mkdir = async (...args) => { const result = await originalMkdir(...args); if (boundary === 'directory' && /\/\.file-operations\/[a-f0-9]{32}$/u.test(String(args[0]))) await pause(); return result; };
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).endsWith('/p0.tmp') && boundary === 'writing') {
    const write = handle.write.bind(handle);
    handle.write = async (...values) => { const result = await write(...values); await pause(); return result; };
  }
  return handle;
};
fs.link = async (...args) => { await originalLink(...args); if (boundary === 'publication') await pause(); };
fs.unlink = async (...args) => { if (boundary === 'bound' && String(args[0]).endsWith('/p0.tmp')) await pause(); return originalUnlink(...args); };
fs.rmdir = async (...args) => { await originalRmdir(...args); if (boundary === 'removed' && /\/\.file-operations\/[a-f0-9]{32}$/u.test(String(args[0]))) await pause(); };
syncBuiltinESMExports();
await ops.reserve(manifest, owner, guard);
await ops.receive(id, 'f', (async function* () { yield Buffer.from('data'); })(), owner, guard);
if (boundary === 'removed') {
  const realNow = Date.now; Date.now = () => realNow() + 25 * 60 * 60 * 1000;
  await ops.reserve({ ...manifest, operationId: crypto.randomUUID() }, owner, guard);
}
throw new Error('Crash boundary not reached');
