// Loaded only by fake-engine smoke checks through NODE_OPTIONS.
// The HTTP probe runs in the listening process so a failed bind cannot send a
// request to an unrelated listener, even if the selected port is taken.
import { get, Server } from 'node:http';

const port = Number(process.env.CFL_SMOKE_PROBE_PORT);
const marker = process.env.CFL_SMOKE_PROBE_MARKER;
const expected = process.env.CFL_SMOKE_PROBE_HTML;
if (!Number.isInteger(port) || !marker || !expected) throw new Error('Invalid artifact smoke probe configuration');
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[0] === port && args[1] === '127.0.0.1') {
    const server = this;
    const close = server.close;
    let pending = true;
    const deferred = [];
    server.close = function (...closeArgs) {
      if (pending) { deferred.push(closeArgs); return this; }
      return close.apply(this, closeArgs);
    };
    const finish = () => {
      if (!pending) return;
      pending = false;
      for (const closeArgs of deferred) close.apply(server, closeArgs);
    };
    server.once('error', finish);
    server.once('listening', async () => {
      server.off('error', finish);
      if (process.env.CFL_SMOKE_PROBE_MODULE) {
        try {
          const { run } = await import(process.env.CFL_SMOKE_PROBE_MODULE);
          await run(port);
          console.log(marker);
        } catch (error) {
          console.error('Artifact smoke probe failed:', error);
        } finally { finish(); }
        return;
      }
      const request = get({ host: '127.0.0.1', port, path: '/', agent: false, signal: AbortSignal.timeout(5000) }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode === 200 && body === expected) console.log(marker);
          else console.error('Artifact smoke frontend response did not match the fixture');
          finish();
        });
        response.on('error', finish);
      });
      request.on('error', finish);
    });
  }
  return listen.apply(this, args);
};
