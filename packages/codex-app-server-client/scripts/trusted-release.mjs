import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { candidateMode } from "./release-policy.mjs";

export const repository = "JaminZhou/codex-app-server-client";
export const packageName = "@jaminzhou/codex-app-server-client";
export const registry = "https://registry.npmjs.org/";
const versionPattern = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const ciJobs = ["linux-check", "macos-package-smoke", "windows-package-smoke", "check"];
const registryReadDelays = [2_000, 5_000, 10_000, 20_000, 30_000];

class RegistryVisibilityError extends Error {}
const otherTags = ({ latest, ...others }) => others;

export function releaseInputs(env, needsArtifact = false) {
  assert.match(env.RELEASE_VERSION ?? "", versionPattern, "An exact non-preview 0.x.y version is required");
  assert.match(env.RELEASE_SHA ?? "", shaPattern, "A full source SHA is required");
  if (needsArtifact) {
    assert.match(env.RELEASE_INTEGRITY ?? "", integrityPattern, "An approved SHA-512 integrity is required");
    assert.match(env.CANDIDATE_RUN_ID ?? "", /^[1-9]\d*$/, "A candidate run ID is required");
  }
  return { version: env.RELEASE_VERSION, sha: env.RELEASE_SHA, integrity: env.RELEASE_INTEGRITY };
}

export function validateContext(env, sha) {
  assert.equal(env.GITHUB_REPOSITORY, repository, "Only the canonical repository may release");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Only manual dispatch may release");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Only main may release");
  assert.equal(env.GITHUB_SHA, sha, "Candidate and workflow revisions must match");
}

export function validateRun(run, sha, path, event) {
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, sha);
  assert.equal(run.path, path);
  assert.equal(run.event, event);
  assert.equal(run.status, "completed", "Run is not complete");
  assert.equal(run.conclusion, "success", "Run did not pass");
}

export function validateJobs(jobs) {
  for (const name of ciJobs) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, "Missing or ambiguous CI job: " + name);
    assert.equal(matches[0].status, "completed");
    assert.equal(matches[0].conclusion, "success", "CI job did not pass: " + name);
  }
}

export function validateEvidence(evidence, manifest, expected) {
  candidateMode(manifest, ["--release"]);
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, expected.version);
  assert.equal(evidence.name, packageName);
  assert.equal(evidence.version, expected.version);
  assert.equal(evidence.sourceCommit, expected.sha);
  assert.equal(evidence.sourceDirty, false);
  assert.equal(evidence.published, false, "Preparation evidence must remain unpublished");
  assert.equal(evidence.intendedTag, "latest");
  assert.equal(evidence.integrity, expected.integrity);
  assert.equal(evidence.runtime, manifest.dependencies?.["@openai/codex"]);
  assert.equal(evidence.tarball, `jaminzhou-codex-app-server-client-${expected.version}.tgz`);
  assert.ok(evidence.verified?.includes("npm --ignore-scripts install"));
  assert.ok(evidence.verified?.includes("pnpm --ignore-scripts install"));
}

export function verifyArtifact(directory, expected) {
  const filename = `jaminzhou-codex-app-server-client-${expected.version}.tgz`;
  assert.deepEqual(readdirSync(directory).sort(), [filename, "release-evidence.json"].sort(), "Unexpected candidate files");
  for (const name of [filename, "release-evidence.json"]) {
    assert.ok(lstatSync(join(directory, name)).isFile(), "Candidate must contain regular files only");
  }
  const tarball = resolve(directory, filename);
  const bytes = readFileSync(tarball);
  assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), expected.integrity, "Approved tarball bytes changed");
  // Inspect without extracting or executing anything from the package in the OIDC job.
  const tar = (args) => execFileSync("tar", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const names = tar(["-tzf", tarball]).trim().split("\n");
  const details = tar(["-tvzf", tarball]).trim().split("\n");
  assert.ok(details.every((line) => line.startsWith("-")), "Archive links and special entries are forbidden");
  assert.equal(new Set(names).size, names.length, "Duplicate archive entries");
  assert.ok(names.every((name) => /^package\/[A-Za-z0-9_./-]+$/.test(name)
    && !name.split("/").some((part) => part === ".." || part === "." || part === "")), "Unsafe archive path");
  const manifest = JSON.parse(tar(["-xOzf", tarball, "package/package.json"]));
  const evidence = JSON.parse(readFileSync(join(directory, "release-evidence.json"), "utf8"));
  validateEvidence(evidence, manifest, expected);
  assert.equal(evidence.compressedBytes, bytes.length);
  assert.deepEqual([...evidence.files].sort(), names.map((name) => name.slice(8)).sort());
  return { tarball, evidence, manifest };
}

