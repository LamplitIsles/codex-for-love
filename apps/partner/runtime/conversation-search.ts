import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { validateSearchResult, validateSearchReadResult } from '@lamplit/contracts';

const executeFile = promisify(execFile);
const idSchema = z.uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySchema = z.string().trim().min(1).max(500);
const metadata = z.object({
  id: idSchema, user_id: z.string().min(1), device_id: z.string().min(1),
  source_session_id: z.string().min(1), source_ordinal: integer, cwd: z.string().min(1),
  session_name: z.string().nullable(), kind: z.enum(['message', 'compaction']),
  role: z.enum(['user', 'assistant']).nullable(), phase: z.enum(['commentary', 'final_answer']).nullable(),
  created_at: z.string().nullable(),
});
const snippet = z.object({ segments: z.array(z.object({ text: z.string(), highlighted: z.boolean() })) });
const resultSchema = z.object({ query: z.string(), total: integer, hits: z.array(metadata.extend({ snippet })).max(20) });
const recordSchema = metadata.extend({ content: z.string() });
const contextSchema = z.object({
  truncated: z.boolean(), tools_status: z.literal('not_requested'),
  items: z.array(z.object({ source_ordinal: integer, kind: z.enum(['message', 'compaction']),
    role: z.enum(['user', 'assistant']).nullable(), phase: z.enum(['commentary', 'final_answer']).nullable(),
    content: z.string(), truncated: z.boolean() })).min(1).max(17),
});
function domain(record: z.infer<typeof metadata>) {
  return { id: record.id, kind: record.kind, sessionId: record.source_session_id, cwd: record.cwd,
    ...(record.session_name === null ? {} : { sessionName: record.session_name }),
    ...(record.role === null ? {} : { role: record.role }), ...(record.phase === null ? {} : { phase: record.phase }),
    ...(record.created_at === null ? {} : { createdAt: record.created_at }) };
}
export type ConversationSearchRecord = ReturnType<typeof domain> & { content: string };
export type ConversationSearchResult = { query: string; estimatedTotalHits: number; hits: Array<ReturnType<typeof domain> & { snippet: z.infer<typeof snippet> }> };
export type ConversationSearchContext = { targetSourceRecordIndex: number; truncated: boolean; items: Array<{ sourceRecordIndex: number; kind: 'message' | 'compaction'; role?: 'user' | 'assistant'; content: string; truncated: boolean }> };

export function createConversationSearch(options: { workspace: string; env?: NodeJS.ProcessEnv }) {
  const workspace = resolve(options.workspace);
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const binary = env.FLICKLOG_BIN ?? 'flicklog';
  let pending = Promise.resolve();
  function run(args: string[]): Promise<unknown> {
    const task = pending.then(async () => {
      const { stdout } = await executeFile(binary, args, { cwd: workspace, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout) as unknown;
    });
    pending = task.then(() => undefined, () => undefined);
    return task;
  }
  async function get(id: string) {
    const record = recordSchema.parse(await run(['get', id]));
    if (record.id !== id) throw new Error('Conversation record identity mismatch');
    if (resolve(record.cwd) !== workspace) throw new Error('Conversation record is outside this workspace');
    return record;
  }
  return {
    async search(query: string, limit = 20): Promise<ConversationSearchResult> {
      const q = querySchema.parse(query);
      const count = z.number().int().min(1).max(20).parse(limit);
      const value = resultSchema.parse(await run(['search', q, '--limit', String(count)]));
      const hits = value.hits.filter(hit => resolve(hit.cwd) === workspace).map(hit => ({ ...domain(hit), snippet: hit.snippet }));
      validateSearchResult({ hits: hits.map(({ cwd: _cwd, ...hit }) => hit), estimatedTotalHits: value.total, limited: value.total > hits.length });
      return { query: value.query, estimatedTotalHits: value.total, hits };
    },
    async read(id: string): Promise<{ record: ConversationSearchRecord; context: ConversationSearchContext }> {
      const selected = idSchema.parse(id);
      const record = await get(selected);
      const context = contextSchema.parse(await run(['context', selected]));
      const target = context.items.find(item => item.source_ordinal === record.source_ordinal);
      if (!target || context.items.some((item, i, all) => i > 0 && item.source_ordinal <= all[i - 1]!.source_ordinal)
        || context.items.reduce((count, item) => count + Array.from(item.content).length, 0) > 12000) throw new Error('Conversation context does not match the record');
      if (target.kind !== record.kind || target.role !== record.role || target.phase !== record.phase
        || (!target.truncated && target.content !== record.content)) throw new Error('Conversation context target mismatch');
      // The configured daemon owns account/device/thread selection. Its context
      // DTO deliberately omits provenance; CFL validates only observable facts.
      const result = { record: { ...domain(record), content: record.content }, context: { targetSourceRecordIndex: record.source_ordinal, truncated: context.truncated,
        items: context.items.map(item => ({ sourceRecordIndex: item.source_ordinal, kind: item.kind, ...(item.role === null ? {} : { role: item.role }), content: item.content, truncated: item.truncated })) } };
      const { cwd: _cwd, ...publicRecord } = result.record;
      validateSearchReadResult({ record: publicRecord, context: result.context }, selected);
      return result;
    },
  };
}
export type ConversationSearch = ReturnType<typeof createConversationSearch>;
