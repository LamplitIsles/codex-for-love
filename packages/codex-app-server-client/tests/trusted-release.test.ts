import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Repository-only JavaScript tooling has no public declaration.
import { packageName, repository, releaseInputs, validateContext, validateRun, validateJobs, validateEvidence, verifyArtifact, selectArtifact, validateRegistry, checkMain, npmMetadata, validateNewVersion } from "../scripts/trusted-release.mjs";
// @ts-expect-error Repository-only JavaScript tooling has no public declaration.
import { smokeOptions, verifyConsumerLock } from "../scripts/package-smoke-options.mjs";

const sha = "a".repeat(40);
const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
const expected = { version: "0.2.0", sha, integrity };
const env = { RELEASE_VERSION: expected.version, RELEASE_SHA: sha, RELEASE_INTEGRITY: integrity,
  CANDIDATE_RUN_ID: "123", GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GH_TOKEN: "test-read-token" };
const manifest = { name: packageName, version: expected.version, dependencies: { "@openai/codex": "0.154.0" },
  publishConfig: { registry: "https://registry.npmjs.org/", access: "public", tag: "latest" } };
const evidence = { name: packageName, version: expected.version, runtime: "0.154.0", sourceCommit: sha,
  sourceDirty: false, published: false, intendedTag: "latest", integrity,
  tarball: "jaminzhou-codex-app-server-client-0.2.0.tgz",
  verified: ["npm --ignore-scripts install", "pnpm --ignore-scripts install"] };
const run = { id: 123, repository: { full_name: repository }, head_repository: { full_name: repository },
  head_branch: "main", head_sha: sha, path: ".github/workflows/ci.yml", event: "push",
  status: "completed", conclusion: "success" };
const jobs = ["linux-check", "macos-package-smoke", "windows-package-smoke", "check"].map((name) => ({
  name, status: "completed", conclusion: "success",
}));
afterEach(() => vi.unstubAllGlobals());

