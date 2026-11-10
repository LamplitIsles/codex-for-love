import assert from "node:assert/strict";
import { AppServerRpcError } from "@jaminzhou/codex-app-server-client";
import { withExample } from "./lib/environment.mjs";
import { streamResult } from "./lib/results.mjs";

await withExample("controls", async ({ client, live, provider, threadOptions }) => {
  const finishedRace = (error, operation, terminal) => live && terminal.status === "completed"
    && error instanceof AppServerRpcError && error.rpcMessage === `no active turn to ${operation}`;
  const thread = await client.createThread(threadOptions);
  provider?.holdNext();
  const steered = await thread.startTurn("Count from 1 to 40. Do not use tools.");
  let sent = false, steerError;
  const first = await streamResult(steered, async () => {
    if (sent) return;
    sent = true;
    try { await steered.steer("Stop after 10 numbers instead. Do not use tools."); }
    catch (error) { steerError = error; }
    finally { provider?.finishHeld(); }
  });
  if (steerError && !finishedRace(steerError, "steer", first.terminal)) throw steerError;
  if (steerError) console.log("Live turn completed before steering could apply.");
  assert.equal(first.terminal.status, "completed");
  if (!live) assert.match(JSON.stringify(provider.requests.at(-1).input), /Stop after 10 numbers/);

  provider?.holdNext();
  const interrupted = await thread.startTurn("Count from 1 to 200 slowly. Do not use tools.");
  let interruptSent = false, interruptError;
  const second = await streamResult(interrupted, async () => {
    if (interruptSent) return;
    interruptSent = true;
    try { await interrupted.interrupt(); }
    catch (error) { interruptError = error; }
  });
  if (interruptError && !finishedRace(interruptError, "interrupt", second.terminal)) throw interruptError;
  if (interruptError) console.log("Live turn completed before interruption could apply.");
  if (!live) { assert.ok(sent && interruptSent); assert.equal(second.terminal.status, "interrupted"); }
});