async function github(path, env) {
  assert.ok(env.GH_TOKEN, "GitHub read token is required");
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  assert.equal(response.status, 200, "GitHub read failed for " + path);
  return response.json();
}

export async function checkMain(env) {
  const expected = releaseInputs(env);
  validateContext(env, expected.sha);
  const main = await github("git/ref/heads/main", env);
  assert.equal(main.object.sha, expected.sha, "Main moved; prepare and approve a new candidate");
  const runs = await github(`actions/workflows/ci.yml/runs?head_sha=${expected.sha}&branch=main&event=push&per_page=100`, env);
  assert.ok(runs.workflow_runs?.length, "No current-commit main CI run");
  // A newer failed, cancelled, queued or in-progress run must not be hidden by older green evidence.
  const run = [...runs.workflow_runs].sort((a, b) => b.id - a.id)[0];
  validateRun(run, expected.sha, ".github/workflows/ci.yml", "push");
  const { jobs, total_count: count } = await github(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`, env);
  assert.equal(count, jobs.length, "CI jobs are truncated");
  validateJobs(jobs);
  return expected;
}

export function selectArtifact(artifacts, runId, sha, version) {
  const matches = artifacts.filter((artifact) => artifact.name === `npm-candidate-${version}`);
  assert.equal(matches.length, 1, "Missing or ambiguous candidate artifact");
  const artifact = matches[0];
  assert.equal(artifact.expired, false, "Candidate expired; do not rebuild silently");
  assert.equal(String(artifact.workflow_run?.id), String(runId));
  assert.equal(artifact.workflow_run?.head_sha, sha);
  assert.equal(artifact.workflow_run?.head_branch, "main");
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  return artifact.id;
}

export async function npmMetadata(version, fetcher = fetch) {
  const response = await fetcher(registry + encodeURIComponent(packageName) + (version ? "/" + version : ""), {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (response.status === 404 && version) return null;
  assert.equal(response.status, 200, "Registry response cannot establish release state");
  return response.json();
}

export function validateNewVersion(existing, metadata, version) {
  assert.match(version, versionPattern);
  assert.equal(existing, null, "Version already exists; read back, never republish");
  const latest = metadata["dist-tags"]?.latest;
  assert.match(latest ?? "", versionPattern, "Inspect unexpected latest tag manually");
  const [minor, patch] = version.split(".").slice(1).map(BigInt);
  const [oldMinor, oldPatch] = latest.split(".").slice(1).map(BigInt);
  assert.ok(minor > oldMinor || (minor === oldMinor && patch > oldPatch), "Refuse latest downgrade or reuse");
}

function validateRegistryEntry(metadata, version, integrity) {
  const entry = metadata.versions?.[version];
  assert.equal(entry?.name, packageName);
  assert.equal(entry?.version, version);
  assert.equal(entry?.dist?.integrity, integrity, "Registry bytes differ from approved bytes");
  return entry;
}

export function validateRegistry(metadata, version, integrity) {
  const entry = validateRegistryEntry(metadata, version, integrity);
  assert.equal(metadata["dist-tags"]?.latest, version, "latest does not identify this release");
  return entry;
}

// Retry only publication visibility lag, never a registry write or a safety mismatch.
// At most 67 seconds of backoff plus twelve 30-second HTTP reads.
// Publication itself is never retried.
export async function readPublishedRegistry(expected, manifest, before, {
  fetcher = fetch, sleep = delay, onRetry = (message) => console.warn(message),
} = {}) {
  assert.match(before.latest ?? "", versionPattern, "Invalid pre-publication latest tag");
  const freshRead = (url, options) => fetcher(url, {
    ...options, method: "GET", headers: { ...options.headers, "Cache-Control": "no-cache" },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const metadata = await npmMetadata(undefined, freshRead);
      assert.ok(metadata?.versions && typeof metadata.versions === "object"
        && !Array.isArray(metadata.versions), "Invalid registry version metadata");
      const tags = metadata["dist-tags"];
      assert.ok(tags && typeof tags === "object" && !Array.isArray(tags), "Invalid registry tags");
      assert.deepEqual(otherTags(tags), otherTags(before), "Unrelated registry tags changed");
      assert.ok(tags.latest === before.latest || tags.latest === expected.version,
        "Unexpected latest tag; inspect the registry before retrying publication");
      if (metadata.versions[expected.version] === undefined) {
        throw new RegistryVisibilityError("The new version is not visible in registry metadata yet");
      }
      // Check immutable identity and safety constraints even when latest is still stale.
      const entry = validateRegistryEntry(metadata, expected.version, expected.integrity);
      assert.deepEqual(entry.dependencies, manifest.dependencies);
      const url = new URL(entry.dist.tarball);
      assert.equal(url.origin, new URL(registry).origin, "Unexpected registry tarball host");
      if (tags.latest !== expected.version) {
        throw new RegistryVisibilityError("latest still identifies the pre-publication version");
      }
      const response = await freshRead(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new RegistryVisibilityError("The published tarball is not visible yet");
      }
      assert.equal(response.status, 200, "Registry tarball read failed");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), expected.integrity,
        "Downloaded registry bytes differ from approved bytes");
      return { metadata, entry, bytes };
    } catch (error) {
      if (!(error instanceof RegistryVisibilityError)) throw error;
      if (attempt === registryReadDelays.length) {
        throw new Error(`Registry publication is still not visible after ${attempt + 1} read attempts; `
          + "it may already be published. Inspect npm before any publish retry.", { cause: error });
      }
      const waitMs = registryReadDelays[attempt];
      onRetry(`Registry read attempt ${attempt + 1}: ${error.message}. Retrying GETs in ${waitMs}ms; not republishing.`);
      await sleep(waitMs);
    }
  }
}

export async function main(command, env = process.env) {
  const expected = releaseInputs(env, ["select", "artifact", "after"].includes(command));
  const output = (key, value) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`); };
  if (command === "gate") {
    await checkMain(env);
  } else if (command === "select") {
    await checkMain(env);
    const run = await github(`actions/runs/${env.CANDIDATE_RUN_ID}`, env);
    validateRun(run, expected.sha, ".github/workflows/npm-release-candidate.yml", "workflow_dispatch");
    const list = await github(`actions/runs/${env.CANDIDATE_RUN_ID}/artifacts?per_page=100`, env);
    assert.equal(list.total_count, list.artifacts.length, "Artifact list is truncated");
    output("artifact_id", selectArtifact(list.artifacts, env.CANDIDATE_RUN_ID, expected.sha, expected.version));
  } else if (command === "artifact") {
    const result = verifyArtifact(env.CANDIDATE_DIRECTORY ?? "candidate", expected);
    output("tarball", result.tarball);
    console.log(JSON.stringify({ version: expected.version, sourceCommit: expected.sha, integrity: expected.integrity, verified: true }));
  } else if (command === "before") {
    const existing = await npmMetadata(expected.version);
    const metadata = await npmMetadata();
    validateNewVersion(existing, metadata, expected.version);
    mkdirSync("artifacts", { recursive: true });
    writeFileSync("artifacts/registry-before.json", JSON.stringify(metadata["dist-tags"], null, 2) + "\n");
  } else if (command === "after") {
    const { manifest } = verifyArtifact(env.CANDIDATE_DIRECTORY ?? "candidate", expected);
    const before = JSON.parse(readFileSync("artifacts/registry-before.json", "utf8"));
    const { metadata, entry, bytes } = await readPublishedRegistry(expected, manifest, before);
    const receipt = { name: packageName, version: expected.version, sourceCommit: expected.sha,
      integrity: expected.integrity, distTags: metadata["dist-tags"], publishedAt: metadata.time?.[expected.version],
      verifiedAt: new Date().toISOString(), tarball: entry.dist.tarball, bytes: bytes.length,
      registryVerified: true, consumerVerified: false };
    writeFileSync("artifacts/publication.json", JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } else {
    throw new Error("Usage: trusted-release.mjs gate|select|artifact|before|after");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2]);
}
