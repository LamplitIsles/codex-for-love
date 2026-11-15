import { z } from 'zod';
import { loadConfig, type Config } from './config.ts';
import { openMigratedVault } from './migrated-vault.ts';
import type { VaultTransaction } from './vault.ts';

const validKey = (key: string) => key.length > 0 && key.length <= 512 && key === key.trim() && !/[\x00-\x20\x7f]/u.test(key);
const provider = z.enum(['minimax', 'alibaba', 'bytedance', 'elevenlabs']);
const keyedProvider = z.enum(['alibaba', 'bytedance', 'elevenlabs']);
const voice = z.string().min(1).max(512).refine(s => s === s.trim() && !/[\x00-\x1f\x7f]/u.test(s));
const speed = z.number().finite().min(0.5).max(2).nullable();
const saveSchema = z.object({ provider, voice: z.string().transform(s => s.trim()).pipe(voice), speed }).strict().refine(v => (v.provider !== 'alibaba' && v.provider !== 'elevenlabs') || v.speed === null);
const keySchema = z.object({ provider: keyedProvider, apiKey: z.string().refine(validKey) }).strict();
const recordSchema = z.object({
  provider: provider.nullable(),
  voices: z.object({ minimax: voice.optional(), alibaba: voice.optional(), bytedance: voice.optional(), elevenlabs: voice.optional() }).strict(),
  speeds: z.object({ minimax: speed.optional(), bytedance: speed.optional() }).strict(),
  keys: z.object({ alibaba: z.string().refine(validKey).optional(), bytedance: z.string().refine(validKey).optional(), elevenlabs: z.string().refine(validKey).optional() }).strict(),
}).strict().refine(v => v.provider === null || !!v.voices[v.provider]);
type RecordValue = z.infer<typeof recordSchema>;
export class TtsSettingsError extends Error {
  code: string; status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
export function createTtsSettings(state: string, fallback: () => { tts?: NonNullable<Config['speech']>['tts'] }) {
  function read(tx: VaultTransaction): RecordValue {
    const value = tx.get('tts.settings');
    return value === undefined ? { provider: null, voices: {}, speeds: {}, keys: {} } : recordSchema.parse(JSON.parse(value));
  }
  function effective(record: RecordValue, tx: VaultTransaction) {
    const { tts } = fallback();
    const voices = { minimax: '', alibaba: '', bytedance: '', elevenlabs: '', ...(tts ? { [tts.provider]: tts.voice } : {}), ...record.voices };
    const speeds = { minimax: tts?.provider === 'minimax' ? tts.speed ?? null : null, bytedance: tts?.provider === 'bytedance' ? tts.speed ?? null : null, ...record.speeds };
    const keys = { alibaba: record.keys.alibaba ?? tx.get('cli.speech') ?? '', bytedance: record.keys.bytedance ?? tx.get('cli.tts') ?? '', elevenlabs: record.keys.elevenlabs ?? '' };
    return { provider: record.provider ?? tts?.provider ?? null, voices, speeds, keys };
  }
  function snapshot(value: ReturnType<typeof effective>) {
    const { provider, voices, speeds, keys } = value;
    return { provider, voices, speeds, configured: { alibaba: validKey(keys.alibaba), bytedance: validKey(keys.bytedance), elevenlabs: validKey(keys.elevenlabs) } };
  }
  async function access<T>(operation: (tx: VaultTransaction) => T, authorized: () => boolean = () => true): Promise<T> {
    let vault;
    try {
      vault = await openMigratedVault(state);
      return vault.transaction(operation, authorized);
    } catch (error) {
      if (error instanceof TtsSettingsError) throw error;
      if ((error as { code?: string })?.code === 'vault_unauthorized') throw new TtsSettingsError('unauthorized', 401);
      throw new TtsSettingsError('tts_settings_unavailable', 503);
    } finally { vault?.close(); }
  }
  async function update(change: (value: RecordValue) => void, authorized: () => boolean) {
    return access(tx => {
      const value = read(tx); change(value); recordSchema.parse(value);
      tx.put('tts.settings', JSON.stringify(value));
      return snapshot(effective(value, tx));
    }, authorized);
  }
  return {
    async snapshot() { return access(tx => snapshot(effective(read(tx), tx))); },
    async selection() { return access(tx => effective(read(tx), tx)); },
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

/** Re-read the operator's non-secret TTS selection for each operation. */
export async function loadTtsSettings(configPath: string) {
  const config = await loadConfig(configPath);
  return createTtsSettings(config.state, () => ({ tts: config.speech?.tts }));
}
