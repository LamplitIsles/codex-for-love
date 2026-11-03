// Test-owned stdio MCP returning synthetic metadata; its URL is intercepted
// by fake-voice-fetch.mjs and never reaches the network.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-elevenlabs', version: '1' } };
  if (request.method === 'tools/list') result = { tools: ['creative_generate_speech', 'creative_get_flow_run_status'].map(name => ({ name, description: 'fixture', inputSchema: { type: 'object', properties: {} } })) };
  if (request.method === 'tools/call') {
    appendFileSync(process.env.CFL_FAKE_ELEVEN_LOG, `${JSON.stringify(request.params)}\n`);
    const value = request.params.name === 'creative_generate_speech'
      ? { flow_id: 'fake-flow', session_ids: ['fake-session'], results: [{ success: true, session_id: 'fake-session' }], summary: { generations_started: 1, failed: 0 }, pending: [{ generation_id: 'fake-generation', kind: 'audio' }], poll_after_seconds: 0 }
      : { flow_id: 'fake-flow', session_id: 'fake-session', session_ids: ['fake-session'], all_completed: true, has_failures: false, generations: [{ id: 'fake-generation', status: 'completed', modality: 'audio', model_id: 'eleven_v4', content_url: 'https://elevenlabsusercontent.com/synthetic-fixture' }] };
    result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
