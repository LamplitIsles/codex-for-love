import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`installed launcher forwards ${signal} and exits after its child`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cfl-launcher-test-'));
    let launcher;
    let childPid;
    let timer;
    try {
      await mkdir(join(directory, 'bin'), { recursive: true });
      await mkdir(join(directory, 'vendor/runtime'), { recursive: true });
      const native = join(directory, 'node_modules/@lamplitisles/codex-for-love-linux-x64');
      await mkdir(native, { recursive: true });
      await cp(new URL('../packages/codex-for-love/bin/codex-for-love.mjs', import.meta.url), join(directory, 'bin/launcher.mjs'));
      await writeFile(join(directory, 'package.json'), JSON.stringify({ optionalDependencies: { '@lamplitisles/codex-for-love-linux-x64': '0.1.0-beta.0' } }));
      await writeFile(join(native, 'package.json'), '{"version":"0.1.0-beta.0"}');
      await writeFile(join(directory, 'vendor/runtime/cli.mjs'), `
        process.on('SIGTERM', () => { console.log('stopped:SIGTERM'); process.exit(0); });
        process.on('SIGINT', () => { console.log('stopped:SIGINT'); process.exit(0); });
        console.log(process.pid);
        setInterval(() => {}, 1000);
      `);
      launcher = spawn(process.execPath, [join(directory, 'bin/launcher.mjs')], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = once(launcher, 'close');
      const [ready] = await once(launcher.stdout, 'data', { signal: AbortSignal.timeout(3000) });
      childPid = Number(ready.toString().trim());
      let output = '';
      launcher.stdout.on('data', (data) => { output += data; });
      launcher.kill(signal);
      const [code, exitSignal] = await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Launcher/child did not close after stop signal')), 2000);
        }),
      ]);
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      assert.match(output, new RegExp(`stopped:${signal}`));
      assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    } finally {
      clearTimeout(timer);
      if (launcher?.pid) {
        try { process.kill(-launcher.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
