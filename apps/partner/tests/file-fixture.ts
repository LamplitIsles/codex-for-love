import type { Partner } from '../runtime/partner.ts';

export async function stageTestFiles(partner: Partner, sessionId: string, operationId: string, files: Array<{ id: string; name: string; mediaType: string; bytes: Buffer }>) {
  const owner = { ownerId: 'owner', sessionId };
  const manifest = { sessionId, operationId, files: files.map(({ id, name, mediaType, bytes }) => ({ id, name, mediaType, size: bytes.length })) };
  await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
  for (const file of files) await partner.fileOperationReceive(operationId, file.id, (async function* () { yield file.bytes; })(), owner, async () => true, () => true);
  return partner.fileOperationComplete(operationId, owner, async () => true, () => true);
}

export async function readTestFile(partner: Partner, id: string, owner: { ownerId: string; sessionId: string }) {
  const file = await partner.openSharedFile(id, owner);
  if (!file) return null;
  try { return await file.handle.readFile(); } finally { await file.handle.close(); }
}
