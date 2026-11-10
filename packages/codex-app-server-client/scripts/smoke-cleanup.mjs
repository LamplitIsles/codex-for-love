import { rmSync } from "node:fs";

// The callback is synchronous and must finish its children before returning.
// Only pass a directory created by this smoke run.
export function withSmokeCleanup(directory, run, remove = rmSync) {
  let failed = false;
  let failure;
  try {
    return run();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      // Windows may briefly retain handles to the installed runtime. Delegate transient
      // error classification/backoff to Node; persistent failures must still fail CI.
      remove(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Smoke and temporary-directory cleanup both failed");
      throw cleanupError;
    }
  }
}
