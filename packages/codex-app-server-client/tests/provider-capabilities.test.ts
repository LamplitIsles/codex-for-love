import { describe, expect, it } from "vitest";
import { AppServerProtocolValidationError, CodexAppServerClient } from "../src";
import { loadProtocolValidator } from "../src/protocol-validator";
import { FakeAppServer } from "./fake-app-server";

// Exact response captured from native 0.164.0; provenance is recorded in SOURCES.md.
const observed = { id: 2, result: { imageGeneration: true, webSearch: true } };
const method = "modelProvider/capabilities/read";

describe("provider capabilities across wire versions", () => {
  it("accepts the exact 0.164 response and historical namespaceTools booleans", async () => {
    const validator = await loadProtocolValidator();
    expect(() => validator.assertResponse(method, observed.result)).not.toThrow();
    for (const namespaceTools of [false, true]) {
      expect(() => validator.assertResponse(method, { ...observed.result, namespaceTools })).not.toThrow();
    }
    expect(() => validator.assertResponse(method, { imageGeneration: false, webSearch: false })).not.toThrow();
  });

  it("still requires both real booleans and validates namespaceTools when present", async () => {
    const validator = await loadProtocolValidator();
    for (const field of ["imageGeneration", "webSearch", "namespaceTools"]) {
      for (const invalid of [null, 0, "true"]) {
        expect(() => validator.assertResponse(method, { ...observed.result, [field]: invalid }))
          .toThrow(AppServerProtocolValidationError);
      }
    }
    for (const missing of [{ imageGeneration: true }, { webSearch: true }, {}]) {
      expect(() => validator.assertResponse(method, missing)).toThrow(AppServerProtocolValidationError);
    }
  });

  it("returns the unmodified two-field response through a strict typed call", async () => {
    const server = await FakeAppServer.listen((request, rpc) => {
      if (request.method === method) rpc.reply(request, observed.result);
    }, "codex/0.164.0");
    const client = new CodexAppServerClient({
      protocolValidation: "strict", transport: { type: "websocket", url: server.url },
    });
    try {
      await client.connect();
      const result = await client.call(method, {});
      expect(result).toEqual(observed.result);
      expect(result).not.toHaveProperty("namespaceTools");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
