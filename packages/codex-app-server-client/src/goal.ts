import {
  AppServerConnectionClosedError,
  AppServerRequestAbortedError,
  AppServerRequestTimeoutError,
} from "./errors";
import type { ServerNotificationEnvelope as ServerNotification } from "./generated/protocol/ServerNotificationEnvelope";
import type { ThreadGoalStatus } from "./generated/protocol/v2/ThreadGoalStatus";
import type { Turn } from "./generated/protocol/v2/Turn";
import type { RequestOptions } from "./types";
import { collectTurnResult, type CodexTurnResult } from "./thread";
import { TurnEventStream } from "./turn-event-router";

export const DEFAULT_GOAL_START_TIMEOUT_MS = 30_000;

export interface GoalStartOptions {
  startTimeoutMs?: number;
  tokenBudget?: number | null;
}

const TERMINAL_GOAL_STATUSES = new Set<ThreadGoalStatus>([
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export class CodexGoal {
  readonly id: string;
  readonly objective: string;
  readonly threadId: string;
  private readonly pauseOperation: (options: RequestOptions) => Promise<void>;
  private readonly stream: AsyncIterableIterator<ServerNotification>;
  private consumed = false;
  private pausePromise: Promise<void> | null = null;

  constructor(
    logicalTurnId: string,
    threadId: string,
    objective: string,
    stream: AsyncIterableIterator<ServerNotification>,
    pauseOperation: (options: RequestOptions) => Promise<void>,
  ) {
    this.id = logicalTurnId;
    this.threadId = threadId;
    this.objective = objective;
    this.stream = stream;
    this.pauseOperation = pauseOperation;
  }

  events(): AsyncIterableIterator<ServerNotification> {
    if (this.consumed) {
      throw new Error(`Goal ${this.id} event stream can only be consumed once.`);
    }
    this.consumed = true;
    return this.stream;
  }

  result(): Promise<CodexTurnResult> {
    return collectTurnResult(this.events(), this.id);
  }

  pause(options: RequestOptions = {}): Promise<void> {
    if (this.pausePromise) return this.pausePromise;
    const pending = this.pauseOperation(options).catch((error: unknown) => {
      if (this.pausePromise === pending) this.pausePromise = null;
      throw error;
    });
    this.pausePromise = pending;
    return pending;
  }
}

export class GoalEventRouter {
  private readonly active = new Map<string, GoalOperationState>();

  has(threadId: string): boolean {
    return this.active.has(threadId);
  }

  reserve(threadId: string): GoalOperationState {
    if (this.active.has(threadId)) {
      throw new Error(`Thread ${threadId} already has an active goal operation.`);
    }
    const state = new GoalOperationState(threadId);
    this.active.set(threadId, state);
    return state;
  }

  release(state: GoalOperationState): void {
    if (this.active.get(state.threadId) === state) this.active.delete(state.threadId);
  }

  route(notification: ServerNotification): boolean {
    const threadId = notificationThreadId(notification);
    if (!threadId) return false;
    const state = this.active.get(threadId);
    if (!state) return false;
    const consumed = state.observe(notification);
    if (state.finished) this.release(state);
    return consumed;
  }

  failAll(error: Error = new AppServerConnectionClosedError()): void {
    for (const state of this.active.values()) state.fail(error);
    this.active.clear();
  }
}

export class GoalOperationState {
  readonly threadId: string;
  readonly stream = new TurnEventStream(() => undefined);
  currentTurnId: string | null = null;
  finished = false;
  private logicalTurnId: string | null = null;
  private firstStartedTurn: Turn | null = null;
  private lastCompletedNotification: Extract<
    ServerNotification,
    { method: "turn/completed" }
  > | null = null;
  private failedCompletion: Extract<ServerNotification, { method: "turn/completed" }> | null = null;
  private goalStatus: ThreadGoalStatus | null = null;
  private cleared = false;
  private physicalTurnActive = false;
  private turnRoutingActive = false;
  private explicitlyInterrupted = false;
  private readonly started: Promise<string>;
  private resolveStarted!: (turnId: string) => void;
  private rejectStarted!: (error: Error) => void;

  constructor(threadId: string) {
    this.threadId = threadId;
    this.started = new Promise<string>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    void this.started.catch(() => undefined);
  }

  activateTurnRouting(): void {
    this.turnRoutingActive = true;
  }

  async waitForStart(options: Pick<RequestOptions, "signal" | "timeoutMs">): Promise<string> {
    if (this.logicalTurnId) return this.logicalTurnId;
    validateWaitOptions(options);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", handleAbort);
        operation();
      };
      const handleAbort = () =>
        finish(() =>
          reject(
            new AppServerRequestAbortedError(
              `thread goal start (${this.threadId})`,
              options.signal?.reason,
            ),
          ),
        );
      this.started.then(
        (turnId) => finish(() => resolve(turnId)),
        (error: Error) => finish(() => reject(error)),
      );
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new AppServerRequestTimeoutError(
                  `thread goal start (${this.threadId})`,
                  options.timeoutMs!,
                ),
              ),
            ),
          options.timeoutMs,
        );
      }
      if (options.signal) {
        options.signal.addEventListener("abort", handleAbort, { once: true });
        if (options.signal.aborted) handleAbort();
      }
    });
  }

  observe(notification: ServerNotification): boolean {
    const isGoalNotification =
      notification.method === "thread/goal/updated" ||
      notification.method === "thread/goal/cleared";
    if (!this.turnRoutingActive && !isGoalNotification) return false;

    if (notification.method === "turn/started") {
      this.physicalTurnActive = true;
      this.currentTurnId = notification.params.turn.id;
      if (!this.logicalTurnId) {
        this.logicalTurnId = notification.params.turn.id;
        this.firstStartedTurn = notification.params.turn;
        this.stream.push(rewriteNotificationTurnId(notification, this.logicalTurnId));
        this.resolveStarted(this.logicalTurnId);
      }
      return true;
    }

    if (notification.method === "turn/completed") {
      this.physicalTurnActive = false;
      if (this.currentTurnId === notification.params.turn.id) this.currentTurnId = null;
      this.lastCompletedNotification = notification;
      if (notification.params.turn.status === "interrupted") {
        this.finishWithCompletion(this.failedCompletion ?? notification);
        return true;
      }
      if (notification.params.turn.status === "failed") {
        this.failedCompletion = notification;
        if (this.cleared || isTerminalGoalStatus(this.goalStatus)) {
          this.finishWithCompletion(notification);
        }
        return true;
      }
      if (this.goalStatus === null && !this.cleared) {
        this.fail(
          new Error("The connected Codex runtime did not activate goal mode for this turn."),
        );
        return true;
      }
      if (this.cleared || isTerminalGoalStatus(this.goalStatus)) {
        this.finishWithCompletion(this.failedCompletion ?? notification);
      }
      return true;
    }

    if (notification.method === "thread/goal/updated") {
      this.goalStatus = notification.params.goal.status;
      if (this.goalStatus === "active") this.cleared = false;
      this.finishAfterTerminalUpdate();
      return true;
    }

    if (notification.method === "thread/goal/cleared") {
      this.cleared = true;
      this.finishAfterTerminalUpdate();
      return true;
    }

    if (notificationTurnId(notification)) {
      if (this.logicalTurnId) {
        this.stream.push(rewriteNotificationTurnId(notification, this.logicalTurnId));
      }
      return true;
    }
    return false;
  }

  markInterrupted(): void {
    this.explicitlyInterrupted = true;
  }

  turnForInterrupt(): string | null {
    return (
      this.currentTurnId ??
      this.lastCompletedNotification?.params.turn.id ??
      this.firstStartedTurn?.id ??
      null
    );
  }

  fail(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.rejectStarted(error);
    this.stream.fail(error);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stream.complete();
  }

  private finishAfterTerminalUpdate(): void {
    if (
      !this.physicalTurnActive &&
      this.lastCompletedNotification &&
      (this.cleared || isTerminalGoalStatus(this.goalStatus))
    ) {
      this.finishWithCompletion(
        this.failedCompletion ?? this.lastCompletedNotification,
      );
    }
  }

  private finishWithCompletion(
    notification: Extract<ServerNotification, { method: "turn/completed" }>,
  ): void {
    if (this.finished) return;
    if (!this.logicalTurnId) {
      this.fail(new Error("Goal completed before its first turn started."));
      return;
    }
    this.stream.push(
      logicalCompletion(
        notification,
        this.logicalTurnId,
        this.firstStartedTurn,
        this.explicitlyInterrupted,
      ),
    );
    this.finish();
  }
}

