import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { checkedResult, observeDuring } from "./lib/results.mjs";

await withExample("lifecycle", async ({ client, threadOptions, workspace }) => {
  const thread = await client.createThread({ ...threadOptions, ephemeral: false });
  checkedResult(await thread.run("Describe planning in one sentence. Do not use tools."));
  checkedResult(await thread.run("Restate it for a beginner. Do not use tools."));
  const reopened = await client.resumeThread(thread.id, threadOptions);
  const active = await client.threadList({ limit: 100, archived: false, cwd: workspace, modelProviders: [] });
  assert.ok(active.data.some((entry) => entry.id === thread.id));
  const reading = await reopened.read(true);
  assert.equal(reading.thread.turns.length, 2);
  await reopened.setName("sdk-lifecycle-example");
  await client.threadArchive({ threadId: reopened.id });
  const archived = await client.threadList({ limit: 100, archived: true, cwd: workspace, modelProviders: [] });
  assert.ok(archived.data.some((entry) => entry.id === thread.id));
  const unarchived = await client.threadUnarchive({ threadId: reopened.id });
  assert.equal(unarchived.thread.id, thread.id);
  const resumed = await client.resumeThread(thread.id, threadOptions);
  checkedResult(await resumed.run("Continue briefly. Do not use tools."));
  const forked = await client.forkThread(thread.id, threadOptions);
  assert.notEqual(forked.id, thread.id);
  checkedResult(await forked.run("Describe a different approach. Do not use tools."));
  // compact() acknowledges scheduling; the current runtime reports completion as an item.
  await observeDuring(client, (event) => event.method === "item/completed"
    && event.params.threadId === resumed.id && event.params.item.type === "contextCompaction",
  () => resumed.compact());
  console.log("read.turns:", reading.thread.turns.length, "fork:", forked.id, "compact: completed");
});
