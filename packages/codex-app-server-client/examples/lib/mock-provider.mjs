import { once } from "node:events";
import { createServer } from "node:http";

// A scripted loopback Responses provider. The Codex runtime is real; model output is not.
// No credentials, external model service, or successful tool execution is needed.
export async function startMockProvider(scenario, workspace) {
  const requests = [];
  const sockets = new Set();
  let responseIndex = 0;
  let holdNext = false;
  let finishHeld;
  const allowedModels = new Set(["mock-model"]);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end("Unexpected mock endpoint");
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      if (request.headers.authorization) throw new Error("Mock received an auth header");
      if (!allowedModels.has(body.model) || body.stream !== true) {
        throw new Error("Unexpected model or non-streaming mock request");
      }
      const index = responseIndex++;
      const id = `mock-${scenario}-${index}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id } });

      if (scenario === "approvals" && index === 0) {
        send({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "mock-declined-command",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "echo blocked > example-command-must-not-run.txt",
              workdir: workspace,
            }),
          },
        });
      } else {
        const parts = body.text?.format?.type === "json_schema"
          ? [JSON.stringify({ summary: "Scripted rollout plan", actions: ["Test", "Observe"] })]
          : scenario === "stream" ? ["Hello ", "from the local mock."]
          : scenario === "approvals" ? ["The command was declined."]
            : scenario === "interrupt-resume"
              ? index === 0 ? ["Starting a long answer..."] : ["Continued in the same thread."]
              : ["Scripted response ", String(index + 1), "."];
        const item = {
          type: "message", role: "assistant", id: `msg-${id}`,
          content: [{ type: "output_text", text: "" }],
        };
        send({ type: "response.output_item.added", item });
        for (const delta of parts) send({ type: "response.output_text.delta", delta });
        // Keep this response open until turn.interrupt() cancels the actual runtime request.
        if (scenario === "interrupt-resume" && index === 0) return;
        const finish = () => {
          if (response.destroyed || response.writableEnded) return;
          send({ type: "response.output_item.done",
            item: { ...item, content: [{ type: "output_text", text: parts.join("") }] } });
          send({ type: "response.completed",
            response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
          response.end();
        };
        if (holdNext) { holdNext = false; finishHeld = finish; return; }
        finish();
        return;
      }
      send({
        type: "response.completed",
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
      response.end();
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    allowModel(model) { allowedModels.add(model); },
    holdNext() { holdNext = true; },
    finishHeld() {
      if (!finishHeld) throw new Error("No active held response");
      const finish = finishHeld; finishHeld = undefined; finish();
    },
    async close() {
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // Node 18.0/18.1 do not have closeAllConnections(). Explicitly close idle and held SSE sockets.
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
