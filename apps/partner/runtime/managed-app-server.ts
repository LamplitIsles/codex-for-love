import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexAppServerClientOptions } from '@jaminzhou/codex-app-server-client';
import { processLog } from './logging.ts';

/** Start the configured direct app-server; the SDK connects separately over its Unix socket. */
export async function startManagedAppServer(path: string, command: string, cwd: string, env: NodeJS.ProcessEnv, options: Partial<CodexAppServerClientOptions>) {
  const maxBytes = process.platform === 'darwin' ? 103 : 107;
  if (!isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > maxBytes) {
    throw new Error(`Codex socket path must be absolute and at most ${maxBytes} bytes; configure a shorter [codex] socket_path: ${path}`);
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await stat(parent);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o077) !== 0) {
    throw new Error(`Codex socket directory must be owned by the current user and private (no group or other access): ${parent}`);
  }
  try {
    await lstat(path);
    throw new Error(`Codex socket path already exists: ${path}; inspect it before removing it`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const args = [...(options.configOverrides ?? []).flatMap(value => ['--config', value]), '--listen', `unix://${path}`, ...(options.appServerArgs ?? [])];
  const child = spawn(command, args, {
    cwd, env: { ...process.env, ...env, RUST_LOG: `${env.RUST_LOG ?? process.env.RUST_LOG ?? ''},codex_app_server_transport::transport::unix_socket=info`, LOG_FORMAT: 'json' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let exited = false;
  let exitDescription = '';
  let abnormalExit = false;
  let ready = false;
  let startupReason = 'startup_failed';
  let spawnErrorCode: string | undefined;
  let finishReady: (() => void) | undefined;
  let failReady: ((error: Error) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => { finishReady = resolve; failReady = reject; });
  const done = new Promise<void>(resolve => {
    child.on('error', error => {
      if (child.pid === undefined) {
        exited = true;
        startupReason = 'spawn_failed';
        const code = (error as NodeJS.ErrnoException).code;
        if (code && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code)) spawnErrorCode = code;
        failReady?.(new Error(`Codex app-server failed to start: ${error.message}`, { cause: error }));
        resolve();
      } else {
        processLog('app_server.process_error', { pid: child.pid });
        startupReason = 'process_error';
        failReady?.(new Error(`Codex app-server process error (PID ${child.pid})`, { cause: error }));
      }
    });
    child.once('exit', (code, signal) => {
      exited = true; exitDescription = `code ${code}, signal ${signal}`;
      abnormalExit = code !== 0 || signal !== null;
      if (!ready) {
        startupReason = 'exited_before_listening';
        failReady?.(new Error(`Codex app-server exited before listening (${exitDescription}); check socket permissions and native configuration`));
      }
      resolve();
    });
  });
  const lines = createInterface({ input: child.stderr! });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line) as { target?: string; fields?: { message?: string } };
      if (event.target === 'codex_app_server_transport::transport::unix_socket' && event.fields?.message === 'app-server control socket listening') {
        ready = true; finishReady?.();
      }
    } catch { /* Ignore other native diagnostics, which may contain private data. */ }
  });
  let closePromise: Promise<void> | undefined;
  const stop = () => closePromise ??= stopChild(child, done, () => exited, () => abnormalExit ? exitDescription : undefined);
  const timeout = setTimeout(() => {
    startupReason = 'listen_timeout';
    failReady?.(new Error(`Timed out waiting for Codex app-server socket ${path}`));
  }, options.requestTimeoutMs ?? 60_000);
  try {
    await started;
    if (exited) {
      startupReason = 'exited_after_listening';
      throw new Error(`Codex app-server exited after listening (${exitDescription})`);
    }
    return { stop };
  } catch (error) {
    clearTimeout(timeout);
    processLog('app_server.startup_failed', { reason: startupReason, socketPath: path, ...(spawnErrorCode ? { code: spawnErrorCode } : {}), ...(exited && exitDescription ? { exit: exitDescription } : {}) });
    try { await stop(); }
    catch (cleanupError) {
      processLog('app_server.startup_cleanup_failed', { reason: abnormalExit ? 'abnormal_exit' : 'signal_or_cleanup_failure', socketPath: path, ...(abnormalExit ? { exit: exitDescription } : {}) });
      throw new AggregateError([error, cleanupError], 'Codex app-server startup and cleanup both failed', { cause: error });
    }
    throw error;
  } finally { clearTimeout(timeout); }
}

async function stopChild(child: ChildProcess, done: Promise<void>, exited: () => boolean, failure: () => string | undefined) {
  if (exited()) return;
  if (!child.kill('SIGTERM') && !exited()) throw new Error(`Could not signal managed Codex app-server (PID ${child.pid ?? 'unknown'})`);
  // Unix app-server drains active admissions and turns after the first signal.
  // A timeout is diagnostic only: interrupting a turn or force-killing a hung
  // child is an operator decision, and the process may leave a socket behind.
  const warning = setTimeout(() => processLog('app_server.shutdown_waiting', { pid: child.pid }), 30_000);
  try {
    await done;
    const result = failure();
    if (result) throw new Error(`Codex app-server exited abnormally during shutdown (${result}); inspect its socket before restart`);
  } finally { clearTimeout(warning); }
}
