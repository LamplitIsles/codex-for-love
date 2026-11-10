import { describe, expect, it, vi } from "vitest";
import {
  AppServerConnectionClosedError,
  AppServerRequestTimeoutError,
  CodexAppServerClient,
} from "../src";
import { FakeAppServer } from "./fake-app-server";

describe("account and login workflows", () => {
  it("provides typed login handles and preserves early completion notifications", async () => {
    const server = await FakeAppServer.listen((message, appServer) => {
      switch (message.method) {
        case "account/login/start": {
          const type = message.params?.type;
          if (type === "chatgpt") {
            appServer.notify("account/login/completed", {
              loginId: "login-browser",
              success: true,
              error: null,
            });
            appServer.reply(message, {
              type: "chatgpt",
              loginId: "login-browser",
              authUrl: "https://auth.example/browser",
            });
          } else if (type === "chatgptDeviceCode") {
            appServer.reply(message, {
              type: "chatgptDeviceCode",
              loginId: "login-device",
              verificationUrl: "https://auth.example/device",
              userCode: "ABCD-EFGH",
            });
          } else {
            appServer.reply(message, { type });
          }
          break;
        }
        case "account/login/cancel":
          appServer.reply(message, { status: "canceled" });
          break;
        case "account/read":
          appServer.reply(message, {
            account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
            requiresOpenaiAuth: true,
          });
          break;
        case "account/logout":
          appServer.reply(message, {});
          break;
      }
    });
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });

    try {
      await client.connect();
      const browser = await client.loginChatGPT({ codexStreamlinedLogin: true });
      expect(browser).toMatchObject({
        authUrl: "https://auth.example/browser",
        loginId: "login-browser",
      });
      await expect(browser.wait()).resolves.toEqual({
        error: null,
        loginId: "login-browser",
        success: true,
      });
      await expect(browser.cancel()).resolves.toEqual({ status: "canceled" });

      const device = await client.loginChatGPTDeviceCode();
      expect(device).toMatchObject({
        loginId: "login-device",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.example/device",
      });

      await client.loginApiKey("sk-test");
      await client.loginChatGPTAuthTokens({
        accessToken: "header.payload.signature",
        chatgptAccountId: "workspace-1",
        chatgptPlanType: "pro",
      });
      await expect(client.account(true)).resolves.toEqual({
        account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      });
      await expect(client.logout()).resolves.toBeUndefined();

      const loginPayloads = server.messages
        .filter((message) => message.method === "account/login/start")
        .map((message) => message.params);
      expect(loginPayloads).toEqual([
        { type: "chatgpt", codexStreamlinedLogin: true },
        { type: "chatgptDeviceCode" },
        { type: "apiKey", apiKey: "sk-test" },
        {
          type: "chatgptAuthTokens",
          accessToken: "header.payload.signature",
          chatgptAccountId: "workspace-1",
          chatgptPlanType: "pro",
        },
      ]);
      expect(
        server.messages.find((message) => message.method === "account/read")?.params,
      ).toEqual({ refreshToken: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("times out bounded waits and fails live login handles on disconnect", async () => {
    const server = await FakeAppServer.listen((message, appServer) => {
      if (message.method === "account/login/start") {
        appServer.reply(message, {
          type: "chatgptDeviceCode",
          loginId: "login-pending",
          verificationUrl: "https://auth.example/device",
          userCode: "PENDING",
        });
      }
    });
    const observed: Error[] = [];
    const client = new CodexAppServerClient({
      transport: { type: "websocket", url: server.url },
    });
    client.onError((error) => observed.push(error));

    await client.connect();
    const login = await client.loginChatGPTDeviceCode();
    await expect(login.wait({ timeoutMs: 5 })).rejects.toBeInstanceOf(
      AppServerRequestTimeoutError,
    );
    const waiting = login.wait();
    server.terminateConnection();
    await expect(waiting).rejects.toBeInstanceOf(AppServerConnectionClosedError);
    await vi.waitFor(() => expect(client.state).toBe("disconnected"));
    expect(observed).toHaveLength(1);
    await client.close();
    await server.close();
  });
});
