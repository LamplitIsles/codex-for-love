import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';
import { createFileOperations } from '../runtime/file-operations.ts';

const owner = { ownerId: 'owner', sessionId: 'session' }, guard = { check: async () => {}, commit: () => {} };
const manifest = () => ({ sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] });

test('symlink operation root is rejected without touching its target', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'cfl-symlink-root-'));
  const attachments = join(root, 'workspace', '.lamplit', 'attachments'), outside = join(root, 'outside');
  await fs.mkdir(attachments, { recursive: true, mode: 0o700 }); await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, join(attachments, '.file-operations'));
  const store = new Store(join(root, 'session.sqlite'));
  try { await assert.rejects(createFileOperations(store, attachments).reserve(manifest(), owner, guard)); assert.deepEqual(await fs.readdir(outside), []); }
  finally { await store.close(); await fs.rm(root, { recursive: true, force: true }); }
});
