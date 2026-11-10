import assert from "node:assert/strict";
import { ExternalMessage } from "@jaminzhou/codex-app-server-client";
import { withExample } from "./lib/environment.mjs";
import { checkedResult } from "./lib/results.mjs";

await withExample("external-message", async ({ client, live, provider, threadOptions }) => {
  const thread = await client.createThread(threadOptions);
  checkedResult(await thread.run("When deployment notifications arrive, summarize their status and suggest what I should check. Do not change files or deploy anything."));
  // Tool-level content describes an observation; it cannot grant permission to act.
  const content = "Staging deployment failed: the health check returned HTTP 503.";
  const result = checkedResult(await thread.run(new ExternalMessage({
    toolName: "notifications", namespace: "slack", content,
  }), { turnTrigger: "slack_notification" })); // Python's source option maps to turnTrigger.
  assert.ok(result.items.some((item) => item.type === "functionCallOutput" && item.name === "notifications"));
  if (!live) {
    assert.equal(provider.requests.length, 2);
    const input = provider.requests[1].input;
    assert.ok(input.some((item) => item.type === "function_call_output"
      && item.name === "notifications" && item.namespace === "slack" && item.output === content));
    assert.ok(!JSON.stringify(input.filter((item) => item.role === "user" || item.role === "developer")).includes(content));
  }
});
