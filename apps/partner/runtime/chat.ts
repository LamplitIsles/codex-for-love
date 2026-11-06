import { capabilities, mediaUrl, PAGE_SIZE, type ImageRef, type FileRef, type ChatMessage, type ChatView } from '@lamplit/contracts';
import { createChatHost, type ChatBackend, type ChatChange } from '@lamplit/contracts/server';
import { panelCursors } from './panel-cursor.ts';
import type { Partner } from './partner.ts';
import type { ConversationSearch } from './conversation-search.ts';
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';

export function createCodexChatBackend(partner: Partner, authorize: () => Promise<boolean> = async () => true, conversationSearch?: ConversationSearch, authorizeCommit?: () => boolean): ChatBackend {
  const cursors = panelCursors();
  const scope = Symbol('partner chat session');
  let changed: ((change: ChatChange) => void) | undefined;
  let current: ChatView | undefined;
  let dirty = false, running = false, closed = false;
  let waitingReply: string | undefined;
  let waitingChanged = false;
  const latest = new Map<string, { turnId: string; text: string; textState: 'streaming' | 'complete' }>();
  async function page(cursor?: string) {
    const options: { before?: number; anchor?: string } = cursor ? JSON.parse(cursor) : {};
    if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 0)) throw new Error('Invalid cursor');
    // Shared host refresh must read the current projection without waiting
    // for native history; known activity and durable receipts are independent.
    const snapshotStream = partner.streamingReply();
    const snapshot = await partner.snapshot(options.before === undefined ? {} : { before: options.before }, false);
    const receipts = new Map(await Promise.all(snapshot.messages.map(async m => [m.id, await partner.chatReceipt(m.id)] as const)));
    const ordered: Array<{ order: number; position?: number; message: ChatMessage; fileIds?: string[] }> = [];
    for (const m of snapshot.messages) {
      if (m.delivery === 'replaced' || receipts.get(m.id)?.state !== 'submitted') continue;
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
        : m.post ? m.post.source
        : m.alarm ? { kind: 'reminder', reminderId: m.id.split(':')[1]!, occurrenceId: m.id } : undefined;
      const owner = snapshot.results.find(result => result.sourceIds.includes(m.id));
      const slot = owner?.timeline.find(entry => entry.kind === 'user' && entry.sourceIds.includes(m.id));
      const position = slot ? slot.position + slot.sourceIds.indexOf(m.id) / (slot.sourceIds.length + 1) : undefined;
      ordered.push({ order: owner ? owner.anchorSequence * 2 : m.sequence * 2, ...(owner ? { position: position ?? -1 } : {}), fileIds: m.inputFiles, message: {
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
            ordered.push({ order, position: slot.position, message: { id: `image:${createHash('sha256').update(JSON.stringify([r.turnId, slot.itemId])).digest('hex')}`, role: 'agent', text: '', imageState,
              ...(imageState === 'ready' && image ? { images: [image] } : {}), createdAt, operationId: null, turnId: r.turnId } });
          } else if (slot.kind === 'ui' && Object.hasOwn(slot, 'ui')) {
            const message: ChatMessage & { ui: unknown } = { id: `ui:${createHash('sha256').update(JSON.stringify([r.turnId, slot.itemId])).digest('hex')}`, role: 'agent', text: '', ui: slot.ui, createdAt, operationId: null, turnId: r.turnId };
            ordered.push({ order, position: slot.position, message });
          } else if (slot.kind === 'voice' && slot.voiceId) {
            ordered.push({ order, position: slot.position, message: { id: `voice:${createHash('sha256').update(JSON.stringify([r.id, slot.itemId, slot.voiceId])).digest('hex')}`, role: 'agent', text: '', voice: { id: slot.voiceId }, createdAt, operationId: null, turnId: r.turnId } });
          }
        }
        if (['failed', 'interrupted', 'cancelled'].includes(r.chatStatus)) ordered.push({ order, position: Number.POSITIVE_INFINITY, message: { id: `${r.id}:status`, role: 'notice', text: r.chatStatus === 'failed' ? '回复失败' : '已停止回复', createdAt, operationId: null, turnId: r.turnId } });
    }
    ordered.sort((a,b) => a.order - b.order || (a.position ?? 0) - (b.position ?? 0));
    const all = ordered.map(x => x.message);
    const end = options.anchor ? all.findIndex(m => m.id === options.anchor) : all.length;
    if (end < 0) throw new Error('Cursor no longer exists');
    const start = Math.max(0, end - PAGE_SIZE);
    // An anchor belongs to this native window, not whichever window is latest
    // when the Human next requests history. Freeze its exclusive upper bound.
    const before = start > 0 ? JSON.stringify({ before: options.before ?? snapshot.messages.at(-1)!.sequence + 1, anchor: all[start]!.id }) : snapshot.hasMore && snapshot.before !== null ? JSON.stringify({ before: snapshot.before }) : null;
    // Check file bytes only for the messages actually returned on this page.
    // Do not retain results across reads: files can change or disappear.
    const messages: ChatMessage[] = [];
    for (const { message, fileIds } of ordered.slice(start, end)) {
      // Bound concurrent buffers to one message's files (at most six).
      const files = (await Promise.all((fileIds ?? []).map(id => partner.sharedFileRef(id)))).filter((ref): ref is FileRef => !!ref);
      messages.push(files.length ? { ...message, files } : message);
    }
    return { snapshot, messages, before, snapshotStream };
  }
  async function consistentPage<T>(cursor: string | undefined, project: (p: Awaited<ReturnType<typeof page>>, streamingReply: ReturnType<Partner['streamingReply']>) => T): Promise<T> {
    let p = await page(cursor);
    let streamingReply = partner.streamingReply();
    const streamChanged = () => p.snapshotStream?.id !== streamingReply?.id
      || p.snapshotStream?.turnId !== streamingReply?.turnId;
    const staleStream = () => p.messages.some(message => message.textState === 'streaming'
      && (!streamingReply || streamingReply.id !== message.id || streamingReply.turnId !== message.turnId));
    // Retry only when the stream's identity changes, not when its text grows.
    for (let attempt = 0; attempt < 2 && (streamChanged() || staleStream()); attempt++) {
      p = await page(cursor);
      streamingReply = partner.streamingReply();
    }
    if (streamChanged() || staleStream()) throw new Error('Chat projection changed during read');
    p.messages = p.messages.map(message => message.textState === 'streaming'
      ? { ...message, text: streamingReply!.text } : message);
    return project(p, streamingReply);
  }
  async function readView(): Promise<ChatView> {
    const recovery = await partner.sharedRecovery(false);
    const images = await partner.sharedImageLimits();
    const files = await partner.sharedFileLimits();
    return consistentPage(undefined, (p, streamingReply) => {
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
        messages: p.messages, before: p.before, capabilities: { ...capabilities, images, files, workspaceImages: true }, recovery };
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
            activeTurnId: next.activeTurnId, name: next.name, capabilities: next.capabilities, recovery: next.recovery,
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
    async history(before) { return consistentPage(before, p => ({ messages: p.messages, before: p.before })); },
    compact: input => partner.compact({ ...input, authorize }),
    submit: input => partner.submitShared(input, authorize, authorizeCommit),
    finalizeSubmission: input => partner.finalizeSubmission(input, authorize, authorizeCommit),
    retryFailed: input => partner.retryFailed(input, authorize, authorizeCommit),
    deleteFailed: input => partner.deleteFailed(input, authorize, authorizeCommit),
    lookup: id => partner.chatReceipt(id),
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
        available: image.available, previewUrl: image.available ? mediaUrl(image.id) : null, originalUrl: image.available ? mediaUrl(image.id) : null })),
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
        if (observation.type === 'delta') replyUpdate(observation.reply.id, observation.reply.turnId, observation.reply.text, 'streaming');
        else if (observation.type === 'completed') replyUpdate(observation.id, observation.turnId, observation.text, 'complete');
        else if (observation.type === 'change') refresh();
      });
      return { scope, close() { closed = true; changed = undefined; off(); } };
    },
  };
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
