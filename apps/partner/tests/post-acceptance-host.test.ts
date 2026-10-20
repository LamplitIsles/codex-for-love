import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView, PostSource } from '@lamplit/contracts';
import { postAcceptanceHost } from './post-acceptance-host.ts';
import { eventually } from './fixture.ts';

test('Post native browser history control puts the retained older source in one real public page', async () => {
  const host = await postAcceptanceHost(resolve(import.meta.dirname, '../build'));
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  let view: ChatView | undefined;
  const source: PostSource = { kind: 'post', platform: 'qq', conversationType: 'group', conversationId: 'owned-chat', conversationName: 'Owned group', senderId: 'owned-sender', senderDisplayName: 'Owned peer' };
  const incoming = (id: string, history = false) => host.action({ action: 'incoming', id, source, text: `${id} original`, createdAt: 1791320400000, history });
  try {
    await incoming('initial'); await incoming('older', true);
    client = await openChat(new WebSocket(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'post-test-owner=1' } }) as unknown as globalThis.WebSocket, value => { view = value; }, () => {});
    for (let n = 0; n < 7; n++) await incoming(`later-${n}`);
    await client.submit({ operationId: crypto.randomUUID(), text: 'owned ordinary web input' });
    await host.action({ action: 'complete' }); await host.action({ action: 'reminder' }); await incoming('reconnect');
    await eventually(async () => !!view?.messages.some(m => m.text === 'reconnect original') && !!view?.before);
    assert(!view!.messages.some(m => m.text === 'older original'), 'older source is actually outside the live public page');
    const page = await client.history(view!.before!);
    const next = page.before ? await client.history(page.before) : undefined;
    assert(page.messages.some(m => m.text === 'older original' && m.source?.kind === 'post'), JSON.stringify({ firstPostSources: page.messages.filter(m => m.source?.kind === 'post').length, nextHasOlder: next?.messages.some(m => m.text === 'older original' && m.source?.kind === 'post') }));
  } finally { client?.close(); await host.close(); }
});
