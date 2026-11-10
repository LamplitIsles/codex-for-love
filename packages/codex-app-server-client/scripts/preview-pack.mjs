import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-exec.mjs";
import { candidateMode } from "./release-policy.mjs";
import { promoteCandidate } from "./promote-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mode = candidateMode(manifest, process.argv.slice(2));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceCommit = git(["rev-parse", "HEAD"]);
const sourceStatus = git(["status", "--porcelain"]);
const destination = join(root, "artifacts");
mkdirSync(destination, { recursive: true });
const staging = mkdtempSync(join(destination, "preparing-"));

try {
  const output = execNpmSync(["pack", "--json", "--pack-destination", staging], {
    cwd: root, encoding: "utf8", timeout: 120_000,
  });
  const match = [...output.matchAll(/(?:^|\n)(\[\s*\{\s*"id"\s*:)/g)].at(-1);
  if (!match) throw new Error("npm pack did not emit a manifest");
  const [artifact] = JSON.parse(output.slice(match.index + (output[match.index] === "\n" ? 1 : 0)));
  const allowed = /^(dist\/|schemas\/|examples\/|docs\/|THIRD_PARTY_LICENSES\/|(?:package\.json|README\.md|LICENSE|CHANGELOG\.md|COMPATIBILITY\.md|CONTRIBUTING\.md|SOURCES\.md|THIRD_PARTY_NOTICES\.md|RELEASING\.md)$)/;
  for (const file of artifact.files) {
    if (!allowed.test(file.path)) throw new Error("Unexpected published file: " + file.path);
  }
  const tarball = join(staging, artifact.filename);
  // Verify these exact bytes with both consumer package managers. This never publishes.
  for (const args of [[], ["--pnpm"]]) {
    execFileSync(process.execPath, [join(root, "scripts/package-smoke.mjs"), tarball, ...args], {
      cwd: root, stdio: "inherit", timeout: 240_000,
    });
  }
  if (git(["rev-parse", "HEAD"]) !== sourceCommit || git(["status", "--porcelain"]) !== sourceStatus) {
    throw new Error("Checkout changed during preparation; regenerate from the intended source commit.");
  }
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64");
  if (integrity !== artifact.integrity) throw new Error("Packed artifact integrity changed during verification.");
  const evidence = {
    name: manifest.name,
    version: manifest.version,
    runtime: manifest.dependencies["@openai/codex"],
    sourceCommit,
    sourceDirty: sourceStatus !== "",
    tarball: artifact.filename,
    integrity,
    compressedBytes: artifact.size,
    unpackedBytes: artifact.unpackedSize,
    files: artifact.files.map((file) => file.path),
    verifiedAt: new Date().toISOString(),
    node: process.versions.node,
    verified: ["npm --ignore-scripts install", "pnpm --ignore-scripts install", "ESM and protocol exports", "strict TypeScript consumer", "real app-server startup", "19 shipped examples (18 real-runtime provider fixtures, 1 login RPC fixture)", "4 mini CLI input cases"],
    published: false,
    intendedTag: manifest.publishConfig.tag,
  };
  const finalTarball = join(destination, artifact.filename);
  const stagedEvidence = join(staging, `${mode}-evidence.json`);
  writeFileSync(stagedEvidence, JSON.stringify(evidence, null, 2) + "\n");
  promoteCandidate(tarball, stagedEvidence, finalTarball, join(destination, `${mode}-evidence.json`));
  console.log(`Verified ${mode} candidate: ` + finalTarball + "\nIntegrity: " + integrity + "\nNo registry publication was performed.");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
