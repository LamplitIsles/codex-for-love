import { z } from 'zod';
import { openMigratedVault } from './migrated-vault.ts';
import type { VaultTransaction } from './vault.ts';

const key = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\x00-\x20\x7f]/u.test(value));
const recordSchema = z.object({ key, enabled: z.boolean() }).strict();
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), key }).strict(),
  z.object({ action: z.literal('enable') }).strict(),
  z.object({ action: z.literal('disable') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
]);
export class BarkSettingsError extends Error {
  code: string; status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
function read(tx: VaultTransaction) {
  const value = tx.get('bark.settings');
  return value === undefined ? undefined : recordSchema.parse(JSON.parse(value));
}
const snapshot = (value: z.infer<typeof recordSchema> | undefined) => ({ configured: !!value, enabled: value?.enabled ?? false });

export function createBark(state: string, fetchImpl: typeof fetch = fetch, shutdown?: AbortSignal) {
  async function access<T>(operation: (tx: VaultTransaction) => T, authorize: () => boolean = () => true): Promise<T> {
    let vault;
    try { vault = await openMigratedVault(state); return vault.transaction(operation, authorize); }
    catch (error) {
      if (error instanceof BarkSettingsError) throw error;
      if ((error as { code?: string })?.code === 'vault_unauthorized') throw new BarkSettingsError('unauthorized', 401);
      throw new BarkSettingsError('bark_settings_unavailable', 503);
    } finally { vault?.close(); }
  }
  return {
    snapshot: () => access(tx => snapshot(read(tx))),
    async save(input: unknown, authorize: () => boolean) {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) throw new BarkSettingsError('invalid_bark_settings', 400);
      return access(tx => {
        const previous = read(tx), action = parsed.data;
        if (action.action === 'remove') { tx.clear('bark.settings'); return snapshot(undefined); }
        if (action.action === 'enable' && !previous) throw new BarkSettingsError('bark_key_required', 409);
        const next = action.action === 'set' ? { key: action.key, enabled: previous?.enabled ?? true }
          : previous ? { ...previous, enabled: action.action === 'enable' } : undefined;
        if (next) tx.put('bark.settings', JSON.stringify(next));
        return snapshot(next);
      }, authorize);
    },
    async completed(threadId: string, turnId: string) {
      // Claim even when disabled, so event replay after enabling cannot send old turns.
      const selected = await access(tx => {
        const settings = read(tx);
        return tx.claimNotification(threadId, turnId) && settings?.enabled ? settings.key : undefined;
      });
      if (!selected) return;
      try {
        const response = await fetchImpl('https://api.day.app/push', {
          method: 'POST', redirect: 'error', signal: shutdown ? AbortSignal.any([shutdown, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_key: selected, body: 'Your companion replied.', url: 'etosllmstudio://open/chat' }),
        });
        await response.body?.cancel();
      } catch { /* An unknown or failed attempt is never retried automatically. */ }
    },
  };
}
