import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { outputSchema, readStructured } from "./lib/results.mjs";

await withExample("structured", async ({ client, live, provider, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  const result = await thread.run("Return a short rollout plan matching the JSON schema. Do not use tools.", {
    outputSchema, personality: "pragmatic", summary: "concise",
  });
  const value = readStructured(result);
  console.log("summary:", value.summary, "actions:", value.actions.join(", "));
  if (!live) {
    assert.deepEqual(provider.requests[0].text.format.schema, outputSchema);
    assert.equal(provider.requests[0].reasoning.summary, "concise");
  }
});
