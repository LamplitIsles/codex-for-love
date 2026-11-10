import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";

await withExample("stream", async ({ client, live, provider, threadOptions }) => {
  const thread = await client.createThread({ ...threadOptions, ephemeral: true });
  const turn = await thread.startTurn("Say hello in one sentence. Do not use tools.");
  let text = "";
  let completed;
  // A turn has ONE event consumer: use events() here, not result() afterwards.
  for await (const event of turn.events()) {
    if (event.method === "item/agentMessage/delta") {
      text += event.params.delta;
      process.stdout.write(event.params.delta);
    } else if (event.method === "turn/completed") {
      completed = event.params.turn;
    }
  }
  if (!completed) throw new Error("Connection ended without turn/completed");
  if (completed.status !== "completed") throw new Error(completed.error?.message ?? completed.status);
  console.log(`\n[turn] ${completed.status}`);
  if (!live) {
    assert.equal(text, "Hello from the local mock.");
    assert.equal(provider.requests.length, 1);
  }
});
