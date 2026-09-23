import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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
      const nativeName = process.platform === 'darwin' ? '@lamplitisles/codex-for-love-darwin-arm64' : '@lamplitisles/codex-for-love-linux-x64';
      const native = join(directory, 'node_modules', nativeName);
      await mkdir(native, { recursive: true });
      await cp(new URL('../packages/codex-for-love/bin/codex-for-love.mjs', import.meta.url), join(directory, 'bin/launcher.mjs'));
      await writeFile(join(directory, 'package.json'), JSON.stringify({ optionalDependencies: { [nativeName]: '0.1.0-beta.0' } }));
      await writeFile(join(native, 'package.json'), '{"version":"0.1.0-beta.0"}');
      await writeFile(join(directory, 'vendor/runtime/cli.mjs'), `
        process.on('SIGTERM', () => { console.log('stopped:SIGTERM'); process.exit(0); });
        process.on('SIGINT', () => { console.log('stopped:SIGINT'); process.exit(0); });
        process.stdout.write('fixture startup\\n' + JSON.stringify({ readyPid: process.pid }) + '\\n');
        setInterval(() => {}, 1000);
      `);
      launcher = spawn(process.execPath, [join(directory, 'bin/launcher.mjs')], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = once(launcher, 'close');
      let output = '';
      launcher.stdout.on('data', (data) => { output += data; });
      const lines = createInterface({ input: launcher.stdout, signal: AbortSignal.timeout(3000) });
      try {
        for await (const line of lines) {
          if (!line.startsWith('{"readyPid":')) continue;
          childPid = JSON.parse(line).readyPid;
          break;
        }
      } finally { lines.close(); }
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0, `Missing valid child readiness PID: ${output}`);
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

test('launcher refuses a resolved native package that differs from its exact pin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-launcher-pin-test-'));
  try {
    const nativeName = process.platform === 'darwin' ? '@lamplitisles/codex-for-love-darwin-arm64' : '@lamplitisles/codex-for-love-linux-x64';
    const native = join(directory, 'node_modules', nativeName);
    await mkdir(join(directory, 'bin'), { recursive: true });
    await mkdir(native, { recursive: true });
    await cp(new URL('../packages/codex-for-love/bin/codex-for-love.mjs', import.meta.url), join(directory, 'bin/launcher.mjs'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ optionalDependencies: { [nativeName]: '0.5.0' } }));
    await writeFile(join(native, 'package.json'), '{"version":"0.4.2"}');
    const result = spawnSync(process.execPath, [join(directory, 'bin/launcher.mjs'), '--help'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Expected ${nativeName}@0.5.0, found 0.4.2`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
