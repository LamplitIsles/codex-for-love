import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, prepared, readPin, readDigest, cflIdentity, hashes, unpackContracts } from './shared-source.mjs';

const pin = await readPin(); const digest = await readDigest();
const url = `https://github.com/LamplitIsles/lamplit-app/releases/download/app-${pin}/lamplit-contracts-${pin}.tar.gz`;
await mkdir(join(root, '.generated'), { recursive: true });
const stage = await mkdtemp(join(root, '.generated/prepare-contracts-'));
try {
  const archive = join(stage, 'contracts.tar.gz');
  execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--max-filesize', '134217728', '--output', archive, url], { stdio: 'inherit' });
  const extracted = join(stage, 'extract'); await mkdir(extracted);
  const contracts = await unpackContracts(archive, extracted, pin, digest);
  await rename(join(extracted, 'package'), join(stage, 'contracts')); await rm(extracted, { recursive: true });
  await mkdir(join(stage, 'licenses'));
  for (const [from, name] of [[join(stage, 'contracts/LICENSE'), 'lamplit-app-Apache-2.0.txt'], [join(stage, 'contracts/licenses/chord-1.0.0-MIT.txt'), 'chord-1.0.0-MIT.txt'], [join(root, 'licenses/app/lamplit-app-IMPORTS.md'), 'lamplit-app-IMPORTS.md'], [join(root, 'licenses/app/NotoSansSC-OFL-1.1.txt'), 'NotoSansSC-OFL-1.1.txt']]) await cp(from, join(stage, 'licenses', name));
  const manifest = { pin, app: { sha: pin }, archiveSha256: digest, cfl: cflIdentity(), contracts, licenses: await hashes(join(stage, 'licenses')) };
  await writeFile(join(stage, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(prepared, { recursive: true, force: true });
  await rename(stage, prepared);
  console.log(`Prepared published App contracts ${pin} (SHA-256 ${digest}).`);
} finally { await rm(stage, { recursive: true, force: true }); }
