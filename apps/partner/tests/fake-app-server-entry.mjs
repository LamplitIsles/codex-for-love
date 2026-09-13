#!/usr/bin/env node

// The SDK supplies `app-server --listen stdio://` to the configured executable.
// Keep the protocol fake in its own module while making this test-owned entry
// point behave like a Codex executable.
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_SERVER_ARGS) writeFileSync(process.env.FAKE_SERVER_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_SERVER_CONTEXT) writeFileSync(process.env.FAKE_SERVER_CONTEXT, JSON.stringify({
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME ?? null,
  sentinel: process.env.FAKE_SERVER_SENTINEL ?? null,
}));
if (process.env.FAKE_SERVER_LIFECYCLE) {
  const markExited = () => writeFileSync(process.env.FAKE_SERVER_LIFECYCLE, `exited:${process.pid}`);
  writeFileSync(process.env.FAKE_SERVER_LIFECYCLE, `running:${process.pid}`);
  process.on('exit', markExited);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { markExited(); process.exit(0); });
}
import './fake-app-server.mjs';
