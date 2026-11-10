import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { listModels, selectModel } from "./lib/model-selection.mjs";
import { checkedResult, outputSchema, readStructured } from "./lib/results.mjs";

await withExample("model-select", async ({ client, live, provider, threadOptions, workspace }) => {
  const { model, effort } = selectModel(await listModels(client));
  console.log("selected.model:", model.model, "selected.effort:", effort);
  console.log("Selection mirrors the official example heuristic; it is not a quality or cost recommendation.");
  provider?.allowModel(model.model);
  const thread = await client.createThread({ ...threadOptions, model: model.model, config: { model_reasoning_effort: effort } });
  checkedResult(await thread.run("Describe reliable releases in a sentence. Do not use tools.", { model: model.model, effort }));
  readStructured(await thread.run("Return a brief rollout plan as JSON. Do not use tools.", {
    model: model.model, effort, cwd: workspace, outputSchema,
    personality: "pragmatic", summary: "concise", sandboxPolicy: { type: "readOnly" },
  }));
  if (!live) {
    assert.equal(provider.requests.length, 2);
    for (const request of provider.requests) {
      assert.equal(request.model, model.model);
      // The runtime can normalize app-server effort values for the Responses wire protocol.
      assert.equal(typeof request.reasoning.effort, "string");
      console.log("provider.reasoning.effort:", request.reasoning.effort);
    }
    assert.deepEqual(provider.requests[1].text.format.schema, outputSchema);
  }
});
