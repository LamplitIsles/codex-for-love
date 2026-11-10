import { describe, expect, it, vi } from "vitest";
import {
  AppServerBusyError,
  AppServerInvalidParamsError,
  retryOnAppServerOverload,
} from "../src";

describe("retryOnAppServerOverload", () => {
  it("retries transient overload errors with bounded exponential backoff", async () => {
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(
        new AppServerBusyError({ code: -32000, message: "busy", data: "server_overloaded" }),
      )
      .mockResolvedValue("ok");

    await expect(
      retryOnAppServerOverload(operation, { initialDelayMs: 0, random: () => 0.5 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });

  it("does not retry non-transient errors", async () => {
    const error = new AppServerInvalidParamsError({ code: -32602, message: "bad" });
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryOnAppServerOverload(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
