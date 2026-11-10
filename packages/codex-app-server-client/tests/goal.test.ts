import { describe, expect, it, vi } from "vitest";
import {
  AppServerInvalidRequestError,
  CodexAppServerClient,
} from "../src";
import type { ServerNotification } from "../src/generated/protocol/ServerNotification";
import type { ThreadGoal } from "../src/generated/protocol/v2/ThreadGoal";
import type { Thread } from "../src/generated/protocol/v2/Thread";
import type { Turn } from "../src/generated/protocol/v2/Turn";
import { FakeAppServer, type FakeRpcMessage } from "./fake-app-server";

const THREAD_ID = "thread-goal";

describe("thread goal workflows", () => {
  it("coalesces runtime continuations into one logical turn", async () => {
    const rawNotifications: ServerNotification[] = [];
    const server = await FakeAppServer.listen((message, appServer) => {
      switch (message.method) {
        case "thread/read":
          appServer.reply(message, {
            thread: threadSnapshot(),
          });
          break;
        case "thread/goal/clear":
          appServer.reply(message, { cleared: false });
          break;
        case "thread/goal/set": {
          const goal = threadGoal("active");
          // Exercise the response/notification race: a rich client must buffer these
          // notifications even when the runtime emits them before the RPC response.
          appServer.notify("thread/goal/updated", {
            threadId: THREAD_ID,
            turnId: null,
            goal,
          });
          appServer.notify("turn/started", {
            threadId: THREAD_ID,
            turn: turn("physical-1", "inProgress", 10, null),
          });
          appServer.reply(message, { goal });
          break;
        }
      }
    });
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });
    client.onNotification((notification) => {
      rawNotifications.push(notification as ServerNotification);
    });

    try {
      await client.connect();
      const goal = await client.startGoal(THREAD_ID, "Ship the production client", {
        tokenBudget: 12_000,
      });
      expect(goal).toMatchObject({
        id: "physical-1",
        objective: "Ship the production client",
        threadId: THREAD_ID,
      });
      await expect(client.startTurn(THREAD_ID, "conflicting work")).rejects.toBeInstanceOf(
        AppServerInvalidRequestError,
      );

      const logicalEvents = collect(goal.events());
      server.notify("item/completed", {
        threadId: THREAD_ID,
        turnId: "physical-1",
        completedAtMs: 11_000,
        item: agentMessage("item-1", "Initial pass", "commentary"),
      });
      server.notify("turn/completed", {
        threadId: THREAD_ID,
        turn: turn("physical-1", "completed", 10, 11),
      });
      server.notify("turn/started", {
        threadId: THREAD_ID,
        turn: turn("physical-2", "inProgress", 12, null),
      });
      server.notify("item/completed", {
        threadId: THREAD_ID,
        turnId: "physical-2",
        completedAtMs: 14_000,
        item: agentMessage("item-2", "Goal complete", "final_answer"),
      });
      server.notify("thread/goal/updated", {
        threadId: THREAD_ID,
        turnId: "physical-2",
        goal: threadGoal("complete"),
      });
      server.notify(
        "turn/completed",
        {
          threadId: THREAD_ID,
          turn: turn("physical-2", "completed", 12, 14),
        },
        7_000,
      );

      const events = await logicalEvents;
      expect(events.map((event) => event.method)).toEqual([
        "turn/started",
        "item/completed",
        "item/completed",
        "turn/completed",
      ]);
      expect(events.map(notificationTurnId)).toEqual([
        "physical-1",
        "physical-1",
        "physical-1",
        "physical-1",
      ]);
      expect(events.at(-1)).toMatchObject({
        emittedAtMs: 7_000,
        method: "turn/completed",
        params: {
          turn: {
            completedAt: 14,
            durationMs: 4_000,
            id: "physical-1",
            startedAt: 10,
            status: "completed",
          },
        },
      });
      expect(
        rawNotifications.some(
          (notification) =>
            notification.method === "turn/started" &&
            notification.params.turn.id === "physical-2",
        ),
      ).toBe(true);
      expect(
        server.messages.filter((message) => message.method === "turn/start"),
      ).toHaveLength(0);
      await expect(goal.pause()).resolves.toBeUndefined();
      expect(
        server.messages.filter((message) => message.method === "thread/goal/set"),
      ).toHaveLength(1);
      expect(
        server.messages.find((message) => message.method === "thread/goal/set")?.params,
      ).toEqual({
        threadId: THREAD_ID,
        objective: "Ship the production client",
        status: "active",
        tokenBudget: 12_000,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("collects a logical goal result and pauses the active physical turn", async () => {
    const server = await FakeAppServer.listen((message, appServer) => {
      switch (message.method) {
        case "thread/read":
          appServer.reply(message, {
            thread: threadSnapshot(),
          });
          break;
        case "thread/goal/clear":
          appServer.reply(message, { cleared: false });
          break;
        case "thread/goal/set": {
          const status = message.params?.status === "paused" ? "paused" : "active";
          const goal = threadGoal(status);
          appServer.reply(message, { goal });
          appServer.notify("thread/goal/updated", {
            threadId: THREAD_ID,
            turnId: status === "active" ? null : "physical-pause",
            goal,
          });
          if (status === "active") {
            appServer.notify("turn/started", {
              threadId: THREAD_ID,
              turn: turn("physical-pause", "inProgress", 20, null),
            });
          }
          break;
        }
        case "turn/interrupt":
          if (message.params?.turnId === "physical-pause") {
            appServer.error(
              message,
              -32600,
              "expected active turn id physical-pause but found physical-rollover",
            );
          } else {
            appServer.reply(message, {});
            appServer.notify("turn/completed", {
              threadId: THREAD_ID,
              turn: turn("physical-rollover", "interrupted", 20, 21),
            });
          }
          break;
      }
    });
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });

    try {
      await client.connect();
      const goal = await client.startGoal(THREAD_ID, "Pause safely");
      const result = goal.result();
      await Promise.all([goal.pause(), goal.pause()]);
      await expect(result).resolves.toMatchObject({
        finalResponse: null,
        items: [],
        turn: { id: "physical-pause", status: "interrupted" },
      });
      expect(
        server.messages
          .filter((message) => message.method === "turn/interrupt")
          .map((message) => message.params),
      ).toEqual([
        { threadId: THREAD_ID, turnId: "physical-pause" },
        { threadId: THREAD_ID, turnId: "physical-rollover" },
      ]);
      expect(
        server.messages
          .filter((message) => message.method === "thread/goal/set")
          .map((message) => message.params?.status),
      ).toEqual(["active", "paused"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serializes starts per thread while allowing different threads concurrently", async () => {
    const pending: FakeRpcMessage[] = [];
    const server = await FakeAppServer.listen((message) => {
      if (message.method === "turn/start") pending.push(message);
    });
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });

    try {
      await client.connect();
      const a1 = client.startTurn("thread-a", "a1");
      const a2 = client.startTurn("thread-a", "a2");
      const b1 = client.startTurn("thread-b", "b1");

      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(pending.map((message) => message.params?.threadId).sort()).toEqual([
        "thread-a",
        "thread-b",
      ]);
      const firstA = pending.find((message) => message.params?.threadId === "thread-a");
      const firstB = pending.find((message) => message.params?.threadId === "thread-b");
      if (!firstA || !firstB) throw new Error("Expected both first turn/start requests.");
      server.reply(firstA, { turn: turn("a-1", "inProgress", 1, null) });
      server.reply(firstB, { turn: turn("b-1", "inProgress", 1, null) });
      await Promise.all([a1, b1]);

      await vi.waitFor(() => expect(pending).toHaveLength(3));
      const secondA = pending[2];
      expect(secondA.params?.threadId).toBe("thread-a");
      expect(secondA.params?.input).toEqual([
        { type: "text", text: "a2", text_elements: [] },
      ]);
      server.reply(secondA, { turn: turn("a-2", "inProgress", 2, null) });
      await expect(a2).resolves.toMatchObject({ id: "a-2", threadId: "thread-a" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function threadGoal(status: ThreadGoal["status"]): ThreadGoal {
  return {
    threadId: THREAD_ID,
    objective: "Ship the production client",
    status,
    tokenBudget: 12_000,
    tokensUsed: 400,
    timeUsedSeconds: 8,
    createdAt: 1,
    updatedAt: 2,
  };
}

function threadSnapshot(): Thread {
  return {
    id: THREAD_ID,
    extra: null,
    sessionId: "session-goal",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: "/tmp/thread-goal.jsonl",
    cwd: "/tmp",
    cliVersion: "0.152.1",
    source: "unknown",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turn(
  id: string,
  status: Turn["status"],
  startedAt: number,
  completedAt: number | null,
): Turn {
  return {
    id,
    status,
    items: [],
    itemsView: "full",
    error: null,
    startedAt,
    completedAt,
    durationMs: completedAt === null ? null : (completedAt - startedAt) * 1_000,
  };
}

function agentMessage(
  id: string,
  text: string,
  phase: "commentary" | "final_answer",
): Record<string, unknown> {
  return { type: "agentMessage", id, text, phase, memoryCitation: null };
}

async function collect(
  events: AsyncIterable<ServerNotification>,
): Promise<ServerNotification[]> {
  const collected: ServerNotification[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function notificationTurnId(notification: ServerNotification): string | null {
  const params = notification.params as unknown as Record<string, unknown>;
  if (typeof params.turnId === "string") return params.turnId;
  const eventTurn = params.turn as Record<string, unknown> | undefined;
  return typeof eventTurn?.id === "string" ? eventTurn.id : null;
}
