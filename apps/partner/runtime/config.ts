import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

/** The app-server protocol contract tested by this application. */
export const SUPPORTED_CODEX_VERSION = '0.154.0';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';

const schema = z.object({
  name: z.string().min(1),
  persona: z.string().min(1),
  state: z.string().default('./state'),
  workspace: z.string().optional(),
  avatars: z.object({
    companion: z.string().min(1),
    user: z.string().min(1),
  }).strict().optional(),
  port: z.number().int().min(1024).max(65535).default(3082),
  codex: z.object({
    command: z.string().min(1).default('codex'),
    executable_type: z.enum(['cli', 'app-server']).default('cli'),
    model: z.string().min(1).default(DEFAULT_CODEX_MODEL),
    version: z.literal(SUPPORTED_CODEX_VERSION).default(SUPPORTED_CODEX_VERSION),
    home: z.string().min(1).optional(),
    provenance: z.string().min(1).optional(),
    local_compaction: z.boolean().default(false),
  }).strict().default({ command: 'codex', executable_type: 'cli', model: DEFAULT_CODEX_MODEL, version: SUPPORTED_CODEX_VERSION, local_compaction: false }),
  speech: z.object({
    endpoint: z.url().default('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
    tts: z.object({ provider: z.enum(['alibaba', 'bytedance']).default('alibaba'), endpoint: z.url().default('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'), model: z.string().min(1).default('qwen3-tts-flash'), voice: z.string().min(1).default('Maia') }).strict().optional(),
  }).strict().optional(),
}).strict();

export type Config = z.infer<typeof schema>;

export async function loadConfig(path: string): Promise<Config> {
  const config = schema.parse(parse(await readFile(path, 'utf8')));
  const base = dirname(resolve(path));
  return {
    ...config,
    state: resolve(base, config.state),
    persona: resolve(base, config.persona),
    workspace: resolve(base, config.workspace ?? `${config.state}/workspace`),
    avatars: config.avatars ? {
      companion: resolve(base, config.avatars.companion),
      user: resolve(base, config.avatars.user),
    } : undefined,
    codex: {
      ...config.codex,
      home: config.codex.home ? resolve(base, config.codex.home) : undefined,
      provenance: config.codex.provenance ? resolve(base, config.codex.provenance) : undefined,
    },
  };
}

/** Only the optional STT adapter has an application-managed secret. */
export const credentialSchema = z.object({ speech: z.string().min(1).optional(), tts: z.string().min(1).optional() }).strict();
export type Credentials = z.infer<typeof credentialSchema>;

export async function loadCredentials(state: string): Promise<Credentials> {
  try {
    return credentialSchema.parse(JSON.parse(await readFile(resolve(state, 'credentials.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
