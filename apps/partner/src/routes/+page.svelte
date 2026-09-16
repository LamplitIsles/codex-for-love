<script lang="ts">
  import { mergeMessages, mergeResults } from '$lib/message-pages.ts';
  import { serializeImageDrafts } from '$lib/companion/client/image-drafts.ts';
  import type { ImageAttachmentLimits } from '$lib/companion/client/contracts.ts';
  import { insertCompactBoundaries, type CompactBoundary } from '$lib/continuity.ts';
  import type { CompanionContinuitySnapshot } from '$lib/companion/continuity.ts';
  import { onMount } from 'svelte';
  import Companion from '$lib/companion/client/Companion.svelte';
  import { companionTranslate, type CompanionTranslate } from '$lib/companion/client/locale.js';
  import { APPEARANCE_STORAGE_KEY, LANGUAGE_STORAGE_KEY, initialPreferences, resolveScheme, writePreference, type CompanionAppearance, type CompanionLanguage, type CompanionScheme } from '$lib/companion/client/preferences.js';
  import type { CompanionActions, CompanionRecoveredDraft } from '$lib/companion/client/companion-bridge.js';
  import type { CompanionProjection, TimelineItem, TimelineMessageUnit } from '$lib/companion/projection.js';
  import type { CompanionStateRecord } from '$lib/companion/domain.js';
  import { CompanionPreControllerError } from '$lib/companion/client/admission.js';
  import { CompanionRecovery } from '$lib/companion/client/recovery.js';
  import { outgoingDeliveryPresentation, type MessageDelivery } from '$lib/message-delivery.ts';
  import { affinityStage } from '$lib/companion/domain.ts';
  type Message = { sequence: number; revision: number; id: string; turnId?: string | null; input: string; delivery: MessageDelivery; inputError: string | null; created: number;
    inputImages: { id: string; name: string; url: string }[] };
  type TurnResult = { id: string; turnId: string; sourceIds: string[]; sequence: number; revision: number; answers: string[]; error: string | null; status: string;
    images: { id: string; name: string; url: string }[]; voices: { id: string; url: string }[] };
  type Snapshot = { cursor: number; before: number | null; hasMore: boolean; hasChangesMore: boolean; pendingCount: number; cancellable: string[]; imageLimits?: ImageAttachmentLimits; name: string; speech?: boolean; typing: boolean; messages: Message[]; storageError: boolean;
    avatars?: { companion?: string; user?: string };
    context?: { activeTokens: number | null; windowTokens: number | null } | null;
    compactions?: CompactBoundary[]; lifecycle?: CompanionContinuitySnapshot;
    relationship?: { mood: string; moodLabel: string; note?: string; affinity: number; affinityStage: string; signature: string };
    history?: CompanionStateRecord[]; results?: TurnResult[]; draft?: CompanionRecoveredDraft };
  let session = $state<Snapshot>({ cursor: 0, before: null, hasMore: false, hasChangesMore: false, pendingCount: 0, cancellable: [], name: 'Lamplit', typing: false, messages: [], storageError: false, results: [] });
  let before = $state<number | null>(null), hasMore = $state(false), loadingOlder = $state(false);
  let cursor: number | undefined;
  let connected = $state(false), loaded = $state(false), error = $state('');
  let disposed = false, refreshAgain = false, refreshing = false, recoveryGeneration = 0;
  let refreshTask: Promise<void> | undefined, refreshTaskGeneration = 0;
  let recovery: CompanionRecovery | undefined;
  const controller = new AbortController();
  let outgoing = $state<Message[]>([]);
  const retirements = new Map<string, () => void>();
  function observeOutgoing() {
    const observed = new Set(session.messages.map(message => message.id));
    outgoing = outgoing.filter(message => !observed.has(message.id));
    for (const [id, retire] of retirements) if (observed.has(id)) { retirements.delete(id); retire(); }
  }
  const initial = initialPreferences();
  let language = $state<CompanionLanguage>(initial.language), appearance = $state<CompanionAppearance>(initial.appearance), systemDark = $state(initial.systemDark);
  let t: CompanionTranslate = $derived(companionTranslate(language));
  let scheme: CompanionScheme = $derived(resolveScheme(appearance, systemDark));
  $effect(() => { document.documentElement.lang = language === "zh" ? "zh-Hans" : "en"; document.documentElement.dataset.theme = scheme === "dark" ? "night-voyage" : "sticker-messenger"; });
  function selectLanguage(value: CompanionLanguage): void { language = value; writePreference(LANGUAGE_STORAGE_KEY, value); }
  function selectAppearance(value: CompanionAppearance): void { appearance = value; writePreference(APPEARANCE_STORAGE_KEY, value); }
  function moodText(mood: string): string { return t(`mood.${mood}` as Parameters<CompanionTranslate>[0]); }
  function affinityText(value: number): string {
    const key = ({ "疏离": "affinity.distant", "生疏": "affinity.unfamiliar", "熟悉": "affinity.familiar", "亲近": "affinity.close", "深厚": "affinity.deep" } as const)[affinityStage(value)];
    return t(key);
  }
  let projection = $derived.by((): CompanionProjection => {
    const ordered: Array<{ unit: TimelineMessageUnit; order: number }> = [];
    const results = session.results ?? [];
    const resultBySource = new Map(results.flatMap((result) => result.sourceIds.map((id) => [id, result] as const)));
    const resultOwners = new Set(results.map((result) => result.sourceIds.at(-1)).filter((id): id is string => Boolean(id)));
    const visibleMessages = [...session.messages.filter(message => message.delivery !== 'replaced'), ...outgoing.filter(local => local.delivery !== 'replaced' && !session.messages.some(message => message.id === local.id))];
    const resultUnits = (result: TurnResult): TimelineMessageUnit[] => {
      const units = result.answers.map((answer, index): TimelineMessageUnit => {
        const suffix = index === 0 ? '' : `:${index}`;
        const id = `${result.id}:answer${suffix}`;
        return { id, side: 'incoming', items: [{ id, messageKey: id, kind: 'text', side: 'incoming', text: answer }] };
      });
      for (const voice of result.voices) units.unshift({ id: `${result.id}:voice:${voice.id}`, side: 'incoming', items: [{ id: `${result.id}:voice:${voice.id}`, messageKey: `${result.id}:voice:${voice.id}`, kind: 'voice', side: 'incoming', url: voice.url }] });
      const supplemental: TimelineItem[] = [];
      for (const image of result.images) supplemental.push({ id: image.id, messageKey: result.id, kind: 'image', side: 'incoming', state: 'ready', previewUrl: image.url, alt: image.name });
      const stopped = result.status === 'interrupted' || result.status === 'cancelled';
      if (result.error || result.status === 'failed' || stopped) supplemental.push({ id: `${result.id}:error`, messageKey: result.id, kind: 'notice', side: 'incoming', tone: 'error', text: result.error === 'cancelled' || stopped ? t('reply.stopped') : t('reply.failed') });
      if (supplemental.length && units.length) {
        const last = units.at(-1)!;
        units[units.length - 1] = { ...last, items: [...last.items, ...supplemental] };
      }
      else if (supplemental.length) units.push({ id: `${result.id}:answer`, side: 'incoming', items: supplemental });
      return units;
    };
    for (const [index, message] of visibleMessages.entries()) {
      const delivery = outgoingDeliveryPresentation(message.delivery);
      const order = message.sequence > 0 ? message.sequence * 2 : Number.MAX_SAFE_INTEGER - (visibleMessages.length - index) * 2;
      const user: TimelineItem = { id: `${message.id}:user`, messageKey: `${message.id}:user`, kind: 'text', side: 'outgoing',
        text: message.input, time: message.created, pending: ['sending', 'pending', 'unresolved'].includes(message.delivery), waitsForCurrentReply: message.delivery === 'pending' };
      ordered.push({ order, unit: { id: user.id, side: 'outgoing', items: [...(message.input ? [user] : []), ...(message.inputImages ?? []).map((image): TimelineItem => ({ id: image.id, messageKey: user.messageKey, kind: 'image', side: 'outgoing', state: 'ready', previewUrl: image.url, alt: image.name }))], time: message.created, pending: delivery.pending, pendingLabel: delivery.labelKey ? t(delivery.labelKey) : undefined } });
      const result = resultBySource.get(message.id);
      // A turn result is rendered once, after the last source input. This
      // keeps multi-input turns readable without copying the same answer to
      // every source message.
      let incoming: TimelineMessageUnit[] = [];
      if (result && resultOwners.has(message.id)) {
        incoming = resultUnits(result);
      }
      if (message.inputError) incoming = [...incoming, { id: `${message.id}:input-error`, side: 'incoming', items: [{ id: `${message.id}:input-error`, messageKey: message.id, kind: 'notice', side: 'incoming', tone: 'error', text: message.inputError }] }];
      incoming.forEach((unit, index) => ordered.push({ order: order + 1 + index / 1000, unit }));
    }
    // Incremental snapshots can contain a changed source without its result
    // owner. Keep the canonical result visible at the end rather than
    // manufacturing a duplicate per message.
    for (const result of results) {
      if (!visibleMessages.some((message) => message.id === result.sourceIds.at(-1))) {
        const incoming = resultUnits(result);
        incoming.forEach((unit, index) => ordered.push({ order: result.sequence * 2 + 1 + index / 1000, unit }));
      }
    }
    ordered.sort((a, b) => a.order - b.order);
    const units = ordered.map(({ unit }) => unit);
    const timeline = insertCompactBoundaries(units, session.compactions ?? []);
    return { items: timeline.flatMap((unit) => unit.items), messageUnits: timeline,
      pendingCount: session.pendingCount, canSubmit: connected && loaded,
      running: session.typing, status: !connected && loaded ? 'offline' : session.typing ? 'working' : 'ready',
      openState: loaded ? 'open' : 'loading', hasMore, loadingOlder,
      promptError: error || (session.storageError ? t('error.storage') : undefined) };
  });
  async function refresh(signal?: AbortSignal, generation = 0): Promise<void> {
    if (generation) recoveryGeneration = Math.max(recoveryGeneration, generation);
    if (refreshTask) {
      if (generation && generation !== refreshTaskGeneration) return refreshTask.catch(() => undefined).then(() => refresh(signal, generation));
      refreshAgain = true; return refreshTask;
    }
    refreshing = true;
    const task = (async () => { try { do {
      refreshAgain = false;
      const response = await fetch(cursor === undefined ? '/api/session' : `/api/session?after=${cursor}`, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      if (!response.ok) throw new Error(t('connection.interrupted'));
      const batch: Snapshot = await response.json();
      if (disposed || (generation && generation !== recoveryGeneration)) continue;
      if (cursor === undefined) { before = batch.before; hasMore = batch.hasMore; }
      session = { ...batch, messages: mergeMessages(session.messages, batch.messages), results: mergeResults(session.results ?? [], batch.results ?? []) };
      observeOutgoing();
      cursor = batch.cursor; loaded = true;
      if (batch.hasChangesMore) refreshAgain = true;
    } while (refreshAgain && !disposed); }
    catch { throw new Error(t('connection.interrupted')); }
    finally { refreshing = false; } })();
    refreshTask = task; refreshTaskGeneration = generation;
    try { await task; } finally { if (refreshTask === task) refreshTask = undefined; }
  }
  class MessageRejected extends Error {}
  async function post(path: string, data: unknown) {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: controller.signal });
    if (response.status === 422) throw new MessageRejected(t('message.invalid'));
    if (!response.ok) throw new Error(t('message.unconfirmed'));
  }
  const actions: CompanionActions = {
    async loadOlder() {
      if (loadingOlder || !hasMore || before === null) return;
      loadingOlder = true;
      try {
        const response = await fetch(`/api/session?before=${before}`, { signal: controller.signal });
        if (!response.ok) throw new Error(t('history.loadFailed'));
        const page: Snapshot = await response.json();
        session = { ...session, messages: mergeMessages(session.messages, page.messages), results: mergeResults(session.results ?? [], page.results ?? []) };
        before = page.before; hasMore = page.hasMore;
      } catch { if (!disposed) error = t('history.loadFailed'); }
      finally { loadingOlder = false; }
    },
    async transcribeVoice(recording, signal) {
      const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': recording.mediaType }, body: recording.blob,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (!response.ok) throw new Error('Transcription failed');
      return response.json();
    },
    async send(input, images, retire) {
      if (!connected) throw new CompanionPreControllerError(t('connection.interrupted'));
      if (input === '/compact' && !images.length) {
        try { await post('/api/compact', {}); await refresh(); } catch { throw new CompanionPreControllerError(t('compact.admissionFailed')); }
        return;
      }
      let id: string = crypto.randomUUID();
      const local: Message = { id, input, delivery: 'sending', inputError: null, created: Date.now(), sequence: 0, revision: 0,
        inputImages: images.map(image => ({ id: image.id, name: image.file.name, url: image.previewUrl })) };
      outgoing = [...outgoing, local]; error = '';
      let observed = false;
      try {
        const attachments = await serializeImageDrafts(images);
        const original = id;
        outgoing = outgoing.map(message => message.id === original ? { ...message, id } : message);
        retirements.set(id, () => { observed = true; retire?.({ reason: 'observed' }); });
        observeOutgoing();
        await post('/api/messages', { id, input, images: attachments, replaces: session.draft?.sourceIds ?? [] });
        outgoing = outgoing.map(message => message.id === id ? { ...message, delivery: 'pending' } : message);
        await refresh();
      } catch (cause) {
        if (observed) return;
        outgoing = outgoing.filter(message => message.id !== id); retirements.delete(id);
        error = cause instanceof MessageRejected ? cause.message : t('message.unconfirmedDraft'); retire?.({ reason: 'failed' }); throw cause;
      }
    },
    async stop() { for (const id of session.cancellable) await post('/api/cancel', { id }); await refresh(); },
  };
  onMount(() => {
    const media = matchMedia('(prefers-color-scheme: dark)'); const updateScheme = () => { systemDark = media.matches; }; updateScheme(); media.addEventListener('change', updateScheme);
    recovery = new CompanionRecovery({
      open: () => new EventSource('/api/events'), sync: (signal, generation) => refresh(signal, generation), now: () => Date.now(),
      changed: (synced) => { connected = synced; },
      window: {
        visible: () => document.visibilityState !== 'hidden',
        on: (name, listener) => { window.addEventListener(name, listener); return () => window.removeEventListener(name, listener); },
        setTimeout: (listener, ms) => window.setTimeout(listener, ms), clearTimeout: (id) => window.clearTimeout(id),
      },
    });
    recovery.start();
    return () => { disposed = true; recovery?.close(); controller.abort(); retirements.clear(); media.removeEventListener('change', updateScheme); };
  });
