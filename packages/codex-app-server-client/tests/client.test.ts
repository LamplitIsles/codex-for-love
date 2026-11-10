import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src";

describe("CodexAppServerClient configuration", () => {
  it("rejects invalid bounded-resource and timeout options", () => {
    expect(() => new CodexAppServerClient({ requestTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => new CodexAppServerClient({ requestTimeoutMs: Number.NaN })).toThrow(
      "requestTimeoutMs must be a finite non-negative number.",
    );
    expect(() => new CodexAppServerClient({ stderrBufferLines: 1.5 })).toThrow(RangeError);
    expect(() => new CodexAppServerClient({ stderrBufferLines: -1 })).toThrow(
      "stderrBufferLines must be a non-negative integer.",
    );
  });

  it("rejects local launch options for attach transports", () => {
    expect(
      () =>
        new CodexAppServerClient({
          codexPath: "/tmp/codex",
          transport: { type: "unix", socketPath: "/tmp/codex.sock" },
        }),
    ).toThrow("Local process options cannot be used with unix transport: codexPath.");
  });

  it("rejects method-scoped registrations without a handler at runtime", () => {
    const client = new CodexAppServerClient();
    const registerNotification = client.onNotification.bind(client) as (
      method: string,
      handler?: unknown,
    ) => () => void;
    const registerServerRequest = client.onServerRequest.bind(client) as (
      method: string,
      handler?: unknown,
    ) => () => void;

    expect(() => registerNotification("turn/completed")).toThrow(
      "A notification handler is required when registering by method.",
    );
    expect(() => registerServerRequest("item/commandExecution/requestApproval")).toThrow(
      "A server-request handler is required when registering by method.",
    );
  });
});
