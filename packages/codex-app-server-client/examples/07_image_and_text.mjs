import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";
import { sampleImage } from "./lib/sample-image.mjs";

await withExample("image", async ({ client, live, provider, threadOptions }) => {
  const url = "data:image/png;base64," + sampleImage().toString("base64");
  const thread = await client.createThread(threadOptions);
  checkedResult(await thread.run([
    { type: "text", text: "Describe the image briefly. Do not use tools.", text_elements: [] },
    { type: "image", url },
  ]));
  if (!live) {
    const image = provider.requests[0].input.flatMap((item) => item.content ?? []).find((item) => item.type === "input_image");
    assert.ok(image?.image_url.startsWith("data:image/"), "Image must reach the model boundary");
  }
});
