import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface CapturedResponsesRequest {
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}

type ResponsesEvent = Record<string, unknown> & { type: string };

/**
 * A deliberately small local Responses API fixture for real app-server tests.
 * It mirrors the public Codex Python SDK test harness without importing its code.
 */
export class MockResponsesServer {
  readonly requests: CapturedResponsesRequest[] = [];
  private readonly responses: Array<string | ((response: ServerResponse) => void)> = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private originValue: string | null = null;

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  get origin(): string {
    if (!this.originValue) throw new Error("Mock Responses server has not started.");
    return this.originValue;
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address() as AddressInfo;
    this.originValue = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of this.sockets) socket.destroy();
    });
  }

  /** Hold a real model stream until the test explicitly releases it; no timing sleeps. */
  enqueueControlledMessage(text: string, responseId: string): {
    started: Promise<void>;
    finish: () => void;
  } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let active: ServerResponse | undefined;
    this.responses.push((response) => {
      active = response;
      const events = [
        responseCreated(responseId),
        { type: "response.output_item.added", item: {
          type: "message", role: "assistant", id: `msg-${responseId}`,
          content: [{ type: "output_text", text: "" }],
        } },
        { type: "response.output_text.delta", delta: text },
      ];
      for (const event of events) response.write(formatEvent(event));
      markStarted();
    });
    return {
      started,
      finish: () => {
        if (!active) throw new Error("Controlled response has not started.");
        if (active.destroyed || active.writableEnded) return;
        active.end(formatEvent(assistantMessage(`msg-${responseId}`, text)) +
          formatEvent(responseCompleted(responseId)));
      },
    };
  }

  enqueueAssistantMessage(text: string, responseId: string): void {
    this.enqueue([
      responseCreated(responseId),
      assistantMessage(`msg-${responseId}`, text),
      responseCompleted(responseId),
    ]);
  }

  enqueueStreamingAssistantMessage(
    parts: readonly string[],
    responseId: string,
  ): void {
    const itemId = `msg-${responseId}`;
    this.enqueue([
      responseCreated(responseId),
      {
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          id: itemId,
          content: [{ type: "output_text", text: "" }],
        },
      },
      ...parts.map((delta) => ({ type: "response.output_text.delta", delta })),
      assistantMessage(itemId, parts.join("")),
      responseCompleted(responseId),
    ]);
  }

  enqueueFunctionCall(
    name: string,
    argumentsValue: Record<string, unknown>,
    callId: string,
    responseId: string,
  ): void {
    this.enqueue([
      responseCreated(responseId),
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: callId,
          name,
          arguments: JSON.stringify(argumentsValue),
        },
      },
      responseCompleted(responseId),
    ]);
  }

  private enqueue(events: readonly ResponsesEvent[]): void {
    this.responses.push(
      events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        sendJson(response, {
          object: "list",
          data: [{ id: "mock-model", object: "model", created: 0, owned_by: "openai" }],
        });
        return;
      }

      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end("unexpected request");
        return;
      }

      const body = await readJsonBody(request);
      this.requests.push({
        body,
        headers: request.headers,
        method: request.method,
        path: request.url,
      });
      const payload = this.responses.shift();
      if (payload === undefined) {
        response.writeHead(500).end("no queued mock response");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      });
      if (typeof payload === "function") payload(response);
      else response.end(payload);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  }
}

function formatEvent(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function responseCreated(responseId: string): ResponsesEvent {
  return { type: "response.created", response: { id: responseId } };
}

function assistantMessage(itemId: string, text: string): ResponsesEvent {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: itemId,
      content: [{ type: "output_text", text }],
    },
  };
}

function responseCompleted(responseId: string): ResponsesEvent {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Responses request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(200, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}
