import { acquirePrivateFileLock } from './private-file-lock.ts';
import { constants, renameSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const voiceRegions = {
  beijing: 'https://dashscope.aliyuncs.com/api-ws/v1/inference',
  singapore: 'https://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
} as const;
export function validVoiceKey(key: string): boolean {
  return key.length > 0 && key.length <= 512 && key === key.trim() && !/[\x00-\x20\x7f]/u.test(key);
}
const region = z.enum(['beijing', 'singapore']);
const storedSchema = z.object({ region, apiKey: z.string().refine(validVoiceKey) }).strict();
const inputSchema = z.object({ region, apiKey: z.string().max(512).refine(key => key === '' || validVoiceKey(key)) }).strict();
export type VoiceSelection = { region: keyof typeof voiceRegions; apiKey: string };
export class VoiceSettingsError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

/** A single private record commits region and secret together; CLI credentials stay independent. */
export function createVoiceSettings(state: string, legacy: () => string | null) {
  const path = join(state, 'voice-settings.json');
  const lockPath = `${path}.lock`;
  async function selection(): Promise<VoiceSelection> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('Invalid private settings');
        return storedSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new VoiceSettingsError('voice_settings_unavailable', 503);
      const key = legacy() ?? '';
      return { region: 'beijing', apiKey: validVoiceKey(key) ? key : '' };
    }
  }
  const publicSnapshot = (value: VoiceSelection) => ({ region: value.region, configured: validVoiceKey(value.apiKey) });
  return {
    selection,
    async snapshot() { return publicSnapshot(await selection()); },
    async save(input: unknown, authorized: () => boolean = () => true) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new VoiceSettingsError('invalid_voice_settings', 400);
      await mkdir(state, { recursive: true, mode: 0o700 });
      let lock;
      try { lock = await acquirePrivateFileLock(lockPath); }
      catch { throw new VoiceSettingsError('voice_settings_unavailable', 503); }
      if (!lock) throw new VoiceSettingsError('voice_settings_busy', 409);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const previous = await selection();
        const next = parsed.data;
        if (!next.apiKey) {
          if (next.region !== previous.region || !validVoiceKey(previous.apiKey)) throw new VoiceSettingsError('voice_key_required', 400);
          next.apiKey = previous.apiKey;
        }
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        if (!authorized()) throw new VoiceSettingsError('unauthorized', 401);
        renameSync(temp, path);
        const directory = await open(state, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return publicSnapshot(next);
      } catch (error) {
        if (error instanceof VoiceSettingsError) throw error;
        throw new VoiceSettingsError('voice_settings_unavailable', 503);
      } finally {
        await unlink(temp).catch(() => {});
        await lock.close();
        // Keep the lock inode: unlinking it could let another writer lock a different file.
      }
    },
  };
}
