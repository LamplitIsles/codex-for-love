import { Server } from "node:http";
import { describe, expect, it } from "vitest";

describe("shipped mock provider", () => {
  it("closes a held SSE connection without the Node 18.2 closeAllConnections API", async () => {
    const moduleUrl = new URL("../examples/lib/mock-provider.mjs", import.meta.url).href;
    const { startMockProvider } = await import(moduleUrl);
    const descriptor = Object.getOwnPropertyDescriptor(Server.prototype, "closeAllConnections");
    Reflect.deleteProperty(Server.prototype, "closeAllConnections");
    let provider: Awaited<ReturnType<typeof startMockProvider>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      provider = await startMockProvider("interrupt-resume", process.cwd());
      const response = await fetch(`${provider.origin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-model", stream: true, input: [] }),
      });
      reader = response.body?.getReader();
      let streamedText = "";
      while (reader && !streamedText.includes("response.output_text.delta")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamedText += new TextDecoder().decode(chunk.value);
      }
      expect(streamedText).toContain("response.output_text.delta");
      // This response intentionally never completes: cleanup must close its live socket.
      await provider.close();
    } finally {
      try {
        await reader?.cancel().catch(() => {});
        await provider?.close();
      } finally {
        if (descriptor) Object.defineProperty(Server.prototype, "closeAllConnections", descriptor);
      }
    }
  }, 5_000);
});
