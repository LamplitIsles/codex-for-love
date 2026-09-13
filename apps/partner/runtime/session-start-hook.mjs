import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

const contextPath = process.argv[2];
if (!contextPath) process.exit(0);

let input = '';
for await (const chunk of process.stdin) input += chunk;
let hookInput = {};
try { hookInput = JSON.parse(input || '{}'); } catch { process.exit(0); }

let bootstrap;
try { bootstrap = JSON.parse(await readFile(contextPath, 'utf8')); }
catch { process.exit(0); }
if (!bootstrap || typeof bootstrap.context !== 'string' || typeof bootstrap.compact !== 'string') process.exit(0);

const source = hookInput.source ?? hookInput.sessionStartSource ?? hookInput.session_start_source;
const startup = source === 'startup' && bootstrap.startupPending === true;
const compact = source === 'compact';
if (!startup && !compact) process.exit(0);

if (startup) {
  const temporary = `${contextPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...bootstrap, startupPending: false }), { mode: 0o600 });
    await rename(temporary, contextPath);
  } finally { await unlink(temporary).catch(() => undefined); }
}

const additionalContext = compact ? bootstrap.compact : bootstrap.context;
if (additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }));
}
