import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  VOICE_SAMPLE_RATE, MAX_VOICE_DURATION_MS, MAX_VOICE_FRAME_BYTES,
  MAX_VOICE_EVENT_BYTES, MAX_VOICE_QUEUE_BYTES, VOICE_TRANSCRIPT_MAX_CHARS,
  parseVoiceControl, validateVoiceFrameBytes, validateVoiceServerEvent,
  type VoiceServerEvent, type VoiceErrorCode,
} from '@lamplit/contracts/voice';

// DashScope streaming address is independent of the existing batch HTTP endpoint.
export const VOICE_PROVIDER_URL = 'https://dashscope.aliyuncs.com/api-ws/v1/inference';
export const VOICE_MODEL = 'qwen-audio-3.1-asr-flash-streaming';
export type VoiceDependencies = {
  connect?: (key: string) => WebSocket;
  timeouts?: { setup: number; lifetime: number; finish: number };
  /** Test-owned transport observation; never replaces native admission or relay. */
  observe?: (client: WebSocket) => void;
};
function validKey(key: string | null): key is string {
  return !!key && key === key.trim() && key.length <= 512 && !/[\x00-\x1f\x7f]/u.test(key);
}

/** Node adaptation of Lamplit's bounded final-only Qwen relay. */
export function createVoiceHost(credential: () => string | null, dependencies: VoiceDependencies = {}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_VOICE_FRAME_BYTES });
  const sessions = new Set<() => void>();
  const timeouts = dependencies.timeouts ?? { setup: 15_000, lifetime: MAX_VOICE_DURATION_MS + 20_000, finish: 20_000 };
  const connect = dependencies.connect ?? (key => new WebSocket(VOICE_PROVIDER_URL, {
    headers: { Authorization: `Bearer ${key}` }, maxPayload: MAX_VOICE_EVENT_BYTES,
    handshakeTimeout: timeouts.setup, followRedirects: false,
  }));
  const available = () => validKey(credential());
  sockets.on('connection', client => {
    dependencies.observe?.(client);
    const taskId = randomUUID();
    let upstream: WebSocket | undefined;
    let terminal = false, ready = false, finishing = false, bytes = 0, chars = 0;
    const sentences = new Map<number, string>();
    const unfinished = new Set<number>();
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    // Explicit listeners are removed at the terminal boundary, including shutdown.
    const end = (message?: VoiceServerEvent) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(setupTimer); clearTimeout(lifetimeTimer); clearTimeout(finishTimer);
      client.off('message', clientMessage); client.off('close', disconnected); client.off('error', disconnected);
      if (upstream) {
        upstream.off('open', opened); upstream.off('message', providerMessage);
        upstream.off('close', providerClosed); upstream.off('error', providerClosed);
        upstream.off('unexpected-response', rejected);
        // terminate a pending handshake as well as an established provider connection.
        upstream.on('error', () => {}); upstream.terminate();
      }
      client.on('error', () => {});
      if (client.readyState === WebSocket.OPEN && message) client.send(JSON.stringify(message), () => client.terminate());
      else client.terminate();
      sentences.clear(); unfinished.clear(); sessions.delete(shutdown);
    };
    const fail = (code: VoiceErrorCode = 'upstream_error') => end({ type: 'error', code });
    const shutdown = () => end();
    const disconnected = () => end();
    const providerClosed = () => fail();
    const sendProvider = (data: string | Buffer, binary = false) => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount + Buffer.byteLength(data) > MAX_VOICE_QUEUE_BYTES) return fail();
      upstream.send(data, { binary }, error => { if (error) fail(); });
    };
    function clientMessage(data: RawData, binary: boolean) {
      if (terminal) return;
      try {
        if (!binary) {
          const command = parseVoiceControl(data.toString());
          if (command.type === 'cancel') return fail('cancelled');
          if (!ready || finishing || !bytes) return fail('invalid_audio');
          finishing = true;
          finishTimer = setTimeout(() => fail('timeout'), timeouts.finish);
          sendProvider(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
        } else {
          if (!ready || finishing) return fail('invalid_audio');
          const frame = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
          bytes = validateVoiceFrameBytes(frame.byteLength, bytes);
          sendProvider(frame, true);
        }
      } catch { fail('invalid_audio'); }
    }
    function providerMessage(raw: RawData, binary: boolean) {
      if (terminal) return;
      try {
        if (binary || Buffer.byteLength(raw.toString()) > MAX_VOICE_EVENT_BYTES) return fail('transcript_invalid');
        const data = JSON.parse(raw.toString());
        if (data?.header?.task_id !== taskId || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return fail('transcript_invalid');
        switch (data.header.event) {
          case 'task-started':
            if (ready) return fail('transcript_invalid');
            ready = true; clearTimeout(setupTimer);
            lifetimeTimer = setTimeout(() => fail('timeout'), timeouts.lifetime);
            client.send(JSON.stringify({ type: 'ready' })); break;
          case 'result-generated': {
            if (!ready) return fail('transcript_invalid');
            const sentence = data.payload.output?.sentence;
            if (!sentence || typeof sentence !== 'object') return fail('transcript_invalid');
            if (sentence.heartbeat === true) return;
            if (typeof sentence.sentence_end !== 'boolean' || !Number.isSafeInteger(sentence.sentence_id) || sentence.sentence_id < 1 || typeof sentence.text !== 'string') return fail('transcript_invalid');
            if (!sentence.sentence_end) {
              if (!sentences.has(sentence.sentence_id)) unfinished.add(sentence.sentence_id);
              if (unfinished.size > VOICE_TRANSCRIPT_MAX_CHARS) return fail('transcript_invalid');
              return;
            }
            unfinished.delete(sentence.sentence_id);
            // Empty final segments carry no transcript; wait for usable speech or Finish.
            if (!sentence.text.trim()) return;
            chars += Array.from(sentence.text).length - Array.from(sentences.get(sentence.sentence_id) ?? '').length;
            if (chars > VOICE_TRANSCRIPT_MAX_CHARS) return fail('transcript_invalid');
            sentences.set(sentence.sentence_id, sentence.text); break;
          }
          case 'task-finished':
            if (!ready || !finishing || !sentences.size || unfinished.size) return fail('transcript_invalid');
            end(validateVoiceServerEvent({ type: 'result', text: [...sentences].sort(([a], [b]) => a - b).map(([, text]) => text).join('').trim() })); break;
          case 'task-failed': fail(); break;
          default: fail('transcript_invalid');
        }
      } catch { fail('transcript_invalid'); }
    }
    function opened() {
      sendProvider(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model: VOICE_MODEL,
        parameters: { format: 'pcm', sample_rate: VOICE_SAMPLE_RATE, semantic_punctuation_enabled: false, max_sentence_silence: 400 }, input: {},
      } }));
    }
    const rejected = (_request: import('node:http').ClientRequest, response: import('node:http').IncomingMessage) => {
      response.resume();
      fail(response.statusCode === 401 || response.statusCode === 403 ? 'invalid_key' : response.statusCode === 429 ? 'rate_limited' : 'upstream_error');
    };
    client.on('message', clientMessage); client.on('close', disconnected); client.on('error', disconnected);
    sessions.add(shutdown);
    setupTimer = setTimeout(() => fail('timeout'), timeouts.setup);
    try {
      const key = credential();
      if (!validKey(key)) { fail('voice_disabled'); return; }
      upstream = connect(key);
      upstream.on('open', opened); upstream.on('message', providerMessage);
      upstream.on('close', providerClosed); upstream.on('error', providerClosed);
      upstream.on('unexpected-response', rejected);
    } catch { fail(); }
  });
  return { sockets, available, close() { for (const stop of sessions) stop(); sockets.close(); } };
}
