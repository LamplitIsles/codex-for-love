import { describe, expect, it } from "vitest";
import { AppServerProtocolValidationError, AppServerRpcError, CodexAppServerClient } from "../src";
import type { v2 } from "../src/generated/protocol";
import { loadProtocolValidator } from "../src/protocol-validator";
import schema from "../schemas/codex_app_server_protocol.v2.schemas.json" with { type: "json" };
import { FakeAppServer } from "./fake-app-server";

type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
const status: v2.UserVerificationStatusResponse = {
  credentialId: null, unavailableReason: "providerUnavailable", unavailableMessage: null,
};
const limits: v2.GetAccountRateLimitsResponse = {
  rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null,
    individualLimit: null, planType: null, rateLimitReachedType: null },
  rateLimitsByLimitId: null, rateLimitResetCredits: null,
};

describe("Codex 0.154 public protocol upgrade", () => {
  it("keeps newly omittable fields in existing and new types optional in public declarations", () => {
    const optional: [
      IsOptional<v2.BrowserUseRequirements, "allowWebmcp">,
      IsOptional<v2.ConfigRequirements, "application">,
      IsOptional<v2.GetAccountRateLimitsResponse, "ordinaryUsageAllowed">,
      IsOptional<v2.McpServerStatus, "toolsError">,
      IsOptional<v2.RateLimitSnapshot, "normalModelSlug">,
      IsOptional<v2.Thread, "environments">,
      IsOptional<v2.Thread, "originator">,
      IsOptional<v2.Thread, "daybreakEnabled">,
      IsOptional<v2.ApplicationRequirements, "network">,
      IsOptional<v2.UserVerificationStatusResponse, "credentialId">,
      IsOptional<v2.UserVerificationStatusResponse, "unavailableReason">,
      IsOptional<v2.UserVerificationStatusResponse, "unavailableMessage">,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true];
    expect(optional).toHaveLength(12);
    const definitions = schema.definitions as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    for (const [type, field] of [
      ["BrowserUseRequirements", "allowWebmcp"], ["ConfigRequirements", "application"],
      ["GetAccountRateLimitsResponse", "ordinaryUsageAllowed"], ["McpServerStatus", "toolsError"],
      ["RateLimitSnapshot", "normalModelSlug"], ["Thread", "environments"],
      ["Thread", "originator"], ["Thread", "daybreakEnabled"],
      ["ApplicationRequirements", "network"], ["UserVerificationStatusResponse", "credentialId"],
      ["UserVerificationStatusResponse", "unavailableReason"], ["UserVerificationStatusResponse", "unavailableMessage"],
    ]) {
      expect(definitions[type].properties).toHaveProperty(field);
      expect(definitions[type].required ?? []).not.toContain(field);
    }
  });

  it("preserves the new error envelope's int64 code and closed diagnostic data", () => {
    const error: v2.UserVerificationRpcError = { code: 9_007_199_254_740_993n, message: "fixture",
      data: { type: "unavailable", reason: "providerUnavailable" } };
    expect(schema.definitions.UserVerificationRpcError.properties.code.format).toBe("int64");
    const rpc = new AppServerRpcError(error);
    expect(rpc.code).toBe(error.code);
    expect(rpc.data).toEqual(error.data);
  });

  it("validates all four native-verification contracts without invoking a native provider", async () => {
    const validator = await loadProtocolValidator();
    for (const [method, params, response] of [
      ["userVerification/status", {}, status],
      ["userVerification/enroll", {}, { credentialId: "fixture" }],
      ["userVerification/delete", {}, {}],
      ["userVerification/verify", { challenge: "YQ", title: "Fixture", description: "Not a real prompt" },
        { proof: { credentialId: "fixture", signature: "fixture-signature" } }],
    ] as const) {
      expect(() => validator.assertClientRequest(method, params)).not.toThrow();
      expect(() => validator.assertResponse(method, response)).not.toThrow();
      expect(() => validator.assertClientRequest(method, undefined)).toThrow(AppServerProtocolValidationError);
    }
    expect(() => validator.assertResponse("userVerification/status", {})).not.toThrow();
    expect(() => validator.assertClientRequest("userVerification/verify", { challenge: "YQ" }))
      .toThrow(AppServerProtocolValidationError);
    expect(() => validator.assertResponse("userVerification/status", { ...status, unavailableReason: "unknown" }))
      .toThrow(AppServerProtocolValidationError);
    expect(() => validator.assertResponse("userVerification/verify", { proof: { credentialId: "fixture" } }))
      .toThrow(AppServerProtocolValidationError);
    // Schema checks shape, not challenge encoding, native readiness, or signature authenticity.
  });

  it("accepts old and capability-aware rate-limit reads without inventing recovery state", async () => {
    const validator = await loadProtocolValidator();
    for (const params of [undefined, null, {}, { supportsLunaReserve: false, excludeResetCreditDetails: true }]) {
      expect(() => validator.assertClientRequest("account/rateLimits/read", params)).not.toThrow();
    }
    expect(() => validator.assertClientRequest("account/rateLimits/read", { supportsLunaReserve: "yes" }))
      .toThrow(AppServerProtocolValidationError);
    expect(() => validator.assertResponse("account/rateLimits/read", limits)).not.toThrow();
    expect(limits).not.toHaveProperty("ordinaryUsageAllowed");
    expect(limits.rateLimits).not.toHaveProperty("normalModelSlug");
    for (const allowed of [null, false, true]) {
      expect(() => validator.assertResponse("account/rateLimits/read", {
        ...limits, ordinaryUsageAllowed: allowed, rateLimits: { ...limits.rateLimits, normalModelSlug: "model-alias" },
      })).not.toThrow();
    }
    expect(() => validator.assertResponse("account/rateLimits/read", { ...limits, ordinaryUsageAllowed: "yes" }))
      .toThrow(AppServerProtocolValidationError);
  });

  it("validates the new MCP verification variant and configuration item", async () => {
    const validator = await loadProtocolValidator();
    const request = { id: "elicitation", method: "mcpServer/elicitation/request", params: {
      threadId: "thread", turnId: null, serverName: "fixture", mode: "openai/userVerification",
      challenge: "YQ", title: "Fixture", description: "Not a real native prompt",
    } };
    expect(() => validator.assertServerRequest(request)).not.toThrow();
    expect(() => validator.assertServerRequest({ ...request, params: { ...request.params, challenge: 42 } }))
      .toThrow(AppServerProtocolValidationError);
    expect(() => validator.assertServerNotification({ method: "rawResponseItem/completed", params: {
      threadId: "thread", turnId: "turn", item: { type: "configuration_update", reasoning: { effort: "high" } },
    } })).not.toThrow();
  });

  it("supports typed raw calls for new methods and preserves the omitted-params call form", async () => {
    const server = await FakeAppServer.listen((message, rpc) => {
      const responses: Record<string, unknown> = {
        "userVerification/status": status,
        "userVerification/enroll": { credentialId: "fixture" },
        "userVerification/delete": {},
        "userVerification/verify": { proof: { credentialId: "fixture", signature: "fixture-signature" } },
        "account/rateLimits/read": limits,
      };
      if (message.method && message.method in responses) rpc.reply(message, responses[message.method]);
    }, "codex/0.154.0");
    const client = new CodexAppServerClient({ transport: { type: "websocket", url: server.url } });
    try {
      await client.connect();
      const readiness: v2.UserVerificationStatusResponse = await client.call("userVerification/status", {});
      expect(readiness).toEqual(status);
      expect(await client.call("userVerification/enroll", {})).toEqual({ credentialId: "fixture" });
      expect(await client.call("userVerification/delete", {})).toEqual({});
      const proof = await client.call("userVerification/verify", { challenge: "YQ", title: "Fixture", description: "Fixture" });
      expect(proof.proof.credentialId).toBe("fixture");
      expect(await client.call("account/rateLimits/read")).toEqual(limits);
      // JSON Schema also permits null; upstream TypeScript exposes the omitted/object forms.
      await client.request("account/rateLimits/read", null);
      await client.call("account/rateLimits/read", { excludeResetCreditDetails: true });
      const requests = server.messages.filter((message) => message.method === "account/rateLimits/read");
      expect(requests[0]).not.toHaveProperty("params");
      expect(requests[1].params).toBeNull();
      expect(requests[2].params).toEqual({ excludeResetCreditDetails: true });
    } finally { await client.close(); await server.close(); }
  });
});