function isTerminalGoalStatus(status: ThreadGoalStatus | null): boolean {
  return status !== null && TERMINAL_GOAL_STATUSES.has(status);
}

function notificationThreadId(notification: ServerNotification): string | null {
  const params = notification.params as unknown;
  if (!isRecord(params)) return null;
  return typeof params.threadId === "string" ? params.threadId : null;
}

function notificationTurnId(notification: ServerNotification): string | null {
  const params = notification.params as unknown;
  if (!isRecord(params)) return null;
  if (typeof params.turnId === "string") return params.turnId;
  if (isRecord(params.turn) && typeof params.turn.id === "string") return params.turn.id;
  return null;
}

function rewriteNotificationTurnId(
  notification: ServerNotification,
  logicalTurnId: string,
): ServerNotification {
  const params = notification.params as unknown;
  if (!isRecord(params)) return notification;
  let changed = false;
  const rewritten: Record<string, unknown> = { ...params };
  if (typeof params.turnId === "string") {
    rewritten.turnId = logicalTurnId;
    changed = true;
  }
  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    rewritten.turn = { ...params.turn, id: logicalTurnId };
    changed = true;
  }
  return changed
    ? ({ ...notification, params: rewritten } as ServerNotification)
    : notification;
}

function logicalCompletion(
  notification: Extract<ServerNotification, { method: "turn/completed" }>,
  logicalTurnId: string,
  firstStartedTurn: Turn | null,
  interrupted: boolean,
): Extract<ServerNotification, { method: "turn/completed" }> {
  const completed = notification.params.turn;
  const startedAt = firstStartedTurn?.startedAt ?? completed.startedAt;
  const durationMs =
    startedAt !== null && completed.completedAt !== null
      ? Math.max(0, completed.completedAt - startedAt) * 1_000
      : completed.durationMs;
  return {
    ...notification,
    method: "turn/completed",
    params: {
      ...notification.params,
      turn: {
        ...completed,
        id: logicalTurnId,
        startedAt,
        durationMs,
        ...(interrupted ? { status: "interrupted" as const } : {}),
      },
    },
  };
}

function validateWaitOptions(options: Pick<RequestOptions, "signal" | "timeoutMs">): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new RangeError("startTimeoutMs must be a finite non-negative number.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
