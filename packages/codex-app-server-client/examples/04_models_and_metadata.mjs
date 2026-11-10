import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { listModels } from "./lib/model-selection.mjs";

await withExample("models", async ({ client }) => {
  assert.equal(client.state, "connected");
  console.log("server:", client.initialization.userAgent);
  console.log("platform:", client.initialization.platformOs);
  const models = await listModels(client);
  console.log("models.count:", models.length);
  console.log("models:", models.filter((model) => !model.hidden).slice(0, 5).map((model) => model.id).join(", "));
});
