import type { ServerNotificationEnvelope as ServerNotification } from "./generated/protocol/ServerNotificationEnvelope";
import type { JsonRpcNotification } from "./types";

const MAX_PENDING_TURNS = 128;
const MAX_PENDING_EVENTS_PER_TURN = 2_000;

export class TurnEventStream implements AsyncIterableIterator<ServerNotification> {
  private onDispose: (() => void) | null;
  private readonly values: ServerNotification[] = [];
  private readonly waiters: Array<{
    reject: (error: Error) => void;
    resolve: (result: IteratorResult<ServerNotification>) => void;
  }> = [];
  private done = false;
  private failure: Error | null = null;

  constructor(onDispose: () => void) {
    this.onDispose = onDispose;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ServerNotification> {
    return this;
  }

  next(): Promise<IteratorResult<ServerNotification>> {
    if (this.failure) return Promise.reject(this.failure);
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ reject, resolve }));
  }

  return(): Promise<IteratorResult<ServerNotification>> {
    this.complete();
    this.values.length = 0;
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: ServerNotification): void {
    if (this.done || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  /** Internal replay view: a joining handle must not steal another handle's unread events. */
  unread(): readonly ServerNotification[] {
    return this.values;
  }

  complete(): void {
    if (this.done || this.failure) return;
    this.done = true;
    this.dispose();
    if (this.values.length === 0) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }

  fail(error: Error): void {
    if (this.done || this.failure) return;
    this.failure = error;
    this.values.length = 0;
    this.dispose();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private dispose(): void {
    const callback = this.onDispose;
    this.onDispose = null;
    callback?.();
  }
}

interface TurnState {
  threadId: string;
  streams: Set<TurnEventStream>;
  early: ServerNotification[];
  items: Map<string, ServerNotification>;
  usage?: ServerNotification;
  terminal?: ServerNotification;
  subscribed: boolean;
  sequence: WeakMap<ServerNotification, number>;
  nextSequence: number;
}

export class TurnEventRouter {
  private readonly states = new Map<string, TurnState>();
  private readonly starts = new Map<string, Set<object>>();

  reserveStart(threadId: string): () => void {
    const token = {};
    const reservations = this.starts.get(threadId) ?? new Set<object>();
    reservations.add(token);
    this.starts.set(threadId, reservations);
    return () => {
      // An old connection's finally must not release a new connection's reservation.
      if (this.starts.get(threadId) !== reservations || !reservations.delete(token)) return;
      if (reservations.size) return;
      this.starts.delete(threadId);
      for (const [key, state] of this.states) {
        if (state.threadId !== threadId) continue;
        state.early.length = 0;
        if (!state.subscribed || (state.terminal && !state.streams.size)) this.discard(key, state);
      }
    };
  }

  open(turnId: string, threadId: string): TurnEventStream {
    const key = JSON.stringify([threadId, turnId]);
    const state = this.state(key, threadId);
    // Keep semantic snapshots and unread/transient events in original order, without duplicates.
    const replay = new Set<ServerNotification>(state.early);
    for (const event of state.items.values()) replay.add(event);
    if (state.usage) replay.add(state.usage);
    if (state.terminal) replay.add(state.terminal);
    for (const subscriber of state.streams) for (const event of subscriber.unread()) replay.add(event);
    const stream = new TurnEventStream(() => {
      state.streams.delete(stream);
      if (state.terminal && !state.streams.size && !this.pendingStart(state)) this.discard(key, state);
    });
    state.subscribed = true;
    state.streams.add(stream);
    for (const notification of [...replay].sort((a, b) => state.sequence.get(a)! - state.sequence.get(b)!)) {
      stream.push(notification);
      if (isCompletion(notification, turnId)) stream.complete();
    }
    if (!this.pendingStart(state)) state.early.length = 0;
    return stream;
  }

  route(notification: JsonRpcNotification): void {
    const turnId = notificationTurnId(notification);
    if (!turnId) return;
    const typed = notification as ServerNotification;
    const params = notification.params;
    const threadId = isRecord(params) && typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    // Forks can replay the same historical turn ID under a different thread.
    const key = JSON.stringify([threadId, turnId]);
    const state = this.state(key, threadId);
    state.sequence.set(typed, state.nextSequence++);
    if (typed.method === "item/completed") state.items.set(typed.params.item.id, typed);
    if (typed.method === "thread/tokenUsage/updated") state.usage = typed;
    if (isCompletion(typed, turnId)) state.terminal = typed;

    if (!state.subscribed || this.pendingStart(state)) {
      state.early.push(typed);
      if (state.early.length > MAX_PENDING_EVENTS_PER_TURN) state.early.shift();
    }
    for (const stream of [...state.streams]) {
      stream.push(typed);
      if (state.terminal) stream.complete();
    }
    if (state.subscribed && state.terminal && !state.streams.size && !this.pendingStart(state)) {
      this.discard(key, state);
    }
    this.trimUnclaimed();
  }

  failAll(error: Error): void {
    this.starts.clear();
    for (const [key, state] of this.states) {
      for (const stream of [...state.streams]) stream.fail(error);
      this.discard(key, state);
    }
  }

  clear(): void {
    this.starts.clear();
    for (const [key, state] of this.states) {
      for (const stream of [...state.streams]) stream.complete();
      this.discard(key, state);
    }
  }

  private state(key: string, threadId: string): TurnState {
    let state = this.states.get(key);
    if (!state) {
      state = { threadId, streams: new Set(), early: [], items: new Map(), subscribed: false,
        sequence: new WeakMap(), nextSequence: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private pendingStart(state: TurnState): boolean {
    return this.starts.has(state.threadId);
  }

  private discard(key: string, state: TurnState): void {
    if (this.states.get(key) === state) this.states.delete(key);
    state.early.length = 0;
    state.items.clear();
    state.usage = undefined;
    state.terminal = undefined;
  }

  private trimUnclaimed(): void {
    const unclaimed = [...this.states].filter(([, state]) => !state.subscribed && !this.pendingStart(state));
    for (const [key, state] of unclaimed.slice(0, -MAX_PENDING_TURNS)) this.discard(key, state);
    // Unsolicited histories remain bounded; in-flight starts and owned turns retain complete results.
    for (const [, state] of unclaimed.slice(-MAX_PENDING_TURNS)) {
      while (state.items.size > MAX_PENDING_EVENTS_PER_TURN) state.items.delete(state.items.keys().next().value!);
    }
  }
}

function notificationTurnId(notification: JsonRpcNotification): string | null {
  const params = notification.params;
  if (!isRecord(params)) return null;
  if (typeof params.turnId === "string") return params.turnId;
  if (isRecord(params.turn) && typeof params.turn.id === "string") return params.turn.id;
  return null;
}

function isCompletion(notification: ServerNotification, turnId: string): boolean {
  return (
    notification.method === "turn/completed" && notification.params.turn.id === turnId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
