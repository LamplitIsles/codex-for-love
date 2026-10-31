// Build a small test-owned cache entry using the actual prepared public contracts.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashes, prepared } from './shared-source.mjs';

export const smokeRevision = '1'.repeat(40);
export const smokeHtml = '<!doctype html><title>test frontend</title>';

export async function seedSmokeFrontend(cacheHome) {
  const directory = join(cacheHome, 'lamplitisles/codex-for-love/frontend', smokeRevision);
  await mkdir(join(directory, 'browser'), { recursive: true });
  await mkdir(join(directory, 'licenses'), { recursive: true });
  await writeFile(join(directory, 'browser/index.html'), smokeHtml);
  await writeFile(join(directory, 'licenses/fixture.txt'), 'Synthetic fixture');
  await cp(join(prepared, 'contracts/dist'), join(directory, 'contracts/dist'), { recursive: true });
  const manifest = { revision: smokeRevision, browser: await hashes(join(directory, 'browser')), contracts: await hashes(join(directory, 'contracts')), licenses: await hashes(join(directory, 'licenses')) };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
