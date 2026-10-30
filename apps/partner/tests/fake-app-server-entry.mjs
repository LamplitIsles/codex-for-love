#!/usr/bin/env node

// The fixture supports both the Partner Unix listener and converter stdio.
// Keep the protocol fake in its own module while making this test-owned entry
// point behave like a Codex executable.
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_SERVER_ARGS) writeFileSync(process.env.FAKE_SERVER_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_SERVER_CONTEXT) writeFileSync(process.env.FAKE_SERVER_CONTEXT, JSON.stringify({
  cwd: process.cwd(),
  postTokenMatches: Boolean(process.env.FAKE_EXPECT_POST_TOKEN && process.env.CFL_POST_TOKEN === process.env.FAKE_EXPECT_POST_TOKEN),
  codexHome: process.env.CODEX_HOME ?? null,
  sentinel: process.env.FAKE_SERVER_SENTINEL ?? null,
}));
if (process.env.FAKE_SERVER_LIFECYCLE) {
  const markExited = (code) => writeFileSync(process.env.FAKE_SERVER_LIFECYCLE, `exited:${process.pid}:${code}`);
  writeFileSync(process.env.FAKE_SERVER_LIFECYCLE, `running:${process.pid}`);
  process.on('exit', markExited);
  if (!process.argv.includes('--listen') || !process.argv[process.argv.indexOf('--listen') + 1]?.startsWith('unix://')) {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { markExited(0); process.exit(0); });
  }
}
import './fake-app-server.mjs';
