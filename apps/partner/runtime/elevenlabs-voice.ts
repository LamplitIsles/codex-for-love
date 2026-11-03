import { CodexAppServerClient } from '@jaminzhou/codex-app-server-client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { receiveElevenLabsAudio } from './elevenlabs-audio.ts';

type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP response');
  return value as RecordValue;
}
function singleId(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !value[0]) throw new Error('Invalid MCP response');
  return value[0];
}

/** One connection to the existing app-server, never a new server or thread. */
export async function elevenLabsSpeech(options: { workspace: string; socketPath?: string; text: string; voice: string; signal: AbortSignal; fetchImpl?: typeof fetch; clientFactory?: (socketPath: string) => CodexAppServerClient }): Promise<Uint8Array> {
  const { workspace, signal } = options;
  signal.throwIfAborted();
  const marker = object(JSON.parse(await readFile(join(workspace, '.lamplit/thread.json'), 'utf8')));
  if (typeof marker.threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(marker.threadId)) throw new Error('Invalid thread');
  const socketPath = options.socketPath ?? join(workspace, '.lamplit/run/codex.sock');
  const client = options.clientFactory?.(socketPath) ?? new CodexAppServerClient({
    transport: { type: 'unix', socketPath },
    capabilities: { experimentalApi: true, requestAttestation: false },
    clientInfo: { name: 'cfl-voice', title: 'CFL Voice', version: '0.1.0' },
    protocolValidation: 'strict', requestTimeoutMs: 60_000, onUnhandledError: () => {},
  });
  const abort = () => { void client.close().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect();
    signal.throwIfAborted();
    const call = async (tool: string, args: RecordValue): Promise<RecordValue> => {
      signal.throwIfAborted();
      const result = await client.call('mcpServer/tool/call', { threadId: marker.threadId, server: 'elevenlabs', tool, arguments: args });
      signal.throwIfAborted();
      if (result.isError) throw new Error('MCP call failed');
      return object(result.structuredContent);
    };
    // This is the only generation call. Even a lost response is not replayed.
    const started = await call('creative_generate_speech', { prompt: options.text, model_id: 'eleven_v4', voice_id: options.voice, context: 'Generate a short voice message', generations_count: 1 });
    if (typeof started.flow_id !== 'string' || !started.flow_id || !Array.isArray(started.pending) || started.pending.length !== 1 || started.pending[0]?.kind !== 'audio' || typeof started.pending[0]?.generation_id !== 'string' || !started.pending[0].generation_id) throw new Error('Invalid generation');
    const sessionId = singleId(started.session_ids);
    if (!Array.isArray(started.results) || started.results.length !== 1 || started.results[0]?.success !== true || started.results[0]?.session_id !== sessionId || started.summary?.generations_started !== 1 || started.summary?.failed !== 0) throw new Error('Invalid generation');
    if (!Number.isInteger(started.poll_after_seconds) || started.poll_after_seconds < 0 || started.poll_after_seconds > 60) throw new Error('Invalid polling delay');
    const generationId = started.pending[0].generation_id;
    for (;;) {
      await sleep(Math.max(250, started.poll_after_seconds * 1000), undefined, { signal });
      const status = await call('creative_get_flow_run_status', { flow_id: started.flow_id, session_ids: [sessionId], context: 'Check the short voice message' });
      if (status.flow_id !== started.flow_id || singleId(status.session_ids) !== sessionId || status.session_id !== sessionId || status.has_failures !== false || typeof status.all_completed !== 'boolean') throw new Error('Invalid generation status');
      if (!status.all_completed) continue;
      if (!Array.isArray(status.generations) || status.generations.length !== 1) throw new Error('Invalid generation status');
      const generation = object(status.generations[0]);
      if (generation.id !== generationId || generation.status !== 'completed' || generation.modality !== 'audio' || generation.model_id !== 'eleven_v4' || typeof generation.content_url !== 'string') throw new Error('Invalid generation status');
      return await receiveElevenLabsAudio(generation.content_url, signal, options.fetchImpl);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => undefined);
  }
}
