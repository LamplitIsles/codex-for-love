import { constants, renameSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { acquirePrivateFileLock } from './private-file-lock.ts';
import { validVoiceKey } from './voice-settings.ts';
import { loadConfig, loadCredentials, type Config, type Credentials } from './config.ts';

const provider = z.enum(['minimax', 'alibaba', 'bytedance', 'elevenlabs']);
const keyedProvider = z.enum(['alibaba', 'bytedance', 'elevenlabs']);
const voice = z.string().min(1).max(512).refine(s => s === s.trim() && !/[\x00-\x1f\x7f]/u.test(s));
const speed = z.number().finite().min(0.5).max(2).nullable();
const saveSchema = z.object({ provider, voice: z.string().transform(s => s.trim()).pipe(voice), speed }).strict().refine(v => (v.provider !== 'alibaba' && v.provider !== 'elevenlabs') || v.speed === null);
const keySchema = z.object({ provider: keyedProvider, apiKey: z.string().refine(validVoiceKey) }).strict();
const recordSchema = z.object({
  provider: provider.nullable(),
  voices: z.object({ minimax: voice.optional(), alibaba: voice.optional(), bytedance: voice.optional(), elevenlabs: voice.optional() }).strict(),
  speeds: z.object({ minimax: speed.optional(), bytedance: speed.optional() }).strict(),
  keys: z.object({ alibaba: z.string().refine(validVoiceKey).optional(), bytedance: z.string().refine(validVoiceKey).optional(), elevenlabs: z.string().refine(validVoiceKey).optional() }).strict(),
}).strict().refine(v => v.provider === null || !!v.voices[v.provider]);
type RecordValue = z.infer<typeof recordSchema>;
export class TtsSettingsError extends Error {
  code: string; status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
export function createTtsSettings(state: string, fallback: () => { tts?: NonNullable<Config['speech']>['tts']; credentials: Credentials }) {
  const path = join(state, 'tts-settings.json');
  async function read(): Promise<RecordValue> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) || info.size > 16384) throw new Error('Invalid settings');
        return recordSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TtsSettingsError('tts_settings_unavailable', 503);
      return { provider: null, voices: {}, speeds: {}, keys: {} };
    }
  }
  function effective(record: RecordValue) {
    const { tts, credentials } = fallback();
    const voices = { minimax: '', alibaba: '', bytedance: '', elevenlabs: '', ...(tts ? { [tts.provider]: tts.voice } : {}), ...record.voices };
    const speeds = { minimax: tts?.provider === 'minimax' ? tts.speed ?? null : null, bytedance: tts?.provider === 'bytedance' ? tts.speed ?? null : null, ...record.speeds };
    const keys = { alibaba: record.keys.alibaba ?? credentials.speech ?? '', bytedance: record.keys.bytedance ?? credentials.tts ?? '', elevenlabs: record.keys.elevenlabs ?? '' };
    return { provider: record.provider ?? tts?.provider ?? null, voices, speeds, keys };
  }
  function snapshot(record: RecordValue) {
    const { provider, voices, speeds, keys } = effective(record);
    return { provider, voices, speeds, configured: { alibaba: validVoiceKey(keys.alibaba), bytedance: validVoiceKey(keys.bytedance), elevenlabs: validVoiceKey(keys.elevenlabs) } };
  }
  async function update(change: (value: RecordValue) => void, authorized: () => boolean) {
    try { await mkdir(state, { recursive: true, mode: 0o700 }); } catch { throw new TtsSettingsError('tts_settings_unavailable', 503); }
    let lock;
    try {
      for (let i = 0; i < 100 && !lock; i++) {
        lock = await acquirePrivateFileLock(`${path}.lock`);
        if (!lock) await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch { throw new TtsSettingsError('tts_settings_unavailable', 503); }
    if (!lock) throw new TtsSettingsError('tts_settings_busy', 409);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const value = await read(); change(value); recordSchema.parse(value);
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      if (!authorized()) throw new TtsSettingsError('unauthorized', 401);
      renameSync(temp, path);
      const directory = await open(state, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return snapshot(value);
    } catch (error) {
      if (error instanceof TtsSettingsError) throw error;
      throw new TtsSettingsError('tts_settings_unavailable', 503);
    } finally { await unlink(temp).catch(() => {}); await lock.close(); }
  }
  return {
    async snapshot() { return snapshot(await read()); },
    async selection() { return effective(await read()); },
    async save(input: unknown, authorized: () => boolean = () => true) {
      const parsed = saveSchema.safeParse(input);
      if (!parsed.success) throw new TtsSettingsError('invalid_tts_settings', 400);
      return update(value => { const v = parsed.data; value.provider = v.provider; value.voices[v.provider] = v.voice; if (v.provider === 'minimax' || v.provider === 'bytedance') value.speeds[v.provider] = v.speed; }, authorized);
    },
    async saveKey(input: unknown, authorized: () => boolean = () => true) {
      const parsed = keySchema.safeParse(input);
      if (!parsed.success) throw new TtsSettingsError('invalid_tts_key', 400);
      return update(value => { value.keys[parsed.data.provider] = parsed.data.apiKey; }, authorized);
    },
  };
}

/** Reload the operator configuration and CLI credentials for each operation. */
export async function loadTtsSettings(configPath: string) {
  const config = await loadConfig(configPath);
  const credentials = await loadCredentials(config.state);
  return createTtsSettings(config.state, () => ({ tts: config.speech?.tts, credentials }));
}
