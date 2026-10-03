import { capabilities, mediaUrl, PAGE_SIZE, type ImageRef, type ChatMessage, type ChatView } from '@lamplit/contracts';
import { createChatHost, type ChatBackend } from '@lamplit/contracts/server';
import { panelCursors } from './panel-cursor.ts';
import type { Partner } from './partner.ts';
import type { ConversationSearch } from './conversation-search.ts';
import { WebSocketServer } from 'ws';

export function createCodexChatBackend(partner: Partner, authorize: () => Promise<boolean> = async () => true, conversationSearch?: ConversationSearch): ChatBackend {
  const cursors = panelCursors();
  async function page(cursor?: string) {
    const options: { before?: number; anchor?: string } = cursor ? JSON.parse(cursor) : {};
    if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 0)) throw new Error('Invalid cursor');
    const snapshot = await partner.snapshot(options.before === undefined ? {} : { before: options.before });
    const receipts = new Map(await Promise.all(snapshot.messages.map(async m => [m.id, await partner.chatReceipt(m.id)] as const)));
    const ordered: Array<{ order: number; message: ChatMessage }> = [];
    for (const m of snapshot.messages) {
      if (m.delivery === 'replaced') continue;
      const state = receipts.get(m.id)!.state;
      const delivery = state === 'accepted' ? 'pending' : state === 'missing' ? 'uncertain' : state;
      const images = (await Promise.all(m.inputImages.map(image => partner.sharedImageRef(image.id)))).filter((ref): ref is ImageRef => !!ref);
      ordered.push({ order: m.sequence * 2, message: { id: m.id, role: 'user', text: m.input, ...(images.length ? { images } : {}), delivery, createdAt: m.created, operationId: m.id, turnId: m.turnId, ...(m.alarm ? { source: { kind: 'reminder' as const, reminderId: m.id.split(':')[1]!, occurrenceId: m.id } } : {}) } });
    }
    for (const r of snapshot.results) {
      const source = snapshot.messages.find(m => m.id === r.sourceIds.at(-1));
      const images = (await Promise.all(r.images.map(image => partner.sharedImageRef(image.id)))).filter((ref): ref is ImageRef => !!ref);
      const completed = r.completedMessages.length ? r.completedMessages : images.length ? [{ id: `${r.id}:images`, text: '' }] : [];
      for (const [index, message] of completed.entries()) ordered.push({ order: (source?.sequence ?? 0) * 2 + 1 + index / 1000, message: { id: message.id, role: 'agent', text: message.text, ...(index === completed.length - 1 && images.length ? { images } : {}), createdAt: r.completedAt ?? source?.created ?? 0, operationId: null, turnId: r.turnId } });
      if (['failed', 'interrupted', 'cancelled'].includes(r.chatStatus)) ordered.push({ order: (source?.sequence ?? 0) * 2 + 1.9, message: { id: `${r.id}:status`, role: 'notice', text: r.chatStatus === 'failed' ? '回复失败' : '已停止回复', createdAt: r.completedAt ?? source?.created ?? 0, operationId: null, turnId: r.turnId } });
    }
    ordered.sort((a,b) => a.order - b.order);
    const all = ordered.map(x => x.message);
    const end = options.anchor ? all.findIndex(m => m.id === options.anchor) : all.length;
    if (end < 0) throw new Error('Cursor no longer exists');
    const start = Math.max(0, end - PAGE_SIZE);
    const before = start > 0 ? JSON.stringify({ ...options, anchor: all[start]!.id }) : snapshot.hasMore && snapshot.before !== null ? JSON.stringify({ before: snapshot.before }) : null;
    return { snapshot, messages: all.slice(start, end), before };
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
        items: context.items.filter(item => item.kind !== 'tool').map(({ phase: _phase, kind, ...item }) => ({ ...item, kind: kind as 'message' | 'compaction' })) } };
    },
    async read(): Promise<ChatView> { const recovery = await partner.sharedRecovery(); const p = await page(); return { version: 1, sessionId: p.snapshot.sessionId, name: p.snapshot.name, activeTurnId: p.snapshot.cancellable[0] ?? null, contextUsage: { tokens: p.snapshot.context?.activeTokens ?? null, capacity: p.snapshot.context?.windowTokens ?? null }, compaction: p.snapshot.lifecycle.latest ? { id: p.snapshot.lifecycle.latest.nativeId ?? null, status: p.snapshot.lifecycle.latest.status } : null, messages: p.messages, before: p.before, capabilities: { ...capabilities, images: await partner.sharedImageLimits() }, recovery }; },
    async history(before) { const p = await page(before); return { messages: p.messages, before: p.before }; },
    compact: input => partner.compact({ ...input, authorize }),
    submit: input => partner.submitShared(input),
    lookup: id => partner.chatReceipt(id),
    async stop(id) { return partner.chatStop(id); },
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
    subscribe: listener => partner.subscribe(listener),
  };
}
export function createChatSocket(partner: Partner, authorize: (request: import('node:http').IncomingMessage) => Promise<boolean> = async () => true, conversationSearch?: ConversationSearch) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const hosts = new Set<Awaited<ReturnType<typeof createChatHost>>>();
  sockets.on('connection', (ws, request) => {
    let channel: Awaited<ReturnType<typeof createChatHost>>['connect'] extends (...args: never[]) => infer R ? R : never;
    let closed = false;
    const host = createChatHost(createCodexChatBackend(partner, async () => await authorize(request) && !closed && ws.readyState === ws.OPEN, conversationSearch));
    void host.then(h => { if (closed) h.close(); else hosts.add(h); }).catch(() => ws.close(1011, 'Chat unavailable'));
    ws.on('close', () => { closed = true; channel?.close(); void host.then(h => { h.close(); hosts.delete(h); }).catch(() => undefined); });
    // Register immediately; a browser may send subscription calls before host hydration completes.
    ws.on('message', (data, binary) => {
      if (binary) { ws.close(1003, 'Text frames required'); return; }
      void (async () => { const h = await host; if (closed) return; channel ??= h.connect(ws, () => authorize(request)); await channel.receive(data.toString()); })().catch(() => ws.close(1011, 'Chat unavailable'));
    });
  });
  return { sockets, close: async () => { for (const socket of sockets.clients) socket.close(1001, 'Server closing'); for (const host of hosts) host.close(); hosts.clear(); sockets.close(); } };
}
