import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";

// Python duplicates sync/async surfaces. Node uses promises for this same turn-handle flow.
await withExample("async-parity", async ({ client, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  const turn = await thread.startTurn("Say hello in one sentence. Do not use tools.");
  console.log("thread:", thread.id, "turn:", turn.id);
  checkedResult(await turn.result());
});
