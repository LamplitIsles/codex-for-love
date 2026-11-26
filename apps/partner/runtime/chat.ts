import { capabilities, mediaUrl, albumImageThumbnailUrl, PAGE_SIZE, type ImageRef, type FileRef, type ChatMessage, type ChatView, type HistorySyncRecord, type HistorySyncResult } from '@lamplit/contracts';
import { createChatHost, type ChatBackend, type ChatChange } from '@lamplit/contracts/server';
import { panelCursors } from './panel-cursor.ts';
import type { Partner } from './partner.ts';
import type { ConversationSearch } from './conversation-search.ts';
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { voiceMessageId } from './conversation-media.ts';
import { historyCursor, readHistorySync, HistoryProjectionMismatch } from './history-sync.ts';
import { type HistoryIndexInput, type HistoryIndexState } from './store.ts';

type HistoryProjection = { record: Omit<HistorySyncRecord, 'orderKey'>; stable: string };
type HistoryManager = { session: string; ready: Promise<void>; state?: HistoryIndexState; listeners: Set<() => void>; repair(): Promise<void>; project(turnIds: readonly string[], messageIds?: ReadonlySet<string>): Promise<HistoryProjection[]> };
const histories = new WeakMap<Partner['historyStore'], HistoryManager>();
function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, normalize(item)])) : v;
  return JSON.stringify(normalize(value));
}

