import { cp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, prepared, verifyPrepared } from './shared-source.mjs';
const manifest = await verifyPrepared();
const destination = join(root, 'apps/partner/build');
await rm(destination, { recursive: true, force: true });
await cp(join(prepared, 'browser'), destination, { recursive: true });
await writeFile(join(root, '.generated/build-source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Installed shared App resources from ${manifest.app.sha}.`);
