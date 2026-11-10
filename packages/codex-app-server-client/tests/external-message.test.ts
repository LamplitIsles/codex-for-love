import { describe, expect, it } from "vitest";
import { CodexAppServerClient, ExternalMessage, normalizeTurnInput } from "../src";
import { assertToolOutputRuntime } from "../src/external-message";
import type { FunctionCallOutputContentItem } from "../src/generated/protocol/FunctionCallOutputContentItem";
import type { Turn } from "../src/generated/protocol/v2/Turn";
import { FakeAppServer, type FakeRpcMessage } from "./fake-app-server";

const userAgent = "codex_cli_rs/0.153.4 (test)";
const turn = (status: Turn["status"] = "completed"): Turn => ({ id: "turn-1", status, items: [],
  itemsView: "full", error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1_000 });

function finish(server: FakeAppServer): void {
  server.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1,
    item: { id: "reply", type: "agentMessage", text: "done", phase: "final_answer", memoryCitation: null, delivery: null } });
  server.notify("turn/completed", { threadId: "thread-1", turn: turn() });
}

describe("ExternalMessage input and runtime boundaries", () => {
  it("serializes text and structured content as toolOutput with empty user input", async () => {
    const server = await FakeAppServer.listen((message, rpc) => {
      if (message.method === "turn/start") { finish(rpc); rpc.reply(message, { turn: turn() }); }
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    try {
      await client.connect();
      const contents: Array<string | FunctionCallOutputContentItem[]> = ["untrusted notice",
        [{ type: "input_text", text: "structured notice" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" }]];
      for (const content of contents) {
        const handle = await client.startTurn("thread-1", new ExternalMessage({
          toolName: "notifications", namespace: "slack", content,
        }), { turnTrigger: "slack_notification" });
        expect((await handle.result()).finalResponse).toBe("done");
        expect(server.messages.filter((message) => message.method === "turn/start").at(-1)?.params).toEqual({
          threadId: "thread-1", input: [], turnTrigger: "slack_notification",
          toolOutput: { name: "notifications", namespace: "slack", output: content },
        });
      }
    } finally { await client.close(); await server.close(); }
  });

  it("rejects mixed input, steering, competing tool outputs and invalid content before an RPC", async () => {
    const external = new ExternalMessage({ toolName: "notifications", content: "untrusted" });
    expect(() => new ExternalMessage({ toolName: "  ", content: "notice" })).toThrow("toolName");
    // @ts-expect-error External messages are not ordinary user-input items.
    expect(() => normalizeTurnInput([external])).toThrow("whole turn input");
    const server = await FakeAppServer.listen((message, rpc) => {
      if (message.method === "turn/start") { finish(rpc); rpc.reply(message, { turn: turn() }); }
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    try {
      await client.connect();
      const handle = await client.startTurn("thread-1", "hello");
      await handle.result();
      const requestsBefore = server.messages.length;
      // @ts-expect-error External content cannot supply user steering authority.
      expect(() => handle.steer(external)).toThrow("steer()");
      // @ts-expect-error External content must be the whole input, not part of a user-input list.
      await expect(client.startTurn("thread-1", [external])).rejects.toThrow("whole turn input");
      await expect(client.startTurn("thread-1", external, { toolOutput: external.toToolOutput() }))
        .rejects.toThrow("second toolOutput");
      await expect(client.startTurn("thread-1", "hello", { toolOutput: external.toToolOutput() }))
        .rejects.toThrow("nonempty user input");
      const invalid = new ExternalMessage({ toolName: "notifications", content:
        [{ type: "text", text: "not a function-output item" }] as unknown as FunctionCallOutputContentItem[] });
      await expect(client.startTurn("thread-1", invalid)).rejects.toThrow();
      expect(server.messages).toHaveLength(requestsBefore);
    } finally { await client.close(); await server.close(); }
  });

  it("rejects unknown and pre-minimum runtimes, including minimum-version prereleases", () => {
    for (const value of [undefined, "codex-test", "codex/0.150.9", "codex/0.151.0-alpha.1", "codex/garbage"]) {
      expect(() => assertToolOutputRuntime(value)).toThrow(">= 0.151.0");
    }
    for (const value of ["codex/0.151.0", "Codex Desktop/0.153.4 (Mac OS; arm64)", "codex/0.154.0-alpha.1.2", "codex/1.0.0"]) {
      expect(() => assertToolOutputRuntime(value)).not.toThrow();
    }
  });

  it("enforces the runtime guard even for raw toolOutput calls with schema checks disabled", async () => {
    const server = await FakeAppServer.listen(() => {}, "codex/0.150.1");
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url }, protocolValidation: "off" });
    try {
      await client.connect();
      const params = { threadId: "thread-1", input: [], toolOutput: { name: "notification", namespace: null, output: "notice" } };
      expect(() => client.turnStart(params)).toThrow(">= 0.151.0");
      expect(() => client.call("turn/start", params)).toThrow(">= 0.151.0");
      expect(server.messages.some((message) => message.method === "turn/start")).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
});

describe("joining handle RPC races", () => {
  it("releases an aborted join without interrupting the original turn or retaining its result", async () => {
    let request!: FakeRpcMessage;
    let notifyJoin!: () => void;
    const arrived = new Promise<void>((resolve) => { notifyJoin = resolve; });
    const server = await FakeAppServer.listen((message, rpc) => {
      if (message.method !== "turn/start") return;
      if (!message.params?.toolOutput) rpc.reply(message, { turn: turn("inProgress") });
      else { request = message; notifyJoin(); }
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    try {
      await client.connect();
      const original = await client.startTurn("thread-1", "monitor updates");
      const controller = new AbortController();
      const joining = client.startTurn("thread-1", new ExternalMessage({ toolName: "notifications", content: "notice" }), {}, { signal: controller.signal });
      const rejected = expect(joining).rejects.toThrow(/abort/i);
      await arrived; controller.abort(); await rejected;
      finish(server);
      expect((await original.result()).finalResponse).toBe("done");
      server.reply(request, { turn: turn() }); // Late RPC reply cannot create an orphan handle.
      const router = Reflect.get(client, "turnEvents");
      expect(Reflect.get(router, "states").size).toBe(0);
      expect(Reflect.get(router, "starts").size).toBe(0);
      expect(server.messages.some((message) => message.method === "turn/interrupt")).toBe(false);
    } finally { await client.close(); await server.close(); }
  });

  it("does not submit a queued start whose signal was already aborted", async () => {
    let request!: FakeRpcMessage;
    let notifyStart!: () => void;
    const arrived = new Promise<void>((resolve) => { notifyStart = resolve; });
    const server = await FakeAppServer.listen((message) => {
      if (message.method === "turn/start") { request = message; notifyStart(); }
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    try {
      await client.connect();
      const starting = client.startTurn("thread-1", "monitor updates");
      await arrived;
      const controller = new AbortController();
      const queued = client.startTurn("thread-1", new ExternalMessage({ toolName: "notifications", content: "notice" }), {}, { signal: controller.signal });
      const rejected = expect(queued).rejects.toThrow(/abort/i);
      controller.abort(); server.reply(request, { turn: turn("inProgress") });
      const original = await starting;
      await rejected;
      finish(server); await original.result();
      expect(server.messages.filter((message) => message.method === "turn/start")).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it("does not complete a reader from another thread's reused turn ID", async () => {
    const server = await FakeAppServer.listen((message, rpc) => {
      if (message.method === "turn/start") rpc.reply(message, { turn: turn("inProgress") });
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    client.onError(() => {});
    try {
      await client.connect();
      const original = await client.startTurn("thread-1", "hello");
      const result = original.result();
      server.notify("turn/completed", { threadId: "wrong-thread", turn: turn() });
      finish(server);
      expect((await result).finalResponse).toBe("done");
      expect(client.state).toBe("connected");
    } finally { await client.close(); await server.close(); }
  });

  it("retains the result after the original finishes but before a joining reply arrives", async () => {
    let replyToJoin!: FakeRpcMessage;
    let joinArrived!: () => void;
    const arrived = new Promise<void>((resolve) => { joinArrived = resolve; });
    const server = await FakeAppServer.listen((message, rpc) => {
      if (message.method !== "turn/start") return;
      if (!message.params?.toolOutput) rpc.reply(message, { turn: turn("inProgress") });
      else { replyToJoin = message; finish(rpc); joinArrived(); }
    }, userAgent);
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url }, requestTimeoutMs: 2_000 });
    try {
      await client.connect();
      const original = await client.startTurn("thread-1", "monitor updates");
      const firstResult = original.result();
      const joining = client.startTurn("thread-1", new ExternalMessage({ toolName: "notifications", content: "update" }));
      await arrived;
      const result = await firstResult; // The original is fully consumed BEFORE the join's reply.
      server.reply(replyToJoin, { turn: turn("inProgress") });
      const joined = await joining;
      expect(joined.id).toBe(original.id);
      await expect(joined.result()).resolves.toEqual(result);
      expect(Reflect.get(Reflect.get(client, "turnEvents"), "states").size).toBe(0);
    } finally { await client.close(); await server.close(); }
  });
});
