import { readFile, writeFile, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_CODEX_MODEL } from './config.ts';

export const WRITABLE_MODELS = ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6.1-terra'] as const;
const id = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\r\n\u2028\u2029\x00-\x1f\x7f]/u.test(value));
const modelId = id(200);
export const ModelSelection = z.object({ sessionId: id(300), expectedModel: modelId, expectedFast: z.boolean(), model: modelId, fast: z.boolean() }).strict();
export type ModelPreference = { model: string; fast: boolean };
export class ModelPreferenceError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}
export const modelUnavailable = () => new ModelPreferenceError('model_unavailable', 503, 'Model preference is unavailable.');
const stored = z.object({ model: z.enum(WRITABLE_MODELS), fast: z.boolean() }).strict();
export async function readModelPreference(path: string): Promise<ModelPreference> {
  try { return stored.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { model: DEFAULT_CODEX_MODEL, fast: true }; throw modelUnavailable(); }
}
/** Stage without changing preference, then guard and commit without yielding. */
export async function saveModelPreference(path: string, preference: ModelPreference, guard: () => void, committed: () => void) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(preference) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    guard();
    renameSync(temporary, path);
    committed();
  } finally { await unlink(temporary).catch(() => undefined); }
}
