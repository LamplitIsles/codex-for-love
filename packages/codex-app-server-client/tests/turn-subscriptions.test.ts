import { describe, expect, it } from "vitest";
import { collectTurnResult } from "../src/thread";
import { TurnEventRouter } from "../src/turn-event-router";
import type { ServerNotificationEnvelope as Notification } from "../src/generated/protocol/ServerNotificationEnvelope";

const scope = { threadId: "thread-1", turnId: "turn-1" };
const item: Notification = { method: "item/completed", params: { ...scope, completedAtMs: 1,
  item: { type: "agentMessage", id: "reply", text: "done", phase: "final_answer", memoryCitation: null, delivery: null } } };
const tokens = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 5 };
const usage: Notification = { method: "thread/tokenUsage/updated", params: { ...scope,
  tokenUsage: { last: tokens, total: tokens, modelContextWindow: null } } };
const completion: Notification = { method: "turn/completed", params: { threadId: scope.threadId,
  turn: { id: scope.turnId, status: "completed", items: [], itemsView: "full", error: null,
    startedAt: 1, completedAt: 2, durationMs: 1_000 } } };
const delta: Notification = { method: "item/agentMessage/delta", params: { ...scope, itemId: "reply", delta: "token" } };
const states = (router: TurnEventRouter): Map<string, { early: unknown[]; items: Map<string, unknown> }> => Reflect.get(router, "states");

describe("independent subscriptions to one turn", () => {
  it("isolates identical turn IDs in different threads, including a pending join", async () => {
    const router = new TurnEventRouter();
    const release = router.reserveStart(scope.threadId);
    const first = router.open(scope.turnId, scope.threadId);
    const sibling = router.open(scope.turnId, "fork");
    router.route(item);
    router.route(completion);
    const joined = router.open(scope.turnId, scope.threadId);
    release();
    expect(sibling.unread()).toHaveLength(0);
    router.route({ ...item, params: { ...item.params, threadId: "fork", item: {
      type: "agentMessage", id: "fork-reply", text: "fork only", phase: "final_answer", memoryCitation: null, delivery: null,
    } } });
    router.route({ ...completion, params: { ...completion.params, threadId: "fork" } });
    expect(await collectTurnResult(joined, scope.turnId)).toEqual(await collectTurnResult(first, scope.turnId));
    expect((await collectTurnResult(sibling, scope.turnId)).finalResponse).toBe("fork only");
    expect(states(router).size).toBe(0);
  });

  it("replays consumed completed items and latest usage to a late joining handle", async () => {
    const router = new TurnEventRouter();
    const original = router.open(scope.turnId, scope.threadId);
    router.route(item); expect((await original.next()).value).toEqual(item);
    router.route(usage); expect((await original.next()).value).toEqual(usage);
    const joined = router.open(scope.turnId, scope.threadId);
    router.route(completion);
    async function* fullOriginal() { yield item; yield usage; yield* original; }
    const first = await collectTurnResult(fullOriginal(), scope.turnId);
    await expect(collectTurnResult(joined, scope.turnId)).resolves.toEqual(first);
    expect(first.finalResponse).toBe("done");
    expect(first.usage?.last.totalTokens).toBe(5);
    expect(states(router).size).toBe(0);
  });

  it("retains unread deltas for slow and joining readers but releases consumed transient events", async () => {
    const router = new TurnEventRouter();
    const fast = router.open(scope.turnId, scope.threadId);
    for (let count = 0; count < 1_000; count++) {
      router.route({ ...delta, params: { ...delta.params, delta: String(count) } });
      await fast.next();
    }
    expect(fast.unread()).toHaveLength(0);
    expect(states(router).get(JSON.stringify([scope.threadId, scope.turnId]))?.early).toHaveLength(0);
    expect(states(router).get(JSON.stringify([scope.threadId, scope.turnId]))?.items.size).toBe(0);
    const slow = router.open(scope.turnId, scope.threadId);
    router.route(delta); await fast.next();
    const joined = router.open(scope.turnId, scope.threadId);
    expect((await slow.next()).value).toEqual(delta);
    expect((await joined.next()).value).toEqual(delta);
    await slow.return(); await fast.return(); await joined.return();
    router.route(completion);
    expect(states(router).size).toBe(0);
  });

  it("closing one reader releases its waiters but leaves the other reader intact", async () => {
    const router = new TurnEventRouter();
    const first = router.open(scope.turnId, scope.threadId);
    const joined = router.open(scope.turnId, scope.threadId);
    const waiting = first.next();
    await first.return();
    await expect(waiting).resolves.toMatchObject({ done: true });
    router.route(item); router.route(usage); router.route(completion);
    await expect(collectTurnResult(joined, scope.turnId)).resolves.toMatchObject({ finalResponse: "done" });
    expect(states(router).size).toBe(0);
  });

  it("retains early completion while a join is pending and releases failed starts", async () => {
    const router = new TurnEventRouter();
    const original = router.open(scope.turnId, scope.threadId);
    const release = router.reserveStart(scope.threadId);
    router.route(item); router.route(usage); router.route(completion);
    const result = await collectTurnResult(original, scope.turnId);
    expect(states(router).size).toBe(1);
    const joined = router.open(scope.turnId, scope.threadId);
    release();
    await expect(collectTurnResult(joined, scope.turnId)).resolves.toEqual(result);
    expect(states(router).size).toBe(0);
    const failStart = router.reserveStart(scope.threadId);
    router.route(item); router.route(completion);
    failStart(); failStart(); // Idempotent finally, with no unclaimed result left behind.
    expect(states(router).size).toBe(0);
    expect(Reflect.get(router, "starts").size).toBe(0);
  });

  it("propagates connection and model failures independently and clears retained state", async () => {
    for (const failure of ["connection", "model"]) {
      const router = new TurnEventRouter();
      const first = collectTurnResult(router.open(scope.turnId, scope.threadId), scope.turnId);
      const joined = collectTurnResult(router.open(scope.turnId, scope.threadId), scope.turnId);
      const assertions = [expect(first).rejects.toThrow(`${failure} failed`), expect(joined).rejects.toThrow(`${failure} failed`)];
      if (failure === "connection") router.failAll(new Error("connection failed"));
      else router.route({ ...completion, params: { ...completion.params, turn: {
        ...completion.params.turn, status: "failed", error: { message: "model failed", codexErrorInfo: null, additionalDetails: null },
      } } });
      await Promise.all(assertions);
      expect(states(router).size).toBe(0);
    }
  });

  it("does not let an old reservation release a new connection's pending start", () => {
    const router = new TurnEventRouter();
    const old = router.reserveStart(scope.threadId);
    router.failAll(new Error("connection failed"));
    const fresh = router.reserveStart(scope.threadId);
    old();
    router.route(completion);
    expect(states(router).size).toBe(1);
    fresh();
    expect(states(router).size).toBe(0);
  });
});
