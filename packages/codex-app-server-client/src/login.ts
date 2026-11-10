import type { CodexAppServerClient } from "./app-server-client";
import {
  AppServerConnectionClosedError,
  AppServerRequestAbortedError,
  AppServerRequestTimeoutError,
} from "./errors";
import type { AccountLoginCompletedNotification } from "./generated/protocol/v2/AccountLoginCompletedNotification";
import type { CancelLoginAccountResponse } from "./generated/protocol/v2/CancelLoginAccountResponse";
import type { LoginAccountParams } from "./generated/protocol/v2/LoginAccountParams";
import type { ServerNotificationEnvelope as ServerNotification } from "./generated/protocol/ServerNotificationEnvelope";
import type { RequestOptions } from "./types";

const MAX_COMPLETED_LOGINS = 64;

export type LoginWaitOptions = Pick<RequestOptions, "signal" | "timeoutMs">;
export type ChatGptLoginOptions = Omit<
  Extract<LoginAccountParams, { type: "chatgpt" }>,
  "type"
>;
export type ChatGptAuthTokens = Omit<
  Extract<LoginAccountParams, { type: "chatgptAuthTokens" }>,
  "type"
>;

interface LoginWaiter {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (notification: AccountLoginCompletedNotification) => void;
}

export class ChatGptLoginHandle {
  readonly loginId: string;
  readonly authUrl: string;
  private readonly client: CodexAppServerClient;

  constructor(client: CodexAppServerClient, loginId: string, authUrl: string) {
    this.client = client;
    this.loginId = loginId;
    this.authUrl = authUrl;
  }

  wait(options: LoginWaitOptions = {}): Promise<AccountLoginCompletedNotification> {
    return this.client.waitForLoginCompleted(this.loginId, options);
  }

  cancel(options: RequestOptions = {}): Promise<CancelLoginAccountResponse> {
    return this.client.accountLoginCancel({ loginId: this.loginId }, options);
  }
}

export class DeviceCodeLoginHandle {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
  private readonly client: CodexAppServerClient;

  constructor(
    client: CodexAppServerClient,
    loginId: string,
    verificationUrl: string,
    userCode: string,
  ) {
    this.client = client;
    this.loginId = loginId;
    this.verificationUrl = verificationUrl;
    this.userCode = userCode;
  }

  wait(options: LoginWaitOptions = {}): Promise<AccountLoginCompletedNotification> {
    return this.client.waitForLoginCompleted(this.loginId, options);
  }

  cancel(options: RequestOptions = {}): Promise<CancelLoginAccountResponse> {
    return this.client.accountLoginCancel({ loginId: this.loginId }, options);
  }
}

export class LoginEventRouter {
  private readonly completed = new Map<string, AccountLoginCompletedNotification>();
  private readonly waiters = new Map<string, Set<LoginWaiter>>();
  private failure: Error | null = null;

  route(notification: ServerNotification): boolean {
    if (notification.method !== "account/login/completed") return false;
    const completion = notification.params;
    if (typeof completion.loginId !== "string" || completion.loginId.length === 0) return false;

    this.completed.delete(completion.loginId);
    this.completed.set(completion.loginId, completion);
    while (this.completed.size > MAX_COMPLETED_LOGINS) {
      const oldest = this.completed.keys().next().value;
      if (oldest !== undefined) this.completed.delete(oldest);
    }
    const waiters = this.waiters.get(completion.loginId);
    if (waiters) {
      this.waiters.delete(completion.loginId);
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.resolve(completion);
      }
    }
    return true;
  }

  wait(
    loginId: string,
    options: LoginWaitOptions = {},
  ): Promise<AccountLoginCompletedNotification> {
    if (!loginId) throw new TypeError("loginId must be a non-empty string.");
    validateWaitOptions(options);
    const completed = this.completed.get(loginId);
    if (completed) return Promise.resolve(completed);
    if (this.failure) return Promise.reject(this.failure);

    return new Promise<AccountLoginCompletedNotification>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (options.signal && abortHandler) {
          options.signal.removeEventListener("abort", abortHandler);
        }
      };
      const waiter: LoginWaiter = { cleanup, reject, resolve };
      const removeAndReject = (error: Error) => {
        const waiters = this.waiters.get(loginId);
        if (!waiters?.delete(waiter)) return;
        if (waiters.size === 0) this.waiters.delete(loginId);
        cleanup();
        reject(error);
      };

      const waiters = this.waiters.get(loginId) ?? new Set<LoginWaiter>();
      waiters.add(waiter);
      this.waiters.set(loginId, waiters);
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            removeAndReject(
              new AppServerRequestTimeoutError(
                `account/login/completed (${loginId})`,
                options.timeoutMs!,
              ),
            ),
          options.timeoutMs,
        );
      }
      if (options.signal) {
        abortHandler = () =>
          removeAndReject(
            new AppServerRequestAbortedError(
              `account/login/completed (${loginId})`,
              options.signal?.reason,
            ),
          );
        options.signal.addEventListener("abort", abortHandler, { once: true });
        if (options.signal.aborted) abortHandler();
      }
    });
  }

  failAll(error: Error = new AppServerConnectionClosedError()): void {
    this.failure = error;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    this.completed.clear();
  }

  reset(): void {
    this.failure = null;
    this.completed.clear();
  }
}

function validateWaitOptions(options: LoginWaitOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new RangeError("timeoutMs must be a finite non-negative number.");
  }
}