</script>
<svelte:head><title>{session.name} · Lamplit</title></svelte:head>
<Companion {projection} {actions} {t} locale={language} {appearance} onLanguageChange={selectLanguage} onAppearanceChange={selectAppearance} sessionId="partner" voiceCapability={session.speech ? "available" : "unavailable"} imageLimits={session.imageLimits} onHistoryOpenChange={undefined}
  identity={{ companionName: session.name, userName: '你', preferredAddress: '你', companionAvatar: session.avatars?.companion, userAvatar: session.avatars?.user, signature: session.relationship?.signature ?? '',
    mood: session.relationship?.mood ?? 'neutral', moodLabel: moodText(session.relationship?.mood ?? 'neutral'), moodNote: session.relationship?.note,
    affinity: session.relationship?.affinity, affinityStage: affinityText(session.relationship?.affinity ?? 50) }}
  workspaceReadiness={loaded ? 'ready' : 'loading'} sessionReadiness={loaded ? 'ready' : 'loading'}
  relationshipReadiness={session.relationship ? 'ready' : 'loading'}
  continuity={{ lifecycle: session.lifecycle,
    contextPressure: session.context && session.context.activeTokens !== null && session.context.windowTokens !== null
      ? { contextWindow: session.context.windowTokens, projectedTokens: session.context.activeTokens } : undefined }}
  history={{ status: loaded ? 'ready' : 'loading', records: session.history ?? [], hasEarlier: false }}
  recoveredDraft={session.draft} />
