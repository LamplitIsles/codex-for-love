import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { checkedResult, printUsage } from "./lib/results.mjs";

await withExample("turn-run", async ({ client, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  const turn = await thread.startTurn("Give three short bullets about SIMD. Do not use tools.");
  const result = checkedResult(await turn.result());
  assert.equal(result.turn.id, turn.id);
  console.log("thread_id:", thread.id, "turn_id:", turn.id);
  printUsage(result.usage);
});
