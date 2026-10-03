import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const archive = join(root, 'vendor/lamplit-default-shared-frontend.tgz');
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (sha256(await readFile(archive)) !== 'eef50394bba2452f6daf1a8a052db3a35e68ed049bab480616602496aaca227e')
  throw new Error('Shared App archive differs from the Owner-approved artifact.');
const temporary = await mkdtemp(join(tmpdir(), 'cfl-shared-build-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  if ((await readFile(join(temporary, 'SOURCE_HEAD'), 'utf8')).trim() !== 'd1e800e72807d52ea14eed59d13a3cef6a43fd09')
    throw new Error('Unexpected shared App source identity.');
  const manifest = await readFile(join(temporary, 'browser.sha256'));
  if (sha256(manifest) !== '8e83a3f3f69e79b9a8e169432190863b7f890270ac580a200cbb1c9ac8571d68')
    throw new Error('Unexpected shared App browser manifest.');
  for (const line of manifest.toString().trim().split('\n')) {
    const [, hash, path] = /^(\w{64})  (.+)$/u.exec(line) ?? [];
    if (!path || sha256(await readFile(join(temporary, 'browser', path))) !== hash)
      throw new Error(`Shared App file failed verification: ${path}`);
  }
  const destination = join(root, 'apps/partner/build');
  await rm(destination, { recursive: true, force: true });
  await cp(join(temporary, 'browser'), destination, { recursive: true });
  console.log('Installed 265 verified shared App files from d1e800e into apps/partner/build.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
