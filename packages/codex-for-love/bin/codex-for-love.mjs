#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativePackages = {
  'linux-x64': '@lamplitisles/codex-for-love-linux-x64',
  'darwin-arm64': '@lamplitisles/codex-for-love-darwin-arm64',
};
const nativePackage = nativePackages[`${process.platform}-${process.arch}`];
if (!nativePackage) {
  throw new Error(`Unsupported platform ${process.platform}-${process.arch}; CFL supports Linux x64 and macOS ARM64.`);
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).optionalDependencies?.[nativePackage];
if (typeof nativeVersion !== 'string') {
  throw new Error(`Missing exact optional dependency declaration for ${nativePackage}.`);
}
let nativeManifestPath;
try {
  nativeManifestPath = require.resolve(`${nativePackage}/package.json`);
} catch (error) {
  throw new Error(`Missing ${nativePackage}@${nativeVersion}. Reinstall the matching main package.`, { cause: error });
}
const installedNativeVersion = JSON.parse(readFileSync(nativeManifestPath, 'utf8')).version;
if (installedNativeVersion !== nativeVersion) {
  throw new Error(`Expected ${nativePackage}@${nativeVersion}, found ${installedNativeVersion ?? 'unknown'}. Reinstall the matching main package.`);
}
const nativeRoot = dirname(nativeManifestPath);
const child = spawn(process.execPath, [join(packageRoot, 'vendor', 'runtime', 'cli.mjs'), '--native-package-root', nativeRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('error', (error) => { throw error; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
