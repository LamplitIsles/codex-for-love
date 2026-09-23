import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const idSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const querySchema = z.string().trim().min(1).max(500);
const resultSchema = z.object({
  query: z.string(),
  estimatedTotalHits: z.number().int().nonnegative(),
  hits: z.array(z.object({
    id: idSchema,
    kind: z.enum(['message', 'compaction']),
    sessionId: z.string(),
    sessionName: z.string().optional(),
    cwd: z.string(),
    role: z.enum(['user', 'assistant']).optional(),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    createdAt: z.string().optional(),
    snippet: z.string(),
  })).max(20),
});
const recordSchema = z.object({
  id: idSchema,
  kind: z.enum(['message', 'compaction']),
  sessionId: z.string(),
  sessionName: z.string().optional(),
  cwd: z.string(),
  role: z.enum(['user', 'assistant']).optional(),
  phase: z.enum(['commentary', 'final_answer']).optional(),
  createdAt: z.string().optional(),
  content: z.string(),
});
const contextSchema = z.object({
  messageId: idSchema,
  targetSourceRecordIndex: z.number().int(),
  truncated: z.boolean(),
  items: z.array(z.object({
    sourceRecordIndex: z.number().int(),
    kind: z.enum(['message', 'compaction', 'tool']),
    role: z.enum(['user', 'assistant']).optional(),
    phase: z.string().optional(),
    content: z.string(),
    truncated: z.boolean().optional(),
  })),
});

export type ConversationSearchResult = z.infer<typeof resultSchema>;
export type ConversationSearchRecord = z.infer<typeof recordSchema>;
export type ConversationSearchContext = z.infer<typeof contextSchema>;

export function createConversationSearch(options: { workspace: string; codexHome?: string; env?: NodeJS.ProcessEnv }) {
  const workspace = resolve(options.workspace);
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) };
  const binary = env.FLICKLOG_BIN ?? 'flicklog';
  let pending = Promise.resolve();
  function run(args: string[]): Promise<unknown> {
    const task = pending.then(async () => {
      if (!env.FLICKLOG_MEILI_KEY && env.CREDENTIALS_DIRECTORY) {
        try { env.FLICKLOG_MEILI_KEY = (await readFile(join(env.CREDENTIALS_DIRECTORY, 'flicklog-meili-key'), 'utf8')).trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const { stdout } = await executeFile(binary, args, { cwd: workspace, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout) as unknown;
    });
    pending = task.then(() => undefined, () => undefined);
    return task;
  }
  return {
    async search(query: string, limit = 20): Promise<ConversationSearchResult> {
      const q = querySchema.parse(query);
      const count = z.number().int().min(1).max(20).parse(limit);
      const value = z.object({ results: resultSchema }).parse(await run(['search', q, '--limit', String(count)]));
      return { ...value.results, hits: value.results.hits.filter((hit) => resolve(hit.cwd) === workspace) };
    },
    async read(id: string): Promise<{ record: ConversationSearchRecord; context: ConversationSearchContext }> {
      const selected = idSchema.parse(id);
      const record = recordSchema.parse(await run(['get', selected]));
      if (resolve(record.cwd) !== workspace) throw new Error('Conversation record is outside this workspace');
      const context = contextSchema.parse(await run(['context', selected]));
      if (context.messageId !== selected) throw new Error('Conversation context does not match the record');
      return { record, context };
    },
  };
}

export type ConversationSearch = ReturnType<typeof createConversationSearch>;
