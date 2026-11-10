import assert from "node:assert/strict";
import { AppServerBusyError, AppServerRpcError, retryOnAppServerOverload } from "@jaminzhou/codex-app-server-client";
import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";

await withExample("retry", async ({ client, live, provider, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  let attempts = 0;
  try {
    const turn = await retryOnAppServerOverload(async () => {
      attempts++;
      if (!live && attempts === 1) {
        // Explicit synthetic fault BEFORE submission; not an observed real server overload.
        console.log("[mock-fault] Inject one overload before submitting a turn");
        throw new AppServerBusyError({ code: -32001, message: "Server overloaded; retry later." });
      }
      return thread.startTurn("Explain safe retry behavior briefly. Do not use tools.");
    }, { maxAttempts: 3, initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0 });
    // Never retry a turn that was already accepted and subsequently failed/timed out.
    checkedResult(await turn.result());
    if (!live) { assert.equal(attempts, 2); assert.equal(provider.requests.length, 1); }
  } catch (error) {
    if (error instanceof AppServerBusyError) console.error("Server remains overloaded after bounded retries.");
    else if (error instanceof AppServerRpcError) console.error("RPC failure:", String(error.code), error.rpcMessage);
    throw error; // A demonstrated error must not turn into a successful smoke exit.
  }
});
