import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

export interface FakeRpcMessage {
  emittedAtMs?: number;
  error?: { code: number; data?: unknown; message: string };
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

export type FakeRequestHandler = (
  message: FakeRpcMessage,
  server: FakeAppServer,
) => void | Promise<void>;

export class FakeAppServer {
  readonly messages: FakeRpcMessage[] = [];
  readonly url: string;
  private readonly handler: FakeRequestHandler;
  private readonly server: WebSocketServer;
  private socket: WebSocket | null = null;

  private constructor(server: WebSocketServer, handler: FakeRequestHandler, userAgent: string) {
    this.server = server;
    this.handler = handler;
    const address = server.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as FakeRpcMessage;
        this.messages.push(message);
        if (message.method === "initialize") {
          this.reply(message, {
            codexHome: "/tmp/codex-test",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent,
          });
          return;
        }
        if (message.method === "initialized") return;
        void Promise.resolve(this.handler(message, this)).catch((error: unknown) => {
          if (message.id !== undefined) {
            this.error(message, -32603, error instanceof Error ? error.message : String(error));
          }
        });
      });
    });
  }

  static async listen(handler: FakeRequestHandler, userAgent = "codex-test"): Promise<FakeAppServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    return new FakeAppServer(server, handler, userAgent);
  }

  reply(request: FakeRpcMessage, result: unknown): void {
    if (request.id === undefined) throw new Error("Cannot reply to a notification.");
    this.send({ id: request.id, result });
  }

  error(request: FakeRpcMessage, code: number, message: string, data?: unknown): void {
    if (request.id === undefined) throw new Error("Cannot reply to a notification.");
    this.send({
      id: request.id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  notify(method: string, params: Record<string, unknown>, emittedAtMs?: number): void {
    this.send({
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
      method,
      params,
    });
  }

  request(id: number | string, method: string, params: Record<string, unknown>): void {
    this.send({ id, method, params });
  }

  terminateConnection(): void {
    this.socket?.terminate();
  }

  async close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Fake app-server has no open connection.");
    }
    this.socket.send(JSON.stringify(message));
  }
}
