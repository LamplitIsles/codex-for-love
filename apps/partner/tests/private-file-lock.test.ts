import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { acquirePrivateFileLock, privateFileIdentity, privateFileLockHeld } from '../runtime/private-file-lock.ts';

test('private lock identity rejects unsafe permissions, links and replaced paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-lock-'));
  const path = join(root, 'lock'), other = join(root, 'other');
  const owner = await acquirePrivateFileLock(path); assert.ok(owner);
  try {
    assert.ok(await privateFileIdentity(path, owner));
    assert.equal(await privateFileLockHeld(path), true);
    await chmod(path, 0o644);
    assert.equal(await privateFileIdentity(path, owner), undefined);
    await assert.rejects(privateFileLockHeld(path), /Invalid private lock file/);
    await chmod(path, 0o600);
    await link(path, other);
    assert.equal(await privateFileIdentity(path, owner), undefined);
    await assert.rejects(privateFileLockHeld(path), /Invalid private lock file/);
    await rm(other);
    await rename(path, other); await writeFile(path, 'replacement', { mode: 0o600 });
    assert.equal(await privateFileIdentity(path, owner), undefined);
    await rm(path); await symlink(other, path);
    assert.equal(await privateFileIdentity(path, owner), undefined);
    await assert.rejects(privateFileLockHeld(path));
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});

test('lock probe rejects a pathname replaced after the lock check', async () => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(join(tmpdir(), 'private-lock-race-'));
  const path = join(root, 'lock'), original = join(root, 'original');
  const owner = await acquirePrivateFileLock(path); assert.ok(owner);
  const originalLstat = fs.lstat; let calls = 0;
  try {
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === path && ++calls === 2) {
        await rename(path, original);
        await writeFile(path, 'replacement', { mode: 0o600 });
      }
      return originalLstat(...args);
    }) as typeof fs.lstat;
    syncBuiltinESMExports();
    await assert.rejects(privateFileLockHeld(path), /Private lock changed/);
  } finally { fs.lstat = originalLstat; syncBuiltinESMExports(); await owner.close(); await rm(root, { recursive: true, force: true }); }
});
