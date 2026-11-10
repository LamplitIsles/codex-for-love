import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const mode of ['normal', 'timeout'] as const) {
  test(`SDK WebSocket ${mode} close releases its watchdog`, { timeout: 15_000 }, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import { WebSocketServer } from 'ws';
      import { WebSocketMessageTransport } from '@jaminzhou/codex-app-server-client';
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const connection = once(server, 'connection');
      const transport = await WebSocketMessageTransport.connect({
        type: 'websocket', url: 'ws://127.0.0.1:' + server.address().port,
        allowInsecureRemote: true, closeTimeoutMs: process.argv[1] === 'normal' ? 30000 : 250,
      });
      const [peer, request] = await connection;
      let reason;
      transport.onClose(error => { reason = error; });
      if (process.argv[1] === 'timeout') request.socket.pause();
      const started = performance.now();
      await transport.close();
      assert(reason);
      if (process.argv[1] === 'normal') assert.match(reason.message, /closed \\(1000\\)/);
      else {
        assert.match(reason.message, /did not close within 250ms/);
        assert(performance.now() - started >= 200, 'the close timeout must not fire early');
      }
      peer.terminate();
      transport.dispose();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      console.log('closed: ' + process.argv[1]);
    `;
    const root = await mkdtemp(join(tmpdir(), 'cfl-sdk-close-'));
    try {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, mode], {
        cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_DISABLE_COMPILE_CACHE: '1' },
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      try {
        const [code, signal] = await once(child, 'close');
        assert.equal(signal, null, output);
        assert.equal(code, 0, output);
        assert.match(output, new RegExp(`closed: ${mode}`));
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
