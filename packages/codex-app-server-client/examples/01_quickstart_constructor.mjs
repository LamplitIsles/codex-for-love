import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";

await withExample("quickstart", async ({ client, threadOptions }) => {
  console.log("server:", client.initialization.userAgent);
  const thread = await client.createThread(threadOptions);
  checkedResult(await thread.run("Say hello in one sentence. Do not use tools."));
});
