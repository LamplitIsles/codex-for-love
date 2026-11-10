import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";

await withExample("existing-thread", async ({ client, live, provider, threadOptions }) => {
  const original = await client.createThread({ ...threadOptions, ephemeral: false });
  checkedResult(await original.run("Tell me one fact about Saturn. Do not use tools."));
  const resumed = await client.resumeThread(original.id, threadOptions);
  assert.equal(resumed.id, original.id);
  checkedResult(await resumed.run("Continue with one more fact. Do not use tools."));
  if (!live) {
    assert.equal(provider.requests.length, 2);
    assert.match(JSON.stringify(provider.requests[1].input), /one fact about Saturn/);
  }
});
