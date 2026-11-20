#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(packageRoot, 'vendor', 'runtime', 'cli.mjs'), '--managed-native', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('error', (error) => { throw error; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
