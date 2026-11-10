import { describe, expect, expectTypeOf, it } from "vitest";
import { CodexAppServerClient } from "../src";
import type {
  GetAccountTokenUsageResponse,
} from "../src/generated/protocol/v2/GetAccountTokenUsageResponse";
import type { ThreadListResponse } from "../src/generated/protocol/v2/ThreadListResponse";

describe("typed handler registration", () => {
  it("infers generated notification params and server-request responses", () => {
    const client = new CodexAppServerClient();
    const notifications: string[] = [];
    const removeNotification = client.onNotification("turn/completed", (params, notification) => {
      notifications.push(params.turn.id);
      expectTypeOf(notification.emittedAtMs).toEqualTypeOf<number | undefined>();
    });
    const removeApproval = client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        void params.command;
        return { decision: "accept" };
      },
    );

    expect(notifications).toEqual([]);
    removeNotification();
    removeApproval();
  });
});

function typecheckCompleteRequestMap(client: CodexAppServerClient) {
  expectTypeOf(client.call("thread/list", { limit: 1 })).toEqualTypeOf<
    Promise<ThreadListResponse>
  >();
  void client.call("account/logout");
  expectTypeOf(client.call("account/usage/read")).toEqualTypeOf<
    Promise<GetAccountTokenUsageResponse>
  >();
  void client.call("account/usage/read", { threadId: "thread-1" });
  void client.call("remoteControl/enable", null);
}

void typecheckCompleteRequestMap;
