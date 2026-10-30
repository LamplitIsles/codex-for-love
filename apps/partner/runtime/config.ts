import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

/** The app-server protocol contract tested by this application. */
export const SUPPORTED_CODEX_VERSION = '0.164.0';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CONTEXT_ROUND_LIMIT = 10;
const ttsSchema = z.object({ provider: z.enum(['minimax', 'alibaba', 'bytedance']), voice: z.string().min(1), speed: z.number().finite().min(0.5).max(2).optional() }).strict().superRefine((tts, context) => {
  if (tts.provider === 'alibaba' && tts.speed !== undefined) context.addIssue({ code: 'custom', path: ['speed'], message: 'Alibaba TTS speed is unavailable on the configured non-realtime API' });
});
const keetNames = z.array(z.string().min(1).refine(value => Array.from(value).length <= 512 && value.trim() === value && !/[\r\n\u2028\u2029]/u.test(value), 'Name must be nonempty, trimmed, at most 512 characters and on one line')).max(32).refine(values => new Set(values).size === values.length, 'Names must be unique');

const schema = z.object({
  name: z.string().min(1),
  persona: z.string().min(1),
  prompts: z.object({
    companion: z.string().refine(value => value.trim().length > 0, 'Prompt path must not be empty').optional(),
    compaction: z.string().refine(value => value.trim().length > 0, 'Prompt path must not be empty').optional(),
  }).strict().optional(),
  state: z.string().default('./state'),
  workspace: z.string().optional(),
  frontend: z.union([z.literal('latest'), z.string().regex(/^[a-f0-9]{40}$/u, 'Frontend must be latest or a full lowercase commit SHA')]).optional(),
  avatars: z.object({
    companion: z.string().min(1),
    user: z.string().min(1),
  }).strict().optional(),
  backgrounds: z.object({
    landscape: z.string().min(1),
    portrait: z.string().min(1),
  }).strict().optional(),
  port: z.number().int().min(1024).max(65535).default(3082),
  listen_host: z.string().refine((value) => isIP(value) === 4, 'Listen host must be an IPv4 address').default('127.0.0.1'),
  codex: z.object({
    command: z.string().min(1).default('codex-app-server'),
    model: z.string().min(1).default(DEFAULT_CODEX_MODEL),
    home: z.string().min(1).optional(),
    socket_path: z.string().min(1).optional(),
    fast: z.boolean().default(false),
    local_compaction: z.boolean().default(true),
    context_round_limit: z.number().int().min(0).default(DEFAULT_CONTEXT_ROUND_LIMIT),
  }).strict().default({ command: 'codex-app-server', model: DEFAULT_CODEX_MODEL, fast: false, local_compaction: true, context_round_limit: DEFAULT_CONTEXT_ROUND_LIMIT }),
  speech: z.object({
    endpoint: z.url().default('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
    tts: ttsSchema.optional(),
  }).strict().optional(),
  keet: z.object({
    endpoint: z.string().min(1).optional(),
    trusted_groups: keetNames.optional(),
    trigger_aliases: keetNames.optional(),
  }).strict().optional(),
  post: z.object({ endpoint: z.string().min(1), agent_id: z.string().min(1).max(256) }).strict().optional(),
  pet: z.object({ enabled: z.boolean().default(false) }).strict().default({ enabled: false }),
}).strict().superRefine((config, context) => {
  if (config.prompts?.compaction && !config.codex.local_compaction) {
    context.addIssue({ code: 'custom', path: ['prompts', 'compaction'], message: 'Compaction prompt requires codex.local_compaction = true' });
  }
});

export type Config = z.infer<typeof schema> & { configPath?: string };

export async function loadConfig(path: string): Promise<Config> {
  const config = schema.parse(parse(await readFile(path, 'utf8')));
  const base = dirname(resolve(path));
  return {
    ...config,
    configPath: resolve(path),
    state: resolve(base, config.state),
    persona: resolve(base, config.persona),
    prompts: config.prompts ? {
      companion: config.prompts.companion ? resolve(base, config.prompts.companion) : undefined,
      compaction: config.prompts.compaction ? resolve(base, config.prompts.compaction) : undefined,
    } : undefined,
    workspace: resolve(base, config.workspace ?? `${config.state}/workspace`),
    avatars: config.avatars ? {
      companion: resolve(base, config.avatars.companion),
      user: resolve(base, config.avatars.user),
    } : undefined,
    backgrounds: config.backgrounds ? {
      landscape: resolve(base, config.backgrounds.landscape),
      portrait: resolve(base, config.backgrounds.portrait),
    } : undefined,
    codex: {
      ...config.codex,
      home: config.codex.home ? resolve(base, config.codex.home) : undefined,
      socket_path: config.codex.socket_path ? resolve(base, config.codex.socket_path) : undefined,
    },
    post: config.post ? { ...config.post, endpoint: postEndpoint(config.post.endpoint) } : undefined,
    keet: config.keet ? {
      ...(config.keet.endpoint ? { endpoint: keetEndpoint(config.keet.endpoint) } : {}),
      trusted_groups: config.keet.trusted_groups ?? [],
      trigger_aliases: config.keet.trigger_aliases ?? [],
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

export function postEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Post endpoint must be an origin'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Post requires loopback HTTP or HTTPS origin without credentials');
  return url.origin;
}

/** Alibaba STT/TTS reuses speech; ByteDance TTS keeps its separate secret. */
export const credentialSchema = z.object({ speech: z.string().min(1).optional(), tts: z.string().min(1).optional(), keet: z.string().min(1).optional(), post: z.string().min(1).optional(), post_receiver: z.string().min(1).optional() }).strict();
export type Credentials = z.infer<typeof credentialSchema>;

export async function loadCredentials(state: string): Promise<Credentials> {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(await readFile(resolve(state, 'credentials.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return credentialSchema.parse(stored);
}
