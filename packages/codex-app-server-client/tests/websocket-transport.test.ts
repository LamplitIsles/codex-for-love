import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  AppServerProtocolError,
  AppServerConnectionClosedError,
  CodexAppServerClient,
  JsonRpcPeer,
  WebSocketMessageTransport,
  resolveAppServerUnixSocketPath,
} from "../src";

describe("WebSocketMessageTransport", () => {
  it("drives the full client handshake and requests over text frames", async () => {
    const server = await listenWebSocketServer();
    let authorization: string | undefined;
    let customHeader: string | undefined;
    let origin: string | undefined;
    const binaryFlags: boolean[] = [];
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      customHeader = request.headers["x-client-test"] as string | undefined;
      origin = request.headers.origin;
      socket.on("message", (data, isBinary) => {
        binaryFlags.push(isBinary);
        const message = JSON.parse(data.toString()) as {
          id?: string;
          method: string;
        };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: {
                codexHome: "/tmp/codex-test",
                platformFamily: "unix",
                platformOs: "macos",
                userAgent: "codex-test",
              },
            }),
          );
        } else if (message.method === "thread/list") {
          socket.send(
            JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }),
          );
        }
      });
    });

    const client = new CodexAppServerClient({
      requestTimeoutMs: 2_000,
      transport: {
        type: "websocket",
        url: serverUrl(server),
        bearerToken: "secret-token",
        headers: { "X-Client-Test": "present" },
      },
    });
    try {
      await expect(client.connect()).resolves.toMatchObject({ userAgent: "codex-test" });
      await expect(client.threadList({ limit: 1 })).resolves.toEqual({
        data: [],
        nextCursor: null,
      });
      expect(client.stderrTail).toBe("");
      expect(authorization).toBe("Bearer secret-token");
      expect(customHeader).toBe("present");
      expect(origin).toBeUndefined();
      expect(binaryFlags).toEqual([false, false, false]);
    } finally {
      await client.close();
      await closeWebSocketServer(server);
    }
    expect(client.state).toBe("disconnected");
  });

  it("rejects binary frames as protocol violations", async () => {
    const server = await listenWebSocketServer();
    const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const transport = await WebSocketMessageTransport.connect({
      type: "websocket",
      url: serverUrl(server),
    });
    const peer = new JsonRpcPeer(transport);
    const closed = new Promise<Error>((resolve) => peer.onClose(resolve));
    const serverSocket = await connected;
    serverSocket.send(Buffer.from("{}"), { binary: true });

    await expect(closed).resolves.toBeInstanceOf(AppServerProtocolError);
    peer.dispose();
    await closeWebSocketServer(server);
  });

  it("enforces remote plaintext, header, token, and resource safety", async () => {
    await expect(
      WebSocketMessageTransport.connect({
        type: "websocket",
        url: "ws://example.com:1234",
      }),
    ).rejects.toThrow("Refusing plaintext ws:// to a non-loopback host");

    await expect(
      WebSocketMessageTransport.connect({
        type: "websocket",
        url: "ws://127.0.0.1:1234",
        headers: { Origin: "https://example.com" },
      }),
    ).rejects.toThrow("Origin is managed by the transport");

    await expect(
      WebSocketMessageTransport.connect({
        type: "websocket",
        url: "ws://127.0.0.1:1234",
        bearerToken: "one",
        bearerTokenEnv: "TOKEN",
      }),
    ).rejects.toThrow("mutually exclusive");

    await expect(
      WebSocketMessageTransport.connect({
        type: "websocket",
        url: "ws://127.0.0.1:1234",
        maxPayloadBytes: 0,
      }),
    ).rejects.toThrow("positive safe integer");
  });

  it("resolves the public default control socket and rejects relative paths", () => {
    expect(resolveAppServerUnixSocketPath({ codexHome: "/tmp/example-codex-home" })).toBe(
      "/tmp/example-codex-home/app-server-control/app-server-control.sock",
    );
    expect(() => resolveAppServerUnixSocketPath({ socketPath: "relative.sock" })).toThrow(
      "must be absolute",
    );
  });

  it("moves the client to disconnected when a connected remote transport disappears", async () => {
    const server = await listenWebSocketServer();
    let serverSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      serverSocket = socket;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: string; method: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: {
                codexHome: "/tmp/codex-test",
                platformFamily: "unix",
                platformOs: "macos",
                userAgent: "codex-test",
              },
            }),
          );
        }
      });
    });
    const observed: Error[] = [];
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: serverUrl(server) },
    });
    client.onError((error) => observed.push(error));
    await client.connect();
    serverSocket?.terminate();

    await vi.waitFor(() => expect(client.state).toBe("disconnected"));
    expect(observed).toHaveLength(1);
    await client.close();
    await closeWebSocketServer(server);
  });

  it("cancels a remote connection that is still in the HTTP Upgrade handshake", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const accepted = once(server, "connection");
    const client = new CodexAppServerClient({
      transport: {
        type: "websocket",
        url: `ws://127.0.0.1:${port}`,
        handshakeTimeoutMs: 10_000,
      },
    });

    const connecting = client.connect();
    const [socket] = await accepted;
    const closing = client.close();
    await expect(connecting).rejects.toBeInstanceOf(AppServerConnectionClosedError);
    await closing;
    expect(client.state).toBe("disconnected");
    socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});

async function listenWebSocketServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  return server;
}

function serverUrl(server: WebSocketServer): string {
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}`;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
