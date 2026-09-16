import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

/** The app-server protocol contract tested by this application. */
export const SUPPORTED_CODEX_VERSION = '0.154.0';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
const ttsSchema = z.object({ provider: z.enum(['minimax', 'alibaba', 'bytedance']), voice: z.string().min(1), speed: z.number().finite().min(0.5).max(2).optional() }).strict().superRefine((tts, context) => {
  if (tts.provider === 'alibaba' && tts.speed !== undefined) context.addIssue({ code: 'custom', path: ['speed'], message: 'Alibaba TTS speed is unavailable on the configured non-realtime API' });
});

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
    command: z.string().min(1).default('codex-app-server'),
    model: z.string().min(1).default(DEFAULT_CODEX_MODEL),
    version: z.literal(SUPPORTED_CODEX_VERSION).default(SUPPORTED_CODEX_VERSION),
    home: z.string().min(1).optional(),
    provenance: z.string().min(1).optional(),
    local_compaction: z.boolean().default(false),
  }).strict().default({ command: 'codex-app-server', model: DEFAULT_CODEX_MODEL, version: SUPPORTED_CODEX_VERSION, local_compaction: false }),
  speech: z.object({
    endpoint: z.url().default('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
    tts: ttsSchema.optional(),
  }).strict().optional(),
  // Keet is deliberately all-or-nothing at runtime.  Keeping the optional
  // fields parseable lets an operator remove one value and return to an
  // ordinary local Partner without a migration or a second configuration.
  keet: z.object({
    endpoint: z.string().min(1).optional(),
    media_root: z.string().min(1).optional(),
  }).strict().optional(),
  pet: z.object({ enabled: z.boolean().default(false) }).strict().default({ enabled: false }),
}).strict();

export type Config = z.infer<typeof schema> & { configPath?: string };

export async function loadConfig(path: string): Promise<Config> {
  const config = schema.parse(parse(await readFile(path, 'utf8')));
  const base = dirname(resolve(path));
  return {
    ...config,
    configPath: resolve(path),
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
    keet: config.keet ? {
      ...(config.keet.endpoint ? { endpoint: keetEndpoint(config.keet.endpoint) } : {}),
      ...(config.keet.media_root ? { media_root: keetMediaRoot(config.keet.media_root) } : {}),
    } : undefined,
  };
}

function keetEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Keet endpoint must be a loopback http URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Keet endpoint must be a bare http://127.0.0.1:PORT URL');
  return url.origin;
}

function keetMediaRoot(value: string): string {
  if (!value.startsWith('/')) throw new Error('Keet media_root must be an absolute path');
  return resolve(value);
}

/** Alibaba STT/TTS reuses speech; ByteDance TTS keeps its separate secret. */
export const credentialSchema = z.object({ speech: z.string().min(1).optional(), tts: z.string().min(1).optional(), keet: z.string().min(1).optional() }).strict();
export type Credentials = z.infer<typeof credentialSchema>;

export async function loadCredentials(state: string): Promise<Credentials> {
  try {
    return credentialSchema.parse(JSON.parse(await readFile(resolve(state, 'credentials.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
