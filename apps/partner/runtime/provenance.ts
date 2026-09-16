import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { SUPPORTED_CODEX_VERSION } from './config.ts';

const CFL_FORK_REPOSITORY = 'https://github.com/lamplitisles/codex';
const CFL_FORK_SOURCE_REVISION = '445477b6a83514611ac206d2ab04b79374555a4c';
const CFL_MUSL_TARGET = 'x86_64-unknown-linux-musl';

const standaloneProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  forkRepository: z.literal(CFL_FORK_REPOSITORY),
  sourceRevision: z.string(),
  releaseTag: z.string(),
  codexVersion: z.literal(SUPPORTED_CODEX_VERSION),
  target: z.enum([CFL_MUSL_TARGET, 'aarch64-apple-darwin']),
  executables: z.object({
    'bin/codex-app-server': z.string().regex(/^[a-f0-9]{64}$/u),
    'bin/codex-code-mode-host': z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict().superRefine((value, context) => {
  const mac = value.target === 'aarch64-apple-darwin';
  const revision = mac ? 'c1139f7b2793e94c14243689d756b09c0186708d' : CFL_FORK_SOURCE_REVISION;
  const tag = mac ? /^cfl\/v0\.154\.0-app-server-darwin\.[0-9]+$/u : /^cfl\/v0\.154\.0-app-server-musl\.[0-9]+$/u;
  if (value.sourceRevision !== revision || !tag.test(value.releaseTag)) {
    context.addIssue({ code: 'custom', message: 'Source revision/release identity does not match the selected platform' });
  }
});

const provenanceSchema = standaloneProvenanceSchema;
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

  await verifyExecutableHashes(
    selectedPath,
    provenancePath,
    provenance.executables['bin/codex-app-server'],
    provenance.executables['bin/codex-code-mode-host'],
  );
}

async function verifyExecutableHashes(
  selectedPath: string,
  provenancePath: string,
  expectedBinaryHash: string,
  expectedHelperHash: string,
): Promise<void> {
  try {
    const binary = await stat(selectedPath);
    if (!binary.isFile()) throw new Error('selected path is not a regular file');
    await access(selectedPath, constants.X_OK);
  } catch (error) {
    throw new Error(`Configured Codex executable cannot be verified at ${selectedPath}: ${String(error)}`);
  }

  const actualHash = await sha256(selectedPath);
  if (actualHash !== expectedBinaryHash) {
    throw provenanceError(provenancePath, `binary hash mismatch for ${selectedPath}`);
  }
  const helper = join(dirname(selectedPath), 'codex-code-mode-host');
  await access(helper, constants.X_OK);
  if (await sha256(helper) !== expectedHelperHash) {
    throw provenanceError(provenancePath, 'code-mode host hash does not match');
  }
}
