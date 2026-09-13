import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { SUPPORTED_CODEX_VERSION } from './config.ts';

export const CODEX_SOURCE_REVISION = '6b9826e3aa83b1a5947db50f4332cb9c65f1b340';

export const CODEX_PATCHES = [
  {
    path: 'patches/0001-local-compaction.patch',
    sha256: '7cdae90c40ce112cb3a591a1890be2fd32683b7d48426ed7a51813db9ee40926',
  },
  {
    path: 'patches/0002-neutral-summary-prefix.patch',
    sha256: '1b57a1fbd311fac1a209ba2749fb8810ac858f1c897f324dee0bf5395779f3f2',
  },
] as const;

const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  codexVersion: z.literal(SUPPORTED_CODEX_VERSION),
  sdkVersion: z.literal('0.2.1'),
  upstreamRepository: z.literal('https://github.com/openai/codex'),
  sourceRevision: z.literal(CODEX_SOURCE_REVISION),
  patches: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).length(CODEX_PATCHES.length),
  binaryPath: z.string().min(1),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  codeModeHostSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryIdentity: z.string().min(1),
}).strict();

type CodexProvenance = z.infer<typeof provenanceSchema>;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function provenanceError(path: string, message: string): Error {
  return new Error(`Invalid Codex provenance at ${path}: ${message}`);
}

/**
 * Verifies the exact executable selected for local compaction before the SDK
 * starts it. The app-server handshake still verifies the runtime version;
 * this sidecar binds the selected path to the pinned source and patch set.
 */
export async function verifyCodexArtifact(command: string, provenancePath: string): Promise<void> {
  if (!isAbsolute(command)) {
    throw new Error('Local compaction requires an absolute codex.command so the selected build can be verified');
  }
  const selectedPath = resolve(command);
  let raw: string;
  try {
    raw = await readFile(provenancePath, 'utf8');
  } catch (error) {
    throw new Error(`Codex provenance is required and could not be read at ${provenancePath}: ${String(error)}`);
  }

  let provenance: CodexProvenance;
  try {
    provenance = provenanceSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw provenanceError(provenancePath, error instanceof Error ? error.message : String(error));
  }

  if (provenance.patches.some((patch, index) => patch.path !== CODEX_PATCHES[index]?.path
    || patch.sha256 !== CODEX_PATCHES[index]?.sha256)) {
    throw provenanceError(provenancePath, 'patch set does not match the maintained Codex patch set');
  }
  if (!isAbsolute(provenance.binaryPath) || resolve(provenance.binaryPath) !== selectedPath) {
    throw provenanceError(provenancePath, `binaryPath does not match configured codex.command ${selectedPath}`);
  }
  if (!provenance.binaryIdentity.includes(SUPPORTED_CODEX_VERSION)) {
    throw provenanceError(provenancePath, `binary identity does not contain ${SUPPORTED_CODEX_VERSION}`);
  }

  try {
    const binary = await stat(selectedPath);
    if (!binary.isFile()) throw new Error('selected path is not a regular file');
    await access(selectedPath, constants.X_OK);
  } catch (error) {
    throw new Error(`Configured Codex executable cannot be verified at ${selectedPath}: ${String(error)}`);
  }

  const actualHash = await sha256(selectedPath);
  if (actualHash !== provenance.binarySha256) {
    throw provenanceError(provenancePath, `binary hash mismatch for ${selectedPath}`);
  }
  const helper = join(dirname(selectedPath), 'codex-code-mode-host');
  await access(helper, constants.X_OK);
  if (await sha256(helper) !== provenance.codeModeHostSha256) {
    throw provenanceError(provenancePath, 'code-mode host hash does not match');
  }
}
