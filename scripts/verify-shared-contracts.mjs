import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, verifyPrepared } from './shared-source.mjs';
const manifest = await verifyPrepared();
await writeFile(join(root, '.generated/build-source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Verified public App contracts from ${manifest.app.sha}.`);
