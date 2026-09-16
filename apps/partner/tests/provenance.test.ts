import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyCodexArtifact } from '../runtime/provenance.ts';

for (const identity of ['codex-artifact.json', 'codex-artifact-darwin-arm64.json']) {
  test(`selected native ${identity} verifies both binaries and rejects mixed source identity`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cfl-provenance-test-'));
    try {
      const record = JSON.parse(await readFile(new URL(`../../../release/${identity}`, import.meta.url), 'utf8'));
      delete record.archiveSha256;
      await mkdir(join(root, 'bin'));
      for (const path of Object.keys(record.executables)) {
        const content = `#!/bin/sh\n# test-owned ${path}\nexit 0\n`;
        await writeFile(join(root, path), content, { mode: 0o755 });
        record.executables[path] = createHash('sha256').update(content).digest('hex');
      }
      const sidecar = join(root, 'provenance.json');
      const binary = join(root, 'bin/codex-app-server');
      await writeFile(sidecar, JSON.stringify(record));
      await verifyCodexArtifact(binary, sidecar);
      await writeFile(sidecar, JSON.stringify({ ...record, sourceRevision: '0'.repeat(40) }));
      await assert.rejects(verifyCodexArtifact(binary, sidecar), /Source revision\/release identity/);
      await writeFile(sidecar, JSON.stringify(record));
      await writeFile(join(root, 'bin/codex-code-mode-host'), 'changed test helper');
      await assert.rejects(verifyCodexArtifact(binary, sidecar), /code-mode host hash does not match/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
