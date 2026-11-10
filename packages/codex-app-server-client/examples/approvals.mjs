import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withExample } from "./lib/environment.mjs";

await withExample("approvals", async ({ client, live, provider, workspace, threadOptions }) => {
  let approvals = 0;
  client.onServerRequest("item/commandExecution/requestApproval", (params) => {
    approvals += 1;
    // In a real UI, display command, cwd, reason, and availableDecisions; await the user's choice.
    // This runnable example deliberately declines. Returning accept would permit execution.
    console.log(`[approval] command=${JSON.stringify(params.command)} cwd=${JSON.stringify(params.cwd)}`);
    console.log("[approval] decision=decline");
    return { decision: "decline" };
  });
  const thread = await client.createThread({ ...threadOptions, ephemeral: true });
  const result = await thread.run("Try creating example-command-must-not-run.txt using a shell command.");
  console.log(result.finalResponse);
  console.log(`[turn] ${result.turn.status}`);
  if (!live) {
    assert.equal(approvals, 1);
    assert(result.items.some((item) => item.type === "commandExecution" && item.status === "declined"));
    assert.equal(existsSync(join(workspace, "example-command-must-not-run.txt")), false);
    assert.equal(provider.requests.length, 2);
    console.log("[verified] Declined command did not execute.");
  }
});