export function createCodexChatBackend(partner: Partner, authorize: () => Promise<boolean> = async () => true, conversationSearch?: ConversationSearch, authorizeCommit?: () => boolean): ChatBackend {
  const cursors = panelCursors();
  const scope = Symbol('partner chat session');
  let changed: ((change: ChatChange) => void) | undefined;
  let current: ChatView | undefined;
  let dirty = false, running = false, closed = false;
  let waitingReply: string | undefined;
  let waitingChanged = false;
  const latest = new Map<string, { turnId: string; text: string; textState: 'streaming' | 'complete' }>();
  async function page(selectedTurns?: readonly string[], selectedMessages?: ReadonlySet<string>) {
    // Shared host refresh must read the current projection without waiting
    // for native history; known activity and durable receipts are independent.
    const snapshotStream = partner.streamingReply();
    const snapshot = await partner.snapshot({}, false, selectedTurns);
    const visible = new Map(await Promise.all(snapshot.messages.map(async m => [m.id, await partner.chatVisible(m.id)] as const)));
    if (selectedTurns && snapshot.messages.some(message => !visible.get(message.id))) throw new Error('Final history is awaiting delivery reconciliation');
    const ordered: Array<{ order: number; position?: number; message: ChatMessage; fileIds?: string[]; stableText?: string; stableImage?: ImageRef }> = [];
    for (const m of snapshot.messages) {
      if (!visible.get(m.id)) continue;
      const images = (await Promise.all(m.inputImages.map(image => partner.sharedImageRef(image.id)))).filter((ref): ref is ImageRef => !!ref);
      const post = m.post;
      // Post image checkpoints and input_images share content order. Suppress a
      // marker only when its exact shared attachment is actually available.
      const postText = post?.parts.filter(part => {
        if (part.imageIndex === undefined || m.inputImages.length !== post.imageCount) return true;
        const id = m.inputImages[part.imageIndex]?.id;
        return !images.some(image => image.attachmentId === id && image.availability === 'available');
      }).map(part => part.text).join('\n');
      const source: ChatMessage['source'] = m.keet
        ? { kind: 'keet', channel: m.keet.kind, destination: m.keet.destination, senderLabel: m.keet.senderLabel }
        : m.matrix ? { kind: 'matrix', senderId: m.matrix.sender_id, senderDisplayName: m.matrix.sender_display_name, roomId: m.matrix.room_id }
        : m.post ? m.post.source.platform === 'keet'
          ? { kind: 'keet', channel: m.post.source.conversationType === 'direct' ? 'dm' : 'group',
            senderLabel: keetDisplayLabel(m.post.source.senderDisplayName, '未知发送者'),
            destination: keetDisplayLabel(m.post.source.conversationName, '未命名聊天') }
          : { ...m.post.source, platform: m.post.source.platform }
        : m.alarm ? { kind: 'reminder', reminderId: m.id.split(':')[1]!, occurrenceId: m.id } : undefined;
      const owner = snapshot.results.find(result => result.sourceIds.includes(m.id));
      const slot = owner?.timeline.find(entry => entry.kind === 'user' && entry.sourceIds.includes(m.id));
      const position = slot ? slot.position + slot.sourceIds.indexOf(m.id) / (slot.sourceIds.length + 1) : undefined;
      ordered.push({ order: owner ? owner.anchorSequence * 2 : m.sequence * 2, ...(owner ? { position: position ?? -1 } : {}), fileIds: m.inputFiles, ...(post ? { stableText: post.parts.map(part => part.text).join('\n') } : {}), message: {
        id: m.id, role: 'user', text: m.keet ? `${m.keet.text}${m.keet.imageNote ?? ''}` : m.matrix ? m.matrix.body : post ? postText! : m.input,
        ...(images.length ? { images } : {}), createdAt: m.matrix?.timestamp ?? m.post?.timestamp ?? m.created,
        operationId: m.id, turnId: m.turnId, ...(source ? { source } : {}),
      } });
    }
    for (const r of snapshot.results) {
        const createdAt = r.anchorCreated;
        const order = r.anchorSequence * 2;
        for (const slot of r.timeline) {
          if (slot.kind === 'text' && slot.text !== undefined && (slot.text || slot.textState === 'streaming')) {
            ordered.push({ order, position: slot.position, message: { id: slot.itemId, role: 'agent', text: slot.text, textState: slot.textState, createdAt, operationId: null, turnId: r.turnId } });
          } else if (slot.kind === 'image' && (slot.imageId || slot.imageState === 'failed')) {
            const image = slot.imageId ? await partner.sharedImageRef(slot.imageId) : undefined;
            const imageState = slot.imageState === 'failed' ? 'failed' : image?.availability === 'available' ? 'ready' : 'unknown';
            ordered.push({ order, position: slot.position, ...(image ? { stableImage: image } : {}), message: { id: `image:${createHash('sha256').update(JSON.stringify([r.turnId, slot.itemId])).digest('hex')}`, role: 'agent', text: '', imageState,
              ...(imageState === 'ready' && image ? { images: [image] } : {}), createdAt, operationId: null, turnId: r.turnId } });
          } else if (slot.kind === 'ui' && Object.hasOwn(slot, 'ui')) {
            const message: ChatMessage & { ui: unknown } = { id: `ui:${createHash('sha256').update(JSON.stringify([r.turnId, slot.itemId])).digest('hex')}`, role: 'agent', text: '', ui: slot.ui, createdAt, operationId: null, turnId: r.turnId };
            ordered.push({ order, position: slot.position, message });
          } else if (slot.kind === 'voice' && slot.voiceId) {
            ordered.push({ order, position: slot.position, message: { id: voiceMessageId(r.id, slot.itemId, slot.voiceId), role: 'agent', text: '', voice: { id: slot.voiceId }, createdAt, operationId: null, turnId: r.turnId } });
          }
        }
        if (['failed', 'interrupted', 'cancelled'].includes(r.chatStatus)) ordered.push({ order, position: Number.POSITIVE_INFINITY, message: { id: `${r.id}:status`, role: 'notice', text: r.chatStatus === 'failed' ? '回复失败' : '已停止回复', createdAt, operationId: null, turnId: r.turnId } });
    }
    ordered.sort((a,b) => a.order - b.order || (a.position ?? 0) - (b.position ?? 0));
    const end = ordered.length;
    const start = selectedTurns ? 0 : Math.max(0, end - PAGE_SIZE);
    const hasOlder = start > 0 || (snapshot.hasMore && snapshot.before !== null);
    // Check file bytes only for the messages actually returned on this page.
    // Do not retain results across reads: files can change or disappear.
    const messages: ChatMessage[] = [];
    const projections: HistoryProjection[] = [];
    for (const { message, fileIds, stableText, stableImage } of ordered.slice(start, end)) {
      if (selectedMessages && !selectedMessages.has(message.id)) continue;
      // Bound concurrent buffers to one message's files (at most six).
      const files = (await Promise.all((fileIds ?? []).map(id => partner.sharedFileRef(id)))).filter((ref): ref is FileRef => !!ref);
      const full = files.length ? { ...message, files } : message;
      messages.push(full);
      if (selectedTurns) {
        const owner = snapshot.results.find(result => result.turnId === full.turnId);
        const alarm = owner?.sourceIds.length === 1 ? /^alarm:([^:]+):(\d+)$/u.exec(owner.sourceIds[0]!) : undefined;
        const triggeredAtMs = alarm ? Number(alarm[2]) : NaN;
        const wake = full.role === 'agent' && alarm && Number.isSafeInteger(triggeredAtMs) ? { occurrenceId: alarm[0], reminderId: alarm[1]!, triggeredAtMs } : undefined;
        const stableImageRef = stableImage && (({ availability: _availability, ...ref }) => ref)(stableImage);
        const canonical = { ...full, text: stableText ?? full.text,
          ...(full.imageState && full.imageState !== 'failed' ? { imageState: 'ready', images: stableImageRef ? [stableImageRef] : [] } : {}),
          ...(full.images && !full.imageState ? { images: full.images.map(({ availability: _availability, ...ref }) => ref) } : {}),
          ...(full.files ? { files: full.files.map(({ availability: _availability, ...ref }) => ref) } : {}) };
        // The shared schema permits a missing image reference without an
        // imageState, but forbids images beside imageState=unknown. Keep the
        // live placeholder unchanged and retain the durable ID for sync clients.
        const { imageState: _imageState, ...withoutImageState } = full;
        const historical = stableImage?.availability === 'missing' && full.imageState === 'unknown'
          ? { ...withoutImageState, images: [stableImage] } : full;
        projections.push({ record: { message: historical, ...(wake ? { wake } : {}) }, stable: stableJson([canonical, wake ?? null]) });
      }
    }
    let syncBefore: string | null = null;
    const currentHistory = histories.get(partner.historyStore);
    const state = currentHistory?.session === snapshot.sessionId ? currentHistory.state : undefined;
    if (!selectedTurns && hasOlder && state) {
      let number = state.head;
      for (const message of messages) {
        const position = await partner.historyStore.historyIndexPosition(snapshot.sessionId, message.id);
        if (position) { number = position.ordinal - 1; break; }
      }
      if (number > 0) {
        const [row] = await partner.historyStore.historyIndexEntries(snapshot.sessionId, number - 1, number, 1);
        if (row) syncBefore = historyCursor(snapshot.sessionId, state.historyId, 'older', { n: number, hash: row.prefixHash });
      }
    }
    return { snapshot, messages, before: syncBefore, snapshotStream, projections };
  }
  const session = partner.historySession(), store = partner.historyStore;
  const sameScope = () => partner.historyStore === store && partner.historySession() === session;
  let history = histories.get(store);
  if (history?.session !== partner.historySession()) history = undefined;
  if (!history) {
    const manager: HistoryManager = { session, ready: Promise.resolve(), listeners: new Set(), repair: async () => {}, project: async (turnIds, messageIds) => (await page(turnIds, messageIds)).projections };
    const entries = (values: readonly HistoryProjection[]): HistoryIndexInput[] => values.map(value => ({ messageId: value.record.message.id, turnId: value.record.message.turnId, stable: value.stable }));
    const rebuild = async () => {
      await partner.historyFence();
      if (!sameScope()) throw new Error('History session changed');
      const all: HistoryIndexInput[] = [];
      for (const turnId of partner.historyTurns()) all.push(...entries(await manager.project([turnId])));
      if (!sameScope()) throw new Error('History session changed');
      manager.state = await store.reconcileHistoryIndex(session, all);
    };
    manager.ready = rebuild();
    manager.repair = () => {
      manager.ready = manager.ready.catch(() => {}).then(async () => { await rebuild(); for (const listener of manager.listeners) listener(); });
      return manager.ready;
    };
    partner.subscribeHistory(turnId => {
      let repair = false;
      manager.ready = manager.ready.catch(() => { repair = true; }).then(async () => {
        if (repair || !manager.state) { await rebuild(); for (const listener of manager.listeners) listener(); return; }
        await partner.historyFence();
        if (!sameScope()) throw new Error('History session changed');
        const next = entries(await manager.project([turnId]));
        if (!sameScope()) throw new Error('History session changed');
        if (!next.length) return;
        if ((await Promise.all(next.map(item => store.historyIndexPosition(session, item.messageId)))).some(Boolean)) {
          await rebuild();
          for (const listener of manager.listeners) listener();
          return;
        }
        manager.state = await store.appendHistoryIndex(session, manager.state!, next);
        for (const listener of manager.listeners) listener();
      });
      void manager.ready.catch(() => {});
    });
    void manager.ready.then(() => { for (const listener of manager.listeners) listener(); }, () => {});
    histories.set(store, manager); history = manager;
  }
  const historyManager = history;
  async function consistentPage<T>(project: (p: Awaited<ReturnType<typeof page>>, streamingReply: ReturnType<Partner['streamingReply']>) => T): Promise<T> {
    let p = await page();
    let streamingReply = partner.streamingReply();
    const streamChanged = () => p.snapshotStream?.id !== streamingReply?.id
      || p.snapshotStream?.turnId !== streamingReply?.turnId;
    const staleStream = () => p.messages.some(message => message.textState === 'streaming'
      && (!streamingReply || streamingReply.id !== message.id || streamingReply.turnId !== message.turnId));
    // Retry only when the stream's identity changes, not when its text grows.
    for (let attempt = 0; attempt < 2 && (streamChanged() || staleStream()); attempt++) {
      p = await page();
      streamingReply = partner.streamingReply();
    }
    if (streamChanged() || staleStream()) throw new Error('Chat projection changed during read');
    p.messages = p.messages.map(message => message.textState === 'streaming'
      ? { ...message, text: streamingReply!.text } : message);
    return project(p, streamingReply);
  }
  async function readView(): Promise<ChatView> {
    const images = await partner.sharedImageLimits();
    const files = await partner.sharedFileLimits();
    return consistentPage((p, streamingReply) => {
      const completion = partner.replyCompletion();
      const replyCompletedTurnId = completion && p.snapshot.cancellable[0] === completion.turnId
        && p.messages.some(m => m.role === 'agent' && m.turnId === completion.turnId && m.id === completion.itemId && m.text === completion.text)
        ? completion.turnId : undefined;
      return { version: 2, sessionId: p.snapshot.sessionId, name: p.snapshot.name,
        activeTurnId: p.snapshot.cancellable[0] ?? null,
        ...(replyCompletedTurnId ? { replyCompletedTurnId } : {}),
        ...(streamingReply && !replyCompletedTurnId && !p.messages.some(m => m.id === streamingReply.id) ? { streamingReply } : {}),
        contextUsage: { tokens: p.snapshot.context?.activeTokens ?? null, capacity: p.snapshot.context?.windowTokens ?? null },
        compaction: p.snapshot.lifecycle.latest ? { id: p.snapshot.lifecycle.latest.nativeId ?? null, status: p.snapshot.lifecycle.latest.status } : null,
        messages: p.messages, before: p.before, capabilities: { ...capabilities, images, files, workspaceImages: true } };
    });
  }
  function overlay(view: ChatView): ChatView {
    return { ...view, messages: view.messages.map(message => {
      const value = latest.get(message.id);
      return value && !Object.hasOwn(message, 'ui') && message.turnId === value.turnId && !(value.textState === 'streaming' && message.textState === 'complete')
        ? { ...message, text: value.text, textState: value.textState } : message;
    }) };
  }
  function refresh() {
    dirty = true;
    if (running || !current || closed) return;
    running = true;
    void (async () => {
      try {
        while (dirty && !closed) {
          dirty = false;
          waitingChanged = false;
          const next = overlay(await readView());
          if (closed) return;
          current = next;
          if (waitingReply && next.messages.some(message => message.id === waitingReply)) waitingReply = undefined;
          changed?.({ type: 'update', scope, window: { messages: next.messages, before: next.before }, state: {
            activeTurnId: next.activeTurnId, name: next.name, capabilities: next.capabilities,
            contextUsage: next.contextUsage, compaction: next.compaction,
            streamingReply: next.streamingReply ?? null, replyCompletedTurnId: next.replyCompletedTurnId ?? null,
          } });
          const ids = new Set(next.messages.map(message => message.id));
          for (const id of latest.keys()) if (!ids.has(id) && id !== partner.streamingReply()?.id) latest.delete(id);
        }
      } catch (error) {
        // Retry once only when this failed read overlapped a newer source update.
        if (waitingChanged) dirty = true;
        waitingChanged = false;
        // A later update for the same source must be able to retry its position.
        waitingReply = undefined;
        if (!closed) changed?.({ type: 'error', error });
      } finally { running = false; if (dirty && !closed) refresh(); }
    })();
  }
  function replyUpdate(id: string, turnId: string, text: string, textState: 'streaming' | 'complete') {
    if (textState === 'streaming' && !text.trim()) return;
    latest.set(id, { turnId, text, textState });
    const message = current?.messages.find(value => value.id === id && value.turnId === turnId && !Object.hasOwn(value, 'ui'));
    if (!current || !message) {
      if (waitingReply !== id) { waitingReply = id; refresh(); }
      else if (running) waitingChanged = true;
      return;
    }
    const next = { ...message, text, textState };
    const completion = textState === 'complete' ? partner.replyCompletion() : undefined;
    const completedTurn = completion?.itemId === id && completion.turnId === turnId && current.activeTurnId === turnId ? turnId : undefined;
    const clearPreview = textState === 'complete' && current.streamingReply?.id === id && current.streamingReply.turnId === turnId;
    current = { ...current, messages: current.messages.map(value => value === message ? next : value),
      ...(completedTurn ? { replyCompletedTurnId: completedTurn } : {}), ...(clearPreview ? { streamingReply: undefined } : {}) };
    changed?.({ type: 'update', scope, messages: [{ type: 'upsert', message: next }],
      ...(completedTurn || clearPreview ? { state: { ...(completedTurn ? { replyCompletedTurnId: completedTurn } : {}), ...(clearPreview ? { streamingReply: null } : {}) } } : {}) });
  }
  function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Chat read cancelled')); };
      if (signal.aborted) { void work.catch(() => {}); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  return {
    async search({ query }) {
      if (!conversationSearch) throw new Error('Search unavailable');
      const result = await conversationSearch.search(query);
      return { hits: result.hits.map(({ cwd: _cwd, ...hit }) => hit), estimatedTotalHits: result.estimatedTotalHits,
        limited: result.estimatedTotalHits > result.hits.length };
    },
    async searchRead({ id }) {
      if (!conversationSearch) throw new Error('Search unavailable');
      const { record: { cwd: _cwd, ...record }, context } = await conversationSearch.read(id);
      return { record, context: { targetSourceRecordIndex: context.targetSourceRecordIndex, truncated: context.truncated,
        items: context.items } };
    },
    async read(signal): Promise<ChatView> {
      if (signal?.aborted || closed) throw new Error('Chat read cancelled');
      const view = overlay(await abortable(readView(), signal));
      if (signal?.aborted || closed) throw new Error('Chat read cancelled');
      current = view;
      if (dirty) queueMicrotask(refresh);
      return view;
    },
    async historySync(input) {
      if (input.sessionId !== session || !sameScope()) throw new Error('Wrong session');
      await historyManager.ready;
      if (!sameScope()) throw new Error('History session changed');
      const source = {
        state: session => store.historyIndexState(session),
        entries: (session, after, through, limit, descending) => store.historyIndexEntries(session, after, through, limit, descending),
        async project(rows) {
          const turns = [...new Set(rows.flatMap(row => row.turnId ? [row.turnId] : []))];
          const projected = await historyManager.project(turns, new Set(rows.map(row => row.messageId)));
          const byId = new Map(projected.map(value => [value.record.message.id, value]));
          return rows.map(row => { const value = byId.get(row.messageId); if (!value) throw new HistoryProjectionMismatch('Indexed history message is unavailable'); return value; });
        },
      } satisfies import('./history-sync.ts').HistorySyncSource;
      let result: HistorySyncResult;
      try { result = await readHistorySync(source, input); }
      catch (error) {
        if (!(error instanceof HistoryProjectionMismatch)) throw error;
        if (!sameScope()) throw new Error('History session changed');
        await historyManager.repair();
        result = input.kind === 'start' ? await readHistorySync(source, input) : { kind: 'resyncRequired', sessionId: input.sessionId };
      }
      if (!sameScope()) throw new Error('History session changed');
      return result;
    },
    compact: input => partner.compact({ ...input, authorize }),
    async submit(input) {
      const receipt = await partner.submitNativeDelivery(input, authorize, authorizeCommit);
      if (!receipt) throw new Error('Delivery outcome is unknown');
      return receipt;
    },
    lookup: id => partner.lookupNativeDelivery(id, authorize, authorizeCommit),
    async stop(id) { if (authorizeCommit && !authorizeCommit()) throw new Error('Unauthorized'); return partner.chatStop(id); },
    async relationship() { return partner.relationship(); },
    async relationshipHistory(input) {
      const { scope, records } = await partner.relationshipRecords();
      const position = cursors.decode('relationshipHistory', input.sessionId, input.cursor);
      const end = position === undefined ? records.length : Number(position);
      if (!Number.isSafeInteger(end) || end < 0 || end > records.length) throw new Error('Invalid cursor');
      const start = Math.max(0, end - 20);
      return { scope, records: records.slice(start, end).reverse(), predecessor: records[start - 1] ?? null,
        nextCursor: start > 0 ? cursors.encode('relationshipHistory', input.sessionId, String(start)) : null };
    },
    async diaryList(input) {
      const after = cursors.decode('diaryList', input.sessionId, input.cursor);
      const entries = (await partner.diary()).filter(name => after === undefined || name < after);
      const page = entries.slice(0, 30);
      return { entries: page, nextCursor: entries.length > page.length ? cursors.encode('diaryList', input.sessionId, page.at(-1)!) : null };
    },
    async diaryRead(input) { return partner.readDiary(input.name); },
    async album(input) {
      const cursor = cursors.decode('album', input.sessionId, input.cursor);
      const page = await partner.sharedAlbum({ limit: 30, cursor });
      return { images: page.images.map(image => ({ id: image.id, filename: image.filename, createdAt: image.created, origin: image.origin,
        available: image.available, previewUrl: image.available ? albumImageThumbnailUrl(image.catalogueId) : null, originalUrl: image.available ? (image.id === image.catalogueId ? `/api/conversation-images/${image.catalogueId}` : mediaUrl(image.id)) : null })),
        nextCursor: page.nextCursor ? cursors.encode('album', input.sessionId, page.nextCursor) : null };
    },
    async reminders() {
      return { reminders: partner.alarms().map(alarm => ({ id: alarm.id, message: alarm.message, nextAt: alarm.nextAt,
        schedule: alarm.schedule.kind === 'once' ? { kind: 'once' as const, at: Date.parse(alarm.schedule.at) }
          : alarm.schedule.kind === 'interval' ? { kind: 'interval' as const, everySeconds: alarm.schedule.everyMinutes * 60, anchor: alarm.createdAt }
          : alarm.schedule })) };
    },
    subscribe(listener) {
      changed = listener;
      const off = partner.subscribeChat(observation => {
        if (closed) return;
        if (observation.type === 'delivery') { changed?.({ type: 'deliveryResult', scope, receipt: observation.receipt }); return; }
        if (observation.type === 'delta') replyUpdate(observation.reply.id, observation.reply.turnId, observation.reply.text, 'streaming');
        else if (observation.type === 'completed') replyUpdate(observation.id, observation.turnId, observation.text, 'complete');
        else if (observation.type === 'change') refresh();
      });
      historyManager.listeners.add(refresh);
      return { scope, close() { closed = true; changed = undefined; off(); historyManager.listeners.delete(refresh); } };
    },
  };
}

function keetDisplayLabel(value: string | undefined, fallback: string): string {
  return value?.replace(/[\r\n\u2028\u2029]/g, ' ').trim() || fallback;
}
export function createChatSocket(partner: Partner, authorize: (request: import('node:http').IncomingMessage) => Promise<boolean> = async () => true, conversationSearch?: ConversationSearch, authorizeCommit?: (request: import('node:http').IncomingMessage) => boolean) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const hosts = new Set<Awaited<ReturnType<typeof createChatHost>>>();
  sockets.on('connection', (ws, request) => {
    let channel: Awaited<ReturnType<typeof createChatHost>>['connect'] extends (...args: never[]) => infer R ? R : never;
    let closed = false;
    const initialRead = new AbortController();
    const host = createChatHost(createCodexChatBackend(partner, async () => await authorize(request) && !closed && ws.readyState === ws.OPEN, conversationSearch, () => !closed && ws.readyState === ws.OPEN && (authorizeCommit?.(request) ?? true)), undefined, { signal: initialRead.signal });
    void host.then(h => { if (closed) h.close(); else hosts.add(h); }).catch(() => ws.close(1011, 'Chat unavailable'));
    ws.on('close', () => { closed = true; initialRead.abort(); channel?.close(); void host.then(h => { h.close(); hosts.delete(h); }).catch(() => undefined); });
    // Register immediately; a browser may send subscription calls before host hydration completes.
    ws.on('message', (data, binary) => {
      if (binary) { ws.close(1003, 'Text frames required'); return; }
      void (async () => { const h = await host; if (closed) return; channel ??= h.connect(ws, () => authorize(request)); await channel.receive(data.toString()); })().catch(() => ws.close(1011, 'Chat unavailable'));
    });
  });
  return { sockets, close: async () => { for (const socket of sockets.clients) socket.close(1001, 'Server closing'); for (const host of hosts) host.close(); hosts.clear(); sockets.close(); } };
}
