<script lang="ts">
  import { mergeMessages, mergeResults } from '$lib/message-pages.ts';
  import { serializeImageDrafts } from '$lib/companion/client/image-drafts.ts';
  import type { ImageAttachmentLimits } from '$lib/companion/client/contracts.ts';
  import { insertCompactBoundaries, type CompactBoundary } from '$lib/continuity.ts';
  import type { CompanionContinuitySnapshot } from '$lib/companion/continuity.ts';
  import { onMount } from 'svelte';
  import Companion from '$lib/companion/client/Companion.svelte';
  import { companionStyles } from '$lib/companion/client/theme.js';
  import { companionZh, type CompanionTranslate } from '$lib/companion/client/locale.js';
  import type { CompanionActions, CompanionRecoveredDraft } from '$lib/companion/client/companion-bridge.js';
  import type { CompanionProjection, TimelineItem, TimelineMessageUnit } from '$lib/companion/projection.js';
  import type { CompanionStateRecord } from '$lib/companion/domain.js';
  import { CompanionPreControllerError } from '$lib/companion/client/admission.js';
  type Message = { sequence: number; revision: number; id: string; turnId?: string | null; input: string; delivery: 'sending' | 'pending' | 'acknowledged' | 'unresolved' | 'replaced'; inputError: string | null; created: number;
    inputImages: { id: string; name: string; url: string }[] };
  type TurnResult = { id: string; turnId: string; sourceIds: string[]; sequence: number; revision: number; answers: string[]; error: string | null; status: string;
    images: { id: string; name: string; url: string }[] };
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
  let stream: EventSource | undefined;
  let disposed = false, refreshAgain = false, refreshing = false;
  const controller = new AbortController();
  let outgoing = $state<Message[]>([]);
  const retirements = new Map<string, () => void>();
  function observeOutgoing() {
    const observed = new Set(session.messages.map(message => message.id));
    outgoing = outgoing.filter(message => !observed.has(message.id));
    for (const [id, retire] of retirements) if (observed.has(id)) { retirements.delete(id); retire(); }
  }
  const t: CompanionTranslate = (key, params) => companionZh[key].replace(/\{(\w+)\}/gu, (match, name) => String(params?.[name] ?? match));
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
      const supplemental: TimelineItem[] = [];
      for (const image of result.images) supplemental.push({ id: image.id, messageKey: result.id, kind: 'image', side: 'incoming', state: 'ready', previewUrl: image.url, alt: image.name });
      const stopped = result.status === 'interrupted' || result.status === 'cancelled';
      if (result.error || result.status === 'failed' || stopped) supplemental.push({ id: `${result.id}:error`, messageKey: result.id, kind: 'notice', side: 'incoming', tone: 'error', text: result.error === 'cancelled' || stopped ? '这次回应已停止。' : '这次未能回应。' });
      if (supplemental.length && units.length) {
        const last = units.at(-1)!;
        units[units.length - 1] = { ...last, items: [...last.items, ...supplemental] };
      }
      else if (supplemental.length) units.push({ id: `${result.id}:answer`, side: 'incoming', items: supplemental });
      return units;
    };
    for (const [index, message] of visibleMessages.entries()) {
      const order = message.sequence > 0 ? message.sequence * 2 : Number.MAX_SAFE_INTEGER - (visibleMessages.length - index) * 2;
      const user: TimelineItem = { id: `${message.id}:user`, messageKey: `${message.id}:user`, kind: 'text', side: 'outgoing',
        text: message.input, time: message.created, pending: ['sending', 'pending', 'unresolved'].includes(message.delivery), waitsForCurrentReply: message.delivery === 'pending' };
      ordered.push({ order, unit: { id: user.id, side: 'outgoing', items: [...(message.input ? [user] : []), ...(message.inputImages ?? []).map((image): TimelineItem => ({ id: image.id, messageKey: user.messageKey, kind: 'image', side: 'outgoing', state: 'ready', previewUrl: image.url, alt: image.name }))], time: message.created, pending: user.pending, pendingLabel: message.delivery === 'sending' ? '正在发送…' : message.delivery === 'unresolved' ? '尚未确认送达…' : message.delivery === 'pending' ? '正在回应…' : undefined } });
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
      pendingCount: session.pendingCount,
      running: session.typing, status: !connected ? 'reconnecting' : session.typing ? 'working' : 'ready',
      openState: loaded ? 'open' : 'loading', hasMore, loadingOlder,
      promptError: error || (session.storageError ? '暂时无法保存消息。' : undefined) };
  });
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try { do {
      refreshAgain = false;
      const response = await fetch(cursor === undefined ? '/api/session' : `/api/session?after=${cursor}`, { signal: controller.signal });
      if (!response.ok) throw new Error('连接暂时中断');
      const batch: Snapshot = await response.json();
      if (cursor === undefined) { before = batch.before; hasMore = batch.hasMore; }
      session = { ...batch, messages: mergeMessages(session.messages, batch.messages), results: mergeResults(session.results ?? [], batch.results ?? []) };
      observeOutgoing();
      cursor = batch.cursor; loaded = true;
      if (batch.hasChangesMore) refreshAgain = true;
    } while (refreshAgain && !disposed); }
    catch { if (!disposed) connected = false; }
    finally { refreshing = false; }
  }
  class MessageRejected extends Error {}
  async function post(path: string, data: unknown) {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: controller.signal });
    if (response.status === 422) throw new MessageRejected('消息内容无效，请检查文字长度和图片后重新发送。');
    if (!response.ok) throw new Error('尚未确认送达，请重试。');
  }
  const actions: CompanionActions = {
    async loadOlder() {
      if (loadingOlder || !hasMore || before === null) return;
      loadingOlder = true;
      try {
        const response = await fetch(`/api/session?before=${before}`, { signal: controller.signal });
        if (!response.ok) throw new Error('暂时无法加载更早消息');
        const page: Snapshot = await response.json();
        session = { ...session, messages: mergeMessages(session.messages, page.messages), results: mergeResults(session.results ?? [], page.results ?? []) };
        before = page.before; hasMore = page.hasMore;
      } catch { if (!disposed) error = '暂时无法加载更早消息，请重试。'; }
      finally { loadingOlder = false; }
    },
    async transcribeVoice(recording, signal) {
      const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': recording.mediaType }, body: recording.blob,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (!response.ok) throw new Error('Transcription failed');
      return response.json();
    },
    async send(input, images, retire) {
      if (input === '/compact' && !images.length) {
        try { await post('/api/compact', {}); await refresh(); } catch { throw new CompanionPreControllerError('暂时无法整理对话'); }
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
        error = cause instanceof MessageRejected ? cause.message : '尚未确认送达，请检查对话中的待确认草稿。'; retire?.({ reason: 'failed' }); throw cause;
      }
    },
    async stop() { for (const id of session.cancellable) await post('/api/cancel', { id }); await refresh(); },
  };
  onMount(() => {
    const styles = document.createElement('style'); styles.textContent = companionStyles; document.head.append(styles);
    stream = new EventSource('/api/events');
    stream.onopen = () => { connected = true; void refresh(); };
    stream.onmessage = () => { void refresh(); };
    stream.onerror = () => { connected = false; };
    return () => { disposed = true; controller.abort(); stream?.close(); retirements.clear(); styles.remove(); };
  });
