import assert from "node:assert/strict";
import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";
import { withSampleImage } from "./lib/sample-image.mjs";

await withSampleImage(async (path) => {
  await withExample("local-image", async ({ client, live, provider, threadOptions }) => {
    const thread = await client.createThread(threadOptions);
    checkedResult(await thread.run([
      { type: "text", text: "Describe this generated local image. Do not use tools.", text_elements: [] },
      { type: "localImage", path },
    ]));
    if (!live) {
      const image = provider.requests[0].input.flatMap((item) => item.content ?? []).find((item) => item.type === "input_image");
      assert.ok(image?.image_url.startsWith("data:image/"), "Local image must be encoded at the model boundary");
    }
  });
});
