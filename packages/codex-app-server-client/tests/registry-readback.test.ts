import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
// @ts-expect-error Repository-only JavaScript tooling has no public declaration.
import { packageName, readPublishedRegistry } from "../scripts/trusted-release.mjs";

const bytes = Buffer.from("the approved registry archive");
const expected = { version: "0.2.0", sha: "a".repeat(40),
  integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
const manifest = { name: packageName, version: expected.version, dependencies: { "@openai/codex": "0.154.0" } };
const before = { latest: "0.1.0", next: "0.1.0-preview.0" };
const tarball = "https://registry.npmjs.org/@jaminzhou/codex-app-server-client/-/codex-app-server-client-0.2.0.tgz";
const metadataUrl = "https://registry.npmjs.org/" + encodeURIComponent(packageName);
const visible = (latest = expected.version) => ({
  versions: { [expected.version]: { ...manifest, dependencies: { ...manifest.dependencies },
    dist: { integrity: expected.integrity, tarball } } },
  "dist-tags": { ...before, latest },
});
const missing = () => ({ versions: {}, "dist-tags": { ...before } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function readers(...responses: Response[]) {
  const fetcher = vi.fn(async (_url: string | URL, _options: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra registry read");
    return response;
  });
  return { fetcher, sleep: vi.fn(async (_ms: number) => {}), onRetry: vi.fn() };
}

function expectOnlyReads(options: ReturnType<typeof readers>) {
  for (const [url, request] of options.fetcher.mock.calls) {
    expect([metadataUrl, tarball]).toContain(String(url));
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.headers).toMatchObject({ "Cache-Control": "no-cache" });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.body).toBeUndefined();
  }
}

describe("bounded, read-only post-publication verification", () => {
  it("returns fully verified metadata and bytes immediately when already visible", async () => {
    const metadata = visible();
    const options = readers(json(metadata), new Response(bytes));
    const result = await readPublishedRegistry(expected, manifest, before, options);
    expect(result.metadata).toEqual(metadata);
    expect(result.entry).toEqual(metadata.versions[expected.version]);
    expect(result.bytes).toEqual(bytes);
    expect(options.fetcher).toHaveBeenCalledTimes(2);
    expect(options.sleep).not.toHaveBeenCalled();
    expect(options.onRetry).not.toHaveBeenCalled();
    expectOnlyReads(options);
  });

  it("recovers from the observed missing-version metadata race without republishing", async () => {
    const options = readers(json(missing()), json(missing()), json(visible()), new Response(bytes));
    await expect(readPublishedRegistry(expected, manifest, before, options)).resolves.toMatchObject({ bytes });
    expect(options.sleep.mock.calls).toEqual([[2_000], [5_000]]);
    expect(options.onRetry).toHaveBeenCalledTimes(2);
    expect(options.onRetry.mock.calls[0][0]).toContain("not republishing");
    expect(options.fetcher).toHaveBeenCalledTimes(4);
    expectOnlyReads(options);
  });

  it("waits only for the exact pre-publication latest value, then downloads the archive", async () => {
    const options = readers(json(visible(before.latest)), json(visible()), new Response(bytes));
    await expect(readPublishedRegistry(expected, manifest, before, options)).resolves.toMatchObject({ bytes });
    expect(options.fetcher.mock.calls.map(([url]) => String(url))).toEqual([metadataUrl, metadataUrl, tarball]);
    expect(options.sleep.mock.calls).toEqual([[2_000]]);
  });

  it("shares one retry budget across missing metadata, a stale tag and a tarball 404", async () => {
    const options = readers(json(missing()), json(visible(before.latest)), json(visible()),
      new Response(null, { status: 404 }), json(visible()), new Response(bytes));
    await expect(readPublishedRegistry(expected, manifest, before, options)).resolves.toMatchObject({ bytes });
    expect(options.sleep.mock.calls).toEqual([[2_000], [5_000], [10_000]]);
    expect(options.fetcher).toHaveBeenCalledTimes(6);
    expectOnlyReads(options);
  });

  it("closes a tarball 404 body before the next read attempt", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("not visible yet")); },
      cancel,
    });
    const options = readers(json(visible()), new Response(body, { status: 404 }), json(visible()), new Response(bytes));
    await expect(readPublishedRegistry(expected, manifest, before, options)).resolves.toMatchObject({ bytes });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(options.sleep.mock.calls).toEqual([[2_000]]);
  });

  it.each(["version", "latest", "tarball"])("stops after six attempts when %s never becomes visible", async (kind) => {
    const responses = Array.from({ length: 6 }, () => kind === "version" ? [json(missing())]
      : kind === "latest" ? [json(visible(before.latest))]
        : [json(visible()), new Response(null, { status: 404 })]).flat();
    const options = readers(...responses);
    await expect(readPublishedRegistry(expected, manifest, before, options))
      .rejects.toThrow("after 6 read attempts; it may already be published");
    expect(options.fetcher).toHaveBeenCalledTimes(kind === "tarball" ? 12 : 6);
    expect(options.sleep.mock.calls).toEqual([[2_000], [5_000], [10_000], [20_000], [30_000]]);
    expect(options.onRetry).toHaveBeenCalledTimes(5);
    expectOnlyReads(options);
  });

  it.each([
    ["name", (m: ReturnType<typeof visible>) => { m.versions[expected.version].name = "wrong-package"; }],
    ["version", (m: ReturnType<typeof visible>) => { m.versions[expected.version].version = "0.3.0"; }],
    ["integrity", (m: ReturnType<typeof visible>) => { m.versions[expected.version].dist.integrity = "wrong"; }],
    ["dependencies", (m: ReturnType<typeof visible>) => { m.versions[expected.version].dependencies["@openai/codex"] = "0.153.4"; }],
    ["other tags", (m: ReturnType<typeof visible>) => { m["dist-tags"].next = "0.2.0"; }],
    ["third latest", (m: ReturnType<typeof visible>) => { m["dist-tags"].latest = "0.3.0"; }],
    ["tarball host", (m: ReturnType<typeof visible>) => { m.versions[expected.version].dist.tarball = "https://example.com/package.tgz"; }],
  ] as const)("fails immediately on a %s mismatch, even with a stale latest tag", async (_name, mutate) => {
    const metadata = visible(before.latest);
    mutate(metadata);
    const options = readers(json(metadata));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow();
    expect(options.fetcher).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it("does not hide an integrity mismatch behind an earlier visibility retry", async () => {
    const mismatch = visible(before.latest);
    mismatch.versions[expected.version].dist.integrity = "wrong";
    const options = readers(json(missing()), json(mismatch));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow("Registry bytes differ");
    expect(options.fetcher).toHaveBeenCalledTimes(2);
    expect(options.sleep.mock.calls).toEqual([[2_000]]);
  });

  it("rejects changed downloaded bytes without a retry", async () => {
    const options = readers(json(visible()), new Response("different archive"));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow("Downloaded registry bytes differ");
    expect(options.fetcher).toHaveBeenCalledTimes(2);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])("does not retry metadata HTTP %s", async (status) => {
    const options = readers(new Response(null, { status }));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow("Registry response");
    expect(options.fetcher).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("does not retry tarball HTTP %s", async (status) => {
    const options = readers(json(visible()), new Response(null, { status }));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow("Registry tarball read failed");
    expect(options.fetcher).toHaveBeenCalledTimes(2);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it.each([{}, { ...visible(), versions: null }, { ...visible(), versions: [] },
    { ...visible(), "dist-tags": null }, { ...visible(), "dist-tags": [] },
    { ...visible(), versions: { [expected.version]: null } },
    { ...visible(), "dist-tags": { next: before.next } },
  ])("fails closed on malformed metadata %#", async (metadata) => {
    const options = readers(json(metadata));
    await expect(readPublishedRegistry(expected, manifest, before, options)).rejects.toThrow();
    expect(options.fetcher).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it("does not retry invalid JSON or a network error", async () => {
    const invalid = readers(new Response("not JSON"));
    await expect(readPublishedRegistry(expected, manifest, before, invalid)).rejects.toThrow();
    expect(invalid.sleep).not.toHaveBeenCalled();
    const offline = readers();
    offline.fetcher.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(readPublishedRegistry(expected, manifest, before, offline)).rejects.toThrow("fetch failed");
    expect(offline.fetcher).toHaveBeenCalledTimes(1);
    expect(offline.sleep).not.toHaveBeenCalled();
  });
});
