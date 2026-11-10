import { setTimeout as delay } from "node:timers/promises";
import { isRetryableAppServerError } from "./errors";

export interface AppServerRetryOptions {
  initialDelayMs?: number;
  jitterRatio?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
  random?: () => number;
  signal?: AbortSignal;
}

export async function retryOnAppServerOverload<T>(
  operation: (attempt: number) => Promise<T>,
  options: AppServerRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;

  validateRetryOptions({ initialDelayMs, jitterRatio, maxAttempts, maxDelayMs });
  let delayMs = initialDelayMs;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableAppServerError(error)) throw error;
      const cappedDelay = Math.min(maxDelayMs, delayMs);
      const jitter = cappedDelay * jitterRatio * (random() * 2 - 1);
      await delay(Math.max(0, cappedDelay + jitter), undefined, { signal: options.signal });
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}

function validateRetryOptions(options: {
  initialDelayMs: number;
  jitterRatio: number;
  maxAttempts: number;
  maxDelayMs: number;
}): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be an integer greater than or equal to 1.");
  }
  if (!Number.isFinite(options.initialDelayMs) || options.initialDelayMs < 0) {
    throw new RangeError("initialDelayMs must be a finite non-negative number.");
  }
  if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0) {
    throw new RangeError("maxDelayMs must be a finite non-negative number.");
  }
  if (!Number.isFinite(options.jitterRatio) || options.jitterRatio < 0 || options.jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1.");
  }
}
