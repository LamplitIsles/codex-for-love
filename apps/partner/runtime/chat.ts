import { capabilities, PAGE_SIZE, type ChatMessage, type ChatView } from '@lamplit/contracts';
import { createChatHost, type ChatBackend } from '@lamplit/contracts/server';
import type { Partner } from './partner.ts';
import { WebSocketServer } from 'ws';

export function createCodexChatBackend(partner: Partner): ChatBackend {
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
      ordered.push({ order: m.sequence * 2, message: { id: m.id, role: 'user', text: m.input || '[媒体消息]', delivery, createdAt: m.created, operationId: m.id, turnId: m.turnId } });
    }
    for (const r of snapshot.results) {
      const source = snapshot.messages.find(m => m.id === r.sourceIds.at(-1));
      for (const [index, message] of r.completedMessages.entries()) ordered.push({ order: (source?.sequence ?? 0) * 2 + 1 + index / 1000, message: { id: message.id, role: 'agent', text: message.text, createdAt: r.completedAt ?? source?.created ?? 0, operationId: null, turnId: r.turnId } });
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(r.chatStatus)) ordered.push({ order: (source?.sequence ?? 0) * 2 + 1.9, message: { id: `${r.id}:status`, role: 'notice', text: r.chatStatus === 'completed' ? '回复完成' : r.chatStatus === 'failed' ? '回复失败' : '已停止回复', createdAt: r.completedAt ?? source?.created ?? 0, operationId: null, turnId: r.turnId } });
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
    async read(): Promise<ChatView> { const p = await page(); return { version: 1, sessionId: p.snapshot.sessionId, name: p.snapshot.name, activeTurnId: p.snapshot.cancellable[0] ?? null, messages: p.messages, before: p.before, capabilities }; },
    async history(before) { const p = await page(before); return { messages: p.messages, before: p.before }; },
    async submit(input) { await partner.submit(input.operationId, input.text); return partner.chatReceipt(input.operationId); },
    lookup: id => partner.chatReceipt(id),
    async stop(id) { return partner.chatStop(id); },
    subscribe: listener => partner.subscribe(listener),
  };
}
export function createChatSocket(partner: Partner) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  let host: ReturnType<typeof createChatHost> | undefined;
  sockets.on('connection', ws => {
    let channel: Awaited<ReturnType<typeof createChatHost>>['connect'] extends (...args: never[]) => infer R ? R : never;
    let closed = false;
    ws.on('close', () => { closed = true; channel?.close(); });
    // Register immediately; a browser may send subscription calls before host hydration completes.
    ws.on('message', (data, binary) => {
      if (binary) { ws.close(1003, 'Text frames required'); return; }
      void (async () => { const h = await (host ??= createChatHost(createCodexChatBackend(partner))); if (closed) return; channel ??= h.connect(ws, async () => true); await channel.receive(data.toString()); })().catch(() => ws.close(1011, 'Chat unavailable'));
    });
  });
  return { sockets, close: async () => { for (const socket of sockets.clients) socket.close(1001, 'Server closing'); if (host) (await host).close(); sockets.close(); } };
}
