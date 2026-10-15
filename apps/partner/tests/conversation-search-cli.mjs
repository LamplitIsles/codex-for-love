// Test-owned FlickLog process fixture. Speaks CLI search/get/context, never public RPC.
import { readFileSync, appendFileSync } from 'node:fs';
const [command, value, , limit] = process.argv.slice(2);
const data = JSON.parse(readFileSync(process.env.FLICKLOG_TEST_DATA, 'utf8'));
appendFileSync(process.env.FLICKLOG_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME }) + '\n');
const control = JSON.parse(readFileSync(process.env.FLICKLOG_TEST_CONTROL, 'utf8'));
if (control[command]) { console.error('test-owned native failure'); process.exit(1); }
const record = data.records.find(r => r.id === value);
if (command === 'search') {
  const matches = data.records.filter(r => r.content.includes(value));
  console.log(JSON.stringify({ query: value, total: matches.length,
    hits: matches.slice(0, Number(limit)).map(({ content, ...r }) => ({ ...r, snippet: { segments: [{ text: value, highlighted: true }, { text: content, highlighted: false }] } })) }));
} else if (command === 'get') {
  if (!record) process.exit(1);
  console.log(JSON.stringify(record));
} else if (command === 'context') {
  if (!record) process.exit(1);
  // Fixture native context semantics: default eligible records, eight per side,
  // source indexes and a Unicode code-point budget independent of selected text.
  const path = data.paths[value];
  const target = path.findIndex(r => r.source_ordinal === data.targets[value]);
  const nearby = path.slice(Math.max(0, target - 8), target + 9);
  let remaining = 12000, truncated = nearby.length !== path.length;
  const items = nearby.map(item => {
    const points = Array.from(item.content), kept = points.slice(0, remaining);
    remaining -= kept.length;
    if (kept.length < points.length) { truncated = true; return { ...item, content: kept.join(''), truncated: true }; }
    return item;
  }).filter(item => item.content.length);
  console.log(JSON.stringify({ tools_status: 'not_requested', truncated, items: items.map(({ source_ordinal, kind, role, phase, content, truncated = false }) => ({ source_ordinal, kind, role, phase, content, truncated })) }));
} else process.exit(1);
