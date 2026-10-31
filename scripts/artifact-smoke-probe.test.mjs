import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';

const probe = new URL('./artifact-smoke-probe.mjs', import.meta.url).href;
const marker = 'owned-listener-probe';
const expected = 'synthetic response';

function start(port, source, probeModule) {
  const child = spawn(process.execPath, ['--import', probe, '--input-type=module', '-e', source], {
    env: { CFL_SMOKE_PROBE_PORT: String(port), CFL_SMOKE_PROBE_MARKER: marker, CFL_SMOKE_PROBE_HTML: expected, ...(probeModule ? { CFL_SMOKE_PROBE_MODULE: probeModule } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  child.once('close', () => clearTimeout(timer));
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  return { child, closed: once(child, 'close'), output: () => output, errors: () => errors };
}

test('probe checks its own listener before reporting HTTP success and defers close', { timeout: 10000 }, async () => {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const source = `import { createServer } from 'node:http'; const server = createServer((req, res) => { server.close(); res.end(${JSON.stringify(expected)}); }); server.listen(${port}, '127.0.0.1');`;
  const run = start(port, source);
  try {
    const [code] = await run.closed;
    assert.equal(code, 0, run.errors());
    assert.ok(run.output().split('\n').includes(marker));
  } finally { if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill('SIGKILL'); await run.closed; } }
});

test('probe module runs HTTP assertions inside the bound server process', { timeout: 10000 }, async () => {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const source = `import { createServer } from 'node:http'; const server = createServer((req, res) => { server.close(); res.end(${JSON.stringify(expected)}); }); server.listen(${port}, '127.0.0.1');`;
  const module = `export async function run(port) { const r = await fetch('http://127.0.0.1:' + port); if (await r.text() !== ${JSON.stringify(expected)}) throw new Error('unexpected body'); }`;
  const run = start(port, source, `data:text/javascript,${encodeURIComponent(module)}`);
  try {
    const [code] = await run.closed;
    assert.equal(code, 0, run.errors());
    assert.ok(run.output().split('\n').includes(marker));
  } finally { if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill('SIGKILL'); await run.closed; } }
});

test('a colliding listener receives no request and never produces the marker', { timeout: 10000 }, async () => {
  let connections = 0;
  const other = createServer(socket => { connections++; socket.destroy(); });
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  const port = other.address().port;
  const source = `import { createServer } from 'node:http'; const server = createServer(); server.on('error', () => { process.exitCode = 1; }); server.listen(${port}, '127.0.0.1');`;
  const run = start(port, source);
  try {
    const [code] = await run.closed;
    assert.notEqual(code, 0);
    assert.equal(connections, 0);
    assert.equal(run.output().split('\n').includes(marker), false);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill('SIGKILL'); await run.closed; }
    await new Promise(done => other.close(done));
  }
});