</script>
<svelte:head><title>{session.name} · Lamplit</title></svelte:head>
<Companion {projection} {actions} {t} locale="zh" scheme="dark" sessionId="partner" voiceCapability={session.speech ? "available" : "unavailable"} imageLimits={session.imageLimits} onHistoryOpenChange={undefined}
  identity={{ companionName: session.name, userName: '你', preferredAddress: '你', companionAvatar: session.avatars?.companion, userAvatar: session.avatars?.user, signature: session.relationship?.signature ?? '',
    mood: session.relationship?.mood ?? 'neutral', moodLabel: session.relationship?.moodLabel ?? '如常', moodNote: session.relationship?.note,
    affinity: session.relationship?.affinity, affinityStage: session.relationship?.affinityStage }}
  workspaceReadiness={loaded ? 'ready' : 'loading'} sessionReadiness={loaded ? 'ready' : 'loading'}
  relationshipReadiness={session.relationship ? 'ready' : 'loading'}
  continuity={{ lifecycle: session.lifecycle,
    contextPressure: session.context && session.context.activeTokens !== null && session.context.windowTokens !== null
      ? { contextWindow: session.context.windowTokens, projectedTokens: session.context.activeTokens } : undefined }}
  history={{ status: loaded ? 'ready' : 'loading', records: session.history ?? [], hasEarlier: false }}
  recoveredDraft={session.draft} />
