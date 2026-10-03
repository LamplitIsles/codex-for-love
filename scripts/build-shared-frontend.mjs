import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const archive = join(root, 'vendor/lamplit-default-shared-frontend.tgz');
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (sha256(await readFile(archive)) !== '7e472c0b9d8c79321f5457557f7667f05de22ad569e33b98ee629e113c094264')
  throw new Error('Shared App archive differs from the pinned artifact.');
const temporary = await mkdtemp(join(tmpdir(), 'cfl-shared-build-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  if ((await readFile(join(temporary, 'SOURCE_HEAD'), 'utf8')).trim() !== 'bc93ad34ff89c495741b375021d2071fe76f13db')
    throw new Error('Unexpected shared App source identity.');
  const manifest = await readFile(join(temporary, 'browser.sha256'));
  if (sha256(manifest) !== 'd0e3a6af976fa1dd96939a8535ee0b57b62f5e0efce8f79f50a29ec3841e747d')
    throw new Error('Unexpected shared App browser manifest.');
  for (const line of manifest.toString().trim().split('\n')) {
    const [, hash, path] = /^(\w{64})  (.+)$/u.exec(line) ?? [];
    if (!path || sha256(await readFile(join(temporary, 'browser', path))) !== hash)
      throw new Error(`Shared App file failed verification: ${path}`);
  }
  const destination = join(root, 'apps/partner/build');
  await rm(destination, { recursive: true, force: true });
  await cp(join(temporary, 'browser'), destination, { recursive: true });
  console.log('Installed 265 verified shared App files from bc93ad3 into apps/partner/build.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
