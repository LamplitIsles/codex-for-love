#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`Unsupported platform ${process.platform}-${process.arch}; @lamplitisles/codex-for-love supports Linux x64 only.`);
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativePackage = '@lamplitisles/codex-for-love-linux-x64';
const nativeVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).optionalDependencies?.[nativePackage];
if (typeof nativeVersion !== 'string') {
  throw new Error(`Missing exact optional dependency declaration for ${nativePackage}.`);
}
let nativeRoot;
try {
  nativeRoot = dirname(require.resolve(`${nativePackage}/package.json`));
} catch (error) {
  throw new Error(`Missing ${nativePackage}@${nativeVersion}. Reinstall the matching main package.`, { cause: error });
}
const child = spawn(process.execPath, [join(packageRoot, 'vendor', 'runtime', 'cli.mjs'), '--native-package-root', nativeRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('error', (error) => { throw error; });
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
