import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { streamResult, printUsage } from "./lib/results.mjs";

await withExample("stream-events", async ({ client, live, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  const result = await streamResult(await thread.startTurn("Explain SIMD briefly. Do not use tools."));
  assert.equal(result.terminal.status, "completed");
  if (!live) { assert.ok(result.started); assert.ok(result.text); assert.ok(result.usage); }
  printUsage(result.usage);
});
