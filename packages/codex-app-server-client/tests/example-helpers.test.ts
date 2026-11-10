import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const exampleModule = (name: string) => import(new URL(`../examples/lib/${name}.mjs`, import.meta.url).href);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("official example catalog", () => {
  it("rejects aggregate smoke arguments before starting any mock or live example", () => {
    const script = fileURLToPath(new URL("../scripts/examples-smoke.mjs", import.meta.url));
    for (const flag of ["--live", "--interactive", "--unknown"]) {
      const result = spawnSync(process.execPath, [script, flag], { encoding: "utf8", timeout: 5_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("examples:smoke is mock-only and accepts no arguments");
      expect(result.stdout).toBe("");
    }
  });

  it("ships all 16 official groups and the 3 additional safety examples", async () => {
    const { officialExamples, smokeExamples } = await exampleModule("catalog");
    expect(officialExamples).toHaveLength(16);
    expect(smokeExamples).toHaveLength(19);
    expect(new Set(smokeExamples).size).toBe(19);
    officialExamples.forEach((name: string, index: number) => {
      expect(name.startsWith(String(index + 1).padStart(2, "0") + "_")).toBe(true);
    });
    for (const name of smokeExamples) {
      expect(existsSync(new URL(`../examples/${name}.mjs`, import.meta.url))).toBe(true);
    }
  });
});

describe("official model-selection heuristic", () => {
  const model = (id: string, extra = {}) => ({ id, model: id, hidden: false, upgrade: null,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], ...extra });

  it("excludes hidden and visibly superseded models and chooses the highest advertised effort", async () => {
    const { selectModel } = await exampleModule("model-selection");
    const selected = selectModel([
      model("z-old", { upgrade: "new-name" }),
      model("new-id", { model: "new-name", supportedReasoningEfforts: [
        { reasoningEffort: "ultra" }, { reasoningEffort: "low" }, { reasoningEffort: "xhigh" },
      ] }),
      model("zz-hidden", { hidden: true }),
    ]);
    expect(selected.model.id).toBe("new-id");
    expect(selected.effort).toBe("ultra");
  });

  it("uses the advertised id as a lexical tie-breaker, not an invented quality ranking", async () => {
    const { selectModel } = await exampleModule("model-selection");
    expect(selectModel([model("a", { model: "same" }), model("b", { model: "same" })]).model.id).toBe("b");
    expect(selectModel([model("visible", { upgrade: "hidden" }), model("hidden", { hidden: true })]).model.id)
      .toBe("visible");
    expect(() => selectModel([])).toThrow("No top-level visible model");
    expect(() => selectModel([model("a", { supportedReasoningEfforts: [] })])).toThrow("Missing or unknown");
    expect(() => selectModel([model("a", { supportedReasoningEfforts: [{ reasoningEffort: "future" }] })]))
      .toThrow("Missing or unknown");
  });

  it("collects all model pages and rejects a repeated cursor", async () => {
    const { listModels } = await exampleModule("model-selection");
    const modelList = vi.fn().mockResolvedValueOnce({ data: [model("a")], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [model("b")], nextCursor: null });
    expect(await listModels({ modelList })).toHaveLength(2);
    expect(modelList).toHaveBeenLastCalledWith({ includeHidden: true, limit: 100, cursor: "next" });
    await expect(listModels({ modelList: vi.fn().mockResolvedValue({ data: [], nextCursor: "again" }) }))
      .rejects.toThrow("Repeated model-list cursor");
  });
});

describe("example result handling", () => {
  const stream = (events: unknown[]) => ({ async *events() { yield* events; } });
  const completed = (status = "completed") => ({ method: "turn/completed",
    params: { turn: { status, error: status === "failed" ? { message: "model failed" } : null } } });
  const item = { method: "item/completed", params: { item: { type: "agentMessage", text: "fallback" } } };
  const quiet = () => { vi.spyOn(process.stdout, "write").mockReturnValue(true); vi.spyOn(console, "log").mockImplementation(() => {}); };

  it("uses completed-item text when no delta exists, without duplicating streamed text", async () => {
    quiet();
    const { streamResult } = await exampleModule("results");
    expect((await streamResult(stream([item, completed()]))).text).toBe("fallback");
    const onDelta = vi.fn();
    expect((await streamResult(stream([
      { method: "turn/started" }, { method: "item/agentMessage/delta", params: { delta: "streamed" } },
      item, completed(),
    ]), onDelta)).text).toBe("streamed");
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("streamed");
  });

  it("requires a terminal notification and exposes failure instead of printing success", async () => {
    quiet();
    const { streamResult, checkedResult } = await exampleModule("results");
    await expect(streamResult(stream([]))).rejects.toThrow("without turn/completed");
    await expect(streamResult(stream([completed("failed")]))).rejects.toThrow("model failed");
    await expect(streamResult(stream([completed("interrupted")]))).resolves.toMatchObject({ terminal: { status: "interrupted" } });
    expect(() => checkedResult({ turn: { status: "interrupted" } })).toThrow();
  });

  it("validates structured output and prints lossless large token counts", async () => {
    quiet();
    const { readStructured, printUsage } = await exampleModule("results");
    const result = (value: unknown) => ({ turn: { status: "completed" }, items: [], finalResponse: JSON.stringify(value) });
    expect(readStructured(result({ summary: "ok", actions: ["test"] }))).toEqual({ summary: "ok", actions: ["test"] });
    expect(() => readStructured(result({ summary: "ok", actions: [1] }))).toThrow();
    expect(() => readStructured(result({ summary: "ok", actions: [], unexpected: true }))).toThrow();
    printUsage({ last: { totalTokens: 9007199254740993n }, total: { totalTokens: 9007199254740993n } });
    expect(console.log).toHaveBeenCalledWith("usage.last:", '{"totalTokens":"9007199254740993"}');
  });

  it("subscribes before the action and cleans up even if the action rejects", async () => {
    const { observeDuring } = await exampleModule("results");
    const unsubscribe = vi.fn();
    let notify: (event: unknown) => void = () => {};
    const client = { onNotification(callback: typeof notify) { notify = callback; return unsubscribe; } };
    await expect(observeDuring(client, (event: unknown) => event === "done", async () => notify("done"))).resolves.toBe("done");
    await expect(observeDuring(client, () => false, async () => { throw new Error("action failed"); })).rejects.toThrow("action failed");
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});

describe("generated image fixture", () => {
  it("encodes a small RGB PNG and removes the local file when a callback fails", async () => {
    const { sampleImage, withSampleImage } = await exampleModule("sample-image");
    const png: Buffer = sampleImage();
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString()).toBe("IDAT");
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels).toHaveLength(32 * 97);
    expect([...pixels.subarray(1, 4)]).toEqual([40, 100, 220]);
    expect([...pixels.subarray(49, 52)]).toEqual([240, 180, 60]);
    let created = "";
    await expect(withSampleImage(async (path: string) => {
      created = path;
      expect(readFileSync(path)).toEqual(png);
      throw new Error("image turn failed");
    })).rejects.toThrow("image turn failed");
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });
});
