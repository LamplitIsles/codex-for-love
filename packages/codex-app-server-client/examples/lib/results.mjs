import assert from "node:assert/strict";

export function checkedResult(result) {
  assert.equal(result.turn.status, "completed", result.turn.error?.message ?? "Turn did not complete");
  assert.equal(typeof result.finalResponse, "string");
  console.log("status:", result.turn.status);
  console.log("text:", result.finalResponse);
  console.log("items.count:", result.items.length);
  return result;
}

export async function streamResult(turn, onDelta = async () => {}) {
  let text = "";
  let usage = null;
  let terminal;
  let started = false;
  let events = 0;
  const completedTexts = [];
  // Exactly one consumer, including while steering/interruption requests are in flight.
  for await (const event of turn.events()) {
    events++;
    if (event.method === "turn/started") started = true;
    if (event.method === "item/agentMessage/delta") {
      text += event.params.delta;
      process.stdout.write(event.params.delta);
      await onDelta(event.params.delta);
    }
    if (event.method === "item/completed" && event.params.item.type === "agentMessage") {
      completedTexts.push(event.params.item.text);
    }
    if (event.method === "thread/tokenUsage/updated") usage = event.params.tokenUsage;
    if (event.method === "turn/completed") terminal = event.params.turn;
  }
  assert.ok(terminal, "Stream ended without turn/completed");
  if (terminal.status === "failed") throw new Error(terminal.error?.message ?? "Turn failed");
  assert.ok(["completed", "interrupted"].includes(terminal.status), "Unexpected terminal status");
  if (!text) { text = completedTexts.join(""); process.stdout.write(text); }
  console.log("\nstream.completed:", terminal.status);
  console.log("stream.started.seen:", started, "events.count:", events);
  return { text, usage, terminal, started, events };
}

export function printUsage(usage) {
  if (!usage) { console.log("usage: unavailable"); return; }
  // These are server snapshots, not an independently verified billing total.
  const printable = (_key, value) => typeof value === "bigint" ? value.toString() : value;
  console.log("usage.last:", JSON.stringify(usage.last, printable));
  console.log("usage.total:", JSON.stringify(usage.total, printable));
}

export const outputSchema = {
  type: "object",
  properties: { summary: { type: "string" }, actions: { type: "array", items: { type: "string" } } },
  required: ["summary", "actions"], additionalProperties: false,
};

export function readStructured(result) {
  const value = JSON.parse(checkedResult(result).finalResponse);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ["actions", "summary"]);
  assert.equal(typeof value.summary, "string");
  assert.ok(Array.isArray(value.actions) && value.actions.every((action) => typeof action === "string"));
  return value;
}

export async function observeDuring(client, predicate, action) {
  let unsubscribe = () => {};
  let timer;
  const observed = new Promise((resolve, reject) => {
    unsubscribe = client.onNotification((event) => { if (predicate(event)) resolve(event); });
    timer = setTimeout(() => reject(new Error("Expected notification did not arrive")), 15_000);
  });
  void observed.catch(() => {});
  try { await action(); return await observed; }
  finally { clearTimeout(timer); unsubscribe(); }
}
