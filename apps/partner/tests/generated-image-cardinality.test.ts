import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { createWebServer } from '../runtime/server.ts';
import { fixture } from './fixture.ts';

for (const [rounds, count] of [[1, 7], [1, 11], [31, 11]] as const) {
  test(`${count} native generated images survive ${rounds === 1 ? 'initial subscription' : 'older history'} and reconnect`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    let app: ReturnType<typeof createWebServer> | undefined;
    let client: Awaited<ReturnType<typeof openChat>> | undefined;
    let socket: WebSocket | undefined;
    try {
      const images: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const savedPath = join(f.directory, `native-output-${i}.png`);
        await sharp({ create: { width: 1, height: 1, channels: 4,
          background: { r: i * 20, g: 0, b: 0, alpha: 1 } } }).png().toFile(savedPath);
        images.push({ type: 'imageGeneration', id: `generated-${i}`, status: 'completed',
          revisedPrompt: 'synthetic native output', result: '', failure: null, savedPath });
      }
      const turns = Array.from({ length: rounds }, (_, i) => ({
        id: `history-turn-${i}`, status: 'completed', startedAt: 1700000000 + i,
        completedAt: 1700000000 + i, error: null, items: [
          { type: 'userMessage', id: `history-user-${i}`, clientId: `history-input-${i}`,
            content: [{ type: 'text', text: `human ${i}` }] },
          { type: 'agentMessage', id: `history-agent-${i}`, text: `partner ${i}`, phase: 'final_answer' },
          ...(i === 0 ? images : []),
        ],
      }));
      await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: rounds + 1, turns }));
      const partner = await f.createPartner();
      const native = (await partner.snapshot(rounds === 1 ? {} : { before: 2 })).results.find(result => result.turnId === 'history-turn-0')!;
      assert.equal(native.images.length, count, 'all successful artifacts are persisted before connecting');
      const expectedIds = native.images.map(image => image.id);
      app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      let view: ChatView | undefined;
      const connect = () => {
        socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket');
        return openChat(socket, value => { view = value; }, () => {});
      };
      for (let connection = 0; connection < 2; connection++) {
        client = await connect();
        assert.ok(view, 'initial subscription produces a view');
        const messages = [...view.messages];
        let before = view.before;
        while (before) {
          const page = await client.history(before);
          messages.unshift(...page.messages); before = page.before;
        }
        const reply = messages.find(message => message.id === 'history-agent-0')!;
        assert.equal(reply.text, 'partner 0');
        assert.deepEqual(reply.images?.map(image => image.attachmentId), expectedIds);
        assert.equal(messages.filter(message => message.id === reply.id).length, 1);
        const albumIds = [];
        let cursor: string | null = null;
        do {
          const album = await client.album({ sessionId: view.sessionId, cursor });
          albumIds.push(...album.images.map(image => image.id)); cursor = album.nextCursor;
        } while (cursor);
        assert.deepEqual(new Set(albumIds), new Set(expectedIds));
        client.close(); client = undefined; view = undefined;
      }
    } finally {
      client?.close(); socket?.close(); await app?.close(); await f.close();
    }
  });
}