describe("trusted release fail-closed policy", () => {
  it("accepts an explicit stable identity and canonical main manual dispatch", () => {
    expect(releaseInputs(env, true)).toEqual(expected);
    expect(() => validateContext(env, sha)).not.toThrow();
    expect(() => validateRun(run, sha, run.path, "push")).not.toThrow();
    expect(() => validateJobs(jobs)).not.toThrow();
    expect(() => validateEvidence(evidence, manifest, expected)).not.toThrow();
  });
  it.each([
    ["RELEASE_VERSION", "0.2.0-preview.0"], ["RELEASE_VERSION", "0.02.0"],
    ["RELEASE_VERSION", "$(touch bad)"], ["RELEASE_VERSION", "0.2.0\n"],
    ["RELEASE_SHA", "main"], ["RELEASE_SHA", "A".repeat(40)],
    ["RELEASE_INTEGRITY", "sha512-short"], ["CANDIDATE_RUN_ID", "-1"], ["CANDIDATE_RUN_ID", "123/evil"],
  ])("rejects invalid or injectable %s", (key, value) => {
    expect(() => releaseInputs({ ...env, [key]: value }, true)).toThrow();
  });
  it.each([
    ["GITHUB_REPOSITORY", "someone/fork"], ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_REF", "refs/heads/topic"],
    ["GITHUB_REF", "refs/tags/v0.2.0"], ["GITHUB_SHA", "b".repeat(40)],
  ])("rejects untrusted workflow context %s", (key, value) => {
    expect(() => validateContext({ ...env, [key]: value }, sha)).toThrow();
  });
  it.each([
    { head_sha: "b".repeat(40) }, { head_branch: "topic" }, { event: "pull_request" },
    { path: ".github/workflows/other.yml" }, { status: "in_progress" }, { conclusion: "cancelled" },
    { conclusion: "failure" }, { head_repository: { full_name: "someone/fork" } },
  ])("rejects stale, foreign, incomplete or failed run %j", (change) => {
    expect(() => validateRun({ ...run, ...change }, sha, run.path, "push")).toThrow();
  });
  it("does not treat skipped, missing or duplicated platform jobs as success", () => {
    expect(() => validateJobs(jobs.slice(1))).toThrow();
    expect(() => validateJobs([...jobs, jobs[0]])).toThrow();
    expect(() => validateJobs([{ ...jobs[0], conclusion: "skipped" }, ...jobs.slice(1)])).toThrow();
  });
  it.each([
    { sourceDirty: true }, { published: true }, { version: "0.1.0" }, { intendedTag: "next" },
    { sourceCommit: "b".repeat(40) }, { integrity: "different" }, { runtime: "0.153.4" },
    { tarball: "../../other.tgz" }, { verified: ["npm --ignore-scripts install"] },
  ])("rejects mismatched candidate evidence %j", (change) => {
    expect(() => validateEvidence({ ...evidence, ...change }, manifest, expected)).toThrow();
  });
  it("requires one retained, non-expired artifact from the selected run and SHA", () => {
    const artifact = { id: 456, name: "npm-candidate-0.2.0", expired: false,
      workflow_run: { id: 123, head_sha: sha, head_branch: "main" } };
    expect(selectArtifact([artifact], "123", sha, "0.2.0")).toBe(456);
    expect(() => selectArtifact([], "123", sha, "0.2.0")).toThrow();
    expect(() => selectArtifact([artifact, artifact], "123", sha, "0.2.0")).toThrow();
    expect(() => selectArtifact([{ ...artifact, expired: true }], "123", sha, "0.2.0")).toThrow();
    expect(() => selectArtifact([artifact], "124", sha, "0.2.0")).toThrow();
    expect(() => selectArtifact([artifact], "123", "b".repeat(40), "0.2.0")).toThrow();
  });
  it("requires exact registry identity, integrity and latest", () => {
    const metadata = { versions: { "0.2.0": { name: packageName, version: "0.2.0", dist: { integrity } } }, "dist-tags": { latest: "0.2.0" } };
    expect(() => validateRegistry(metadata, "0.2.0", integrity)).not.toThrow();
    expect(() => validateRegistry(metadata, "0.2.0", "wrong")).toThrow();
    expect(() => validateRegistry({ ...metadata, "dist-tags": { latest: "0.1.0" } }, "0.2.0", integrity)).toThrow();
    expect(() => validateRegistry(metadata, "0.3.0", integrity)).toThrow();
  });
  it("refuses to reuse a published version, downgrade latest or infer success from invalid tags", () => {
    const metadata = (latest: string) => ({ "dist-tags": { latest } });
    expect(() => validateNewVersion(null, metadata("0.1.0"), "0.2.0")).not.toThrow();
    expect(() => validateNewVersion({ version: "0.2.0" }, metadata("0.1.0"), "0.2.0")).toThrow("Version already exists");
    for (const latest of ["0.3.0", "0.2.1", "0.2.0", "0.2.0-preview.0", "1.0.0", "bad"]) {
      expect(() => validateNewVersion(null, metadata(latest), "0.2.0")).toThrow();
    }
  });
  it("only treats an exact-version registry 404 as absence, not authentication or service failures", async () => {
    const response = (status: number) => async () => new Response("{}", { status });
    await expect(npmMetadata("0.2.0", response(404))).resolves.toBeNull();
    await expect(npmMetadata(undefined, response(404))).rejects.toThrow();
    for (const status of [401, 403, 429, 500]) {
      await expect(npmMetadata("0.2.0", response(status))).rejects.toThrow();
    }
  });
  it("checks newest current-main CI, never falls back to an older successful run", async () => {
    const responses = [{ object: { sha } }, { workflow_runs: [run, { ...run, id: 124, status: "in_progress", conclusion: null }] }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })));
    await expect(checkMain(env)).rejects.toThrow("Run is not complete");
  });
  it("rejects moved main, API denial, absent CI and truncated jobs", async () => {
    for (const [responses, status] of [
      [[{ object: { sha: "b".repeat(40) } }], 200], [[{}], 403],
      [[{ object: { sha } }, { workflow_runs: [] }], 200],
      [[{ object: { sha } }, { workflow_runs: [run] }, { jobs, total_count: 101 }], 200],
    ] as const) {
      let index = 0;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses[index++]), { status })));
      await expect(checkMain(env)).rejects.toThrow();
    }
    const responses = [{ object: { sha } }, { workflow_runs: [run] }, { jobs, total_count: jobs.length }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })));
    await expect(checkMain(env)).resolves.toMatchObject({ version: "0.2.0", sha });
  });
  it("verifies an actual tar archive without executing its files and catches tampering", () => {
    const directory = mkdtempSync(join(tmpdir(), "trusted-release-test-"));
    try {
      const staging = join(directory, "staging");
      const candidate = join(directory, "candidate");
      mkdirSync(join(staging, "package"), { recursive: true });
      mkdirSync(candidate);
      writeFileSync(join(staging, "package/package.json"), JSON.stringify(manifest));
      const tarball = join(candidate, evidence.tarball);
      execFileSync("tar", ["-czf", tarball, "-C", staging, "package/package.json"]);
      const bytes = readFileSync(tarball);
      const actualIntegrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
      writeFileSync(join(candidate, "release-evidence.json"), JSON.stringify({ ...evidence, integrity: actualIntegrity,
        compressedBytes: bytes.length, files: ["package.json"] }));
      expect(verifyArtifact(candidate, { ...expected, integrity: actualIntegrity }).manifest).toEqual(manifest);
      expect(() => verifyArtifact(candidate, expected)).toThrow("Approved tarball bytes changed");
      writeFileSync(join(candidate, "extra"), "unexpected");
      expect(() => verifyArtifact(candidate, { ...expected, integrity: actualIntegrity })).toThrow("Unexpected candidate files");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("registry consumer verification", () => {
  it("preserves explicit local archive and default pack modes", () => {
    expect(smokeOptions([])).toEqual({ usePnpm: false, artifact: undefined });
    expect(smokeOptions(["package.tgz", "--pnpm"])).toEqual({ usePnpm: true, artifact: "package.tgz" });
    expect(smokeOptions(["--registry", "0.2.0", integrity, "--pnpm"])).toEqual({ usePnpm: true, registry: { version: "0.2.0", integrity } });
  });
  it.each([["--registry"], ["--registry", "latest", integrity], ["--registry", "0.2.0", "wrong"], ["--unknown"], ["a.tgz", "b.tgz"]])("rejects ambiguous smoke arguments %j", (...args) => {
    expect(() => smokeOptions(args)).toThrow();
  });
  it("verifies npm and pnpm exact registry lock entries", () => {
    const npmLock = (resolved: string) => JSON.stringify({ packages: { [`node_modules/${packageName}`]: { version: "0.2.0", integrity, resolved } } });
    expect(() => verifyConsumerLock(npmLock("https://registry.npmjs.org/package.tgz"), false, packageName, "0.2.0", integrity)).not.toThrow();
    expect(() => verifyConsumerLock(npmLock("file:local.tgz"), false, packageName, "0.2.0", integrity)).toThrow();
    const pnpmLock = `packages:\n\n  '${packageName}@0.2.0':\n    resolution: {integrity: ${integrity}}\n    engines: {node: '>=18'}\n\n  other@1.0.0:\n    resolution: {integrity: wrong}\n`;
    expect(() => verifyConsumerLock(pnpmLock, true, packageName, "0.2.0", integrity)).not.toThrow();
    expect(() => verifyConsumerLock(pnpmLock, true, packageName, "0.3.0", integrity)).toThrow();
    expect(() => verifyConsumerLock(pnpmLock, true, packageName, "0.2.0", "wrong")).toThrow();
  });
});

describe("release workflow security contracts", () => {
  const read = (name: string) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  it("has only manual triggers and immutable action revisions", () => {
    for (const name of ["npm-release-candidate", "npm-publish"]) {
      const workflow = read(name);
      expect(workflow).toContain("  workflow_dispatch:");
      expect(workflow).not.toMatch(/^  (push|pull_request|workflow_run|schedule):/m);
      const actions = [...workflow.matchAll(/uses: ([^\n]+)/g)];
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(action[1]).toMatch(/@[a-f0-9]{40} # v/);
      expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\./);
      expect(workflow).toContain("persist-credentials: false");
    }
  });
  it("isolates OIDC from preparation and all package execution", () => {
    expect(read("npm-release-candidate")).not.toContain("id-token: write");
    const workflow = read("npm-publish");
    const publisher = workflow.split("\n  publish:\n")[1].split("\n  registry-consumers:\n")[0];
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(publisher).toContain("environment: npm-publish");
    expect(publisher).toContain('npm publish "$TARBALL" --tag latest --access public --registry=https://registry.npmjs.org/ --ignore-scripts');
    expect(publisher).not.toMatch(/pnpm install|pnpm build|npm pack|package-smoke/);
    expect(workflow).not.toMatch(/secrets\.(NPM_TOKEN|NODE_AUTH_TOKEN)/);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('node scripts/package-smoke.mjs --registry "$RELEASE_VERSION" "$RELEASE_INTEGRITY" --pnpm');
  });
  it("reserves publish-job headroom for bounded read-back and earlier release steps", () => {
    const publisher = read("npm-publish").split("\n  publish:\n")[1].split("\n  registry-consumers:\n")[0];
    // Six attempts can each read metadata and a tarball for up to 30 seconds,
    // plus 67 seconds of backoff. The same job also performs setup and publishing.
    const timeoutMinutes = Number(publisher.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(timeoutMinutes).toBe(20);
    expect(timeoutMinutes * 60 - (6 * 2 * 30 + 67)).toBeGreaterThan(12 * 60);
  });
});
