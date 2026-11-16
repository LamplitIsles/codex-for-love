import { z } from 'zod';
import { openMigratedVault } from './migrated-vault.ts';
import type { VaultTransaction } from './vault.ts';
import { processLog } from './logging.ts';

type BarkStage = 'eligibility' | 'inspection' | 'claim' | 'configuration' | 'send';
type BarkReason = 'started' | 'eligible' | 'not_live' | 'not_completed' | 'thread_mismatch' | 'no_input' | 'no_reply' | 'aborted' | 'failed' | 'claimed' | 'duplicate' | 'not_configured' | 'disabled' | 'accepted' | 'upstream_rejected' | 'timeout' | 'network_failure' | 'unauthorized';
export function barkAttempt(kind: 'normal' | 'test') {
  const id = crypto.randomUUID(), started = performance.now();
  return (stage: BarkStage, reason: BarkReason, httpStatus?: number) => processLog('bark.notification', {
    time: new Date().toISOString(), attemptId: id, kind, stage, reason,
    elapsedMs: Math.round(performance.now() - started), ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

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
  async function send(selected: string, kind: 'normal' | 'test', log: ReturnType<typeof barkAttempt>) {
    log('send', 'started');
    const timeout = AbortSignal.timeout(5000);
    try {
      const response = await fetchImpl('https://api.day.app/push', {
        method: 'POST', redirect: 'manual', signal: shutdown ? AbortSignal.any([shutdown, timeout]) : timeout,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: selected, body: kind === 'test' ? 'This is a test notification from Codex for Love.' : 'Your companion replied.', url: 'etosllmstudio://open/chat' }),
      });
      const accepted = response.status >= 200 && response.status < 300;
      log('send', accepted ? 'accepted' : 'upstream_rejected', response.status);
      void response.body?.cancel().catch(() => {});
      return accepted ? 'accepted' as const : 'upstream_rejected' as const;
    } catch {
      log('send', timeout.aborted ? 'timeout' : 'network_failure');
      return 'outcome_unknown' as const;
    }
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
    async test(authorize: () => boolean) {
      const log = barkAttempt('test');
      log('configuration', 'started');
      let settings;
      try { settings = await access(tx => read(tx), authorize); }
      catch (error) { log('configuration', error instanceof BarkSettingsError && error.code === 'unauthorized' ? 'unauthorized' : 'failed'); throw error; }
      if (!authorize()) { log('configuration', 'unauthorized'); throw new BarkSettingsError('unauthorized', 401); }
      if (!settings) { log('configuration', 'not_configured'); throw new BarkSettingsError('bark_not_configured', 409); }
      if (!settings.enabled) { log('configuration', 'disabled'); throw new BarkSettingsError('bark_disabled', 409); }
      const result = await send(settings.key, 'test', log);
      if (result === 'upstream_rejected') throw new BarkSettingsError('bark_upstream_rejected', 502);
      if (result === 'outcome_unknown') throw new BarkSettingsError('outcome_unknown', 504);
      return { status: 'accepted' as const };
    },
    async completed(threadId: string, turnId: string, log = barkAttempt('normal')) {
      // Claim even when disabled, so event replay after enabling cannot send old turns.
      log('claim', 'started');
      let selected;
      try {
        selected = await access(tx => {
          const settings = read(tx);
          return { settings, claimed: tx.claimNotification(threadId, turnId) };
        });
      } catch { log('claim', 'failed'); return; }
      if (!selected.claimed) { log('claim', 'duplicate'); return; }
      log('claim', 'claimed');
      if (!selected.settings) { log('configuration', 'not_configured'); return; }
      if (!selected.settings.enabled) { log('configuration', 'disabled'); return; }
      await send(selected.settings.key, 'normal', log);
    },
  };
}
