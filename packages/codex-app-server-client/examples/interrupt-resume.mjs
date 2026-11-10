import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";

await withExample("interrupt-resume", async ({ client, live, provider, threadOptions }) => {
  // Persisted threads can be resumed after the managed app-server process closes.
  const thread = await client.createThread({ ...threadOptions, ephemeral: false });
  const savedThreadId = thread.id;
  const turn = await thread.startTurn("Explain recursion in detail. Do not use tools.");
  let interruptRequested = false;
  let interruptError;
  let completed;
  for await (const event of turn.events()) {
    if (event.method === "item/agentMessage/delta") {
      process.stdout.write(event.params.delta);
      if (!interruptRequested) {
        interruptRequested = true;
        // A live turn may finish while this request is in flight. Still consume its terminal event.
        try { await turn.interrupt(); }
        catch (error) { interruptError = error; }
      }
    } else if (event.method === "turn/completed") {
      completed = event.params.turn;
    }
  }
  if (!completed) throw new Error("Missing turn/completed after interruption");
  if (completed.status === "failed") throw new Error(completed.error?.message ?? "Turn failed");
  if (interruptError && completed.status !== "completed") throw interruptError;
  console.log(`\n[first turn] ${completed.status}`);
  await client.close();
  await client.connect(); // New process, same CODEX_HOME.
  const resumed = await client.resumeThread(savedThreadId, threadOptions);
  assert.equal(resumed.id, savedThreadId);
  console.log("[resume] Same persisted thread, new app-server process.");
  const result = await resumed.run("Continue the explanation briefly. Do not use tools.");
  console.log(result.finalResponse);
  console.log(`[second turn] ${result.turn.status}`);
  if (!live) {
    assert.equal(completed.status, "interrupted");
    assert.equal(result.turn.status, "completed");
    assert.equal(provider.requests.length, 2);
    assert.equal(result.finalResponse, "Continued in the same thread.");
    // Verify the resumed request includes earlier conversation, not just a reused thread ID.
    assert(JSON.stringify(provider.requests[1].input).includes("Explain recursion in detail."));
  }
});
