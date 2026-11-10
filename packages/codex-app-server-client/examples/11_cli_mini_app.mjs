import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { withExample } from "./lib/environment.mjs";
import { streamResult, printUsage } from "./lib/results.mjs";

await withExample("mini-cli", async ({ client, live, provider, threadOptions, interactive }) => {
  const thread = await client.createThread(threadOptions);
  console.log("Codex mini CLI. Type /exit or /quit to stop. Thread:", thread.id);
  // Create the input iterator only once the client is ready; piped lines must not be lost.
  const input = interactive ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : null;
  const prompts = input ?? ["Explain planning briefly. Do not use tools.", "Restate it simply. Do not use tools.", "/exit"];
  let turns = 0;
  try {
    for await (const line of prompts) {
      const prompt = line.trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      const result = await streamResult(await thread.startTurn(prompt));
      assert.equal(result.terminal.status, "completed");
      printUsage(result.usage);
      turns++;
    }
  } finally { input?.close(); }
  console.log("cli.turns:", turns);
  if (!live) {
    assert.equal(provider.requests.length, turns);
    if (!interactive) assert.equal(turns, 2);
    if (turns > 1) assert.match(JSON.stringify(provider.requests[1].input), /Scripted response 1/);
  }
}, { allowInteractive: true });
