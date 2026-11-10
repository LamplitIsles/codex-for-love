import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-exec.mjs";
import { parseProtocolMethodMap } from "./protocol-method-map.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pinnedMethodMetadata = JSON.parse(
  readFileSync(join(root, "protocol-methods.json"), "utf8"),
);
const pinnedVersion = packageJson.dependencies?.["@openai/codex"];

assertStableVersion("pinned", pinnedVersion);
const latestVersion = latestStableVersion();
await verifyPinnedPublicSource();

if (latestVersion === pinnedVersion) {
  console.log(
    `Pinned Codex runtime ${pinnedVersion} matches npm's latest stable release and its public tag provenance.`,
  );
  process.exit(0);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-latest-stable-protocol-"));
const pinnedTypes = join(temporaryRoot, "pinned-types");
const pinnedSchemas = join(temporaryRoot, "pinned-schemas");
const latestTypes = join(temporaryRoot, "latest-types");
const latestSchemas = join(temporaryRoot, "latest-schemas");
const latestRuntime = join(temporaryRoot, "latest-runtime");

try {
  const pinnedPackageJson = require.resolve("@openai/codex/package.json");
  const pinnedEntry = join(dirname(pinnedPackageJson), "bin", "codex.js");
  installCodex(latestVersion, latestRuntime);
  const latestEntry = join(
    latestRuntime,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!existsSync(latestEntry)) {
    throw new Error(`Installed Codex ${latestVersion} entry point is missing.`);
  }

  generateProtocol(pinnedEntry, pinnedTypes, pinnedSchemas);
  generateProtocol(latestEntry, latestTypes, latestSchemas);
  const latestMethodMap = await fetchMethodMap(latestVersion);

  const differences = [
    ...compareTrees(pinnedTypes, latestTypes, "typescript", (contents) => contents),
    ...compareTrees(pinnedSchemas, latestSchemas, "json-schema", normalizeJson),
    ...compareMethodMaps(pinnedMethodMetadata, latestMethodMap),
  ];
  if (differences.length === 0) {
    throw new Error(
      `Pinned Codex runtime ${pinnedVersion} differs from latest stable ${latestVersion}; generated protocol is unchanged. Update the runtime baseline.`,
    );
  }
  throw new Error(
    `Pinned Codex runtime ${pinnedVersion} differs from latest stable ${latestVersion} and public protocol drift was detected:\n${differences.map((item) => `- ${item}`).join("\n")}`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function latestStableVersion() {
  const override = process.env.CODEX_LATEST_STABLE_VERSION;
  if (override) {
    assertStableVersion("latest override", override);
    return override;
  }
  const output = execNpmSync(
    ["view", "@openai/codex", "dist-tags.latest", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const version = JSON.parse(output);
  assertStableVersion("latest", version);
  return version;
}

function assertStableVersion(label, version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label} Codex version must be an exact stable semver; received ${String(version)}.`);
  }
}

async function verifyPinnedPublicSource() {
  const expectedTag = `rust-v${pinnedVersion}`;
  if (pinnedMethodMetadata.codexCliVersion !== pinnedVersion) {
    throw new Error(
      `protocol-methods.json targets Codex ${String(pinnedMethodMetadata.codexCliVersion)}, expected ${pinnedVersion}.`,
    );
  }
  if (pinnedMethodMetadata.source?.repository !== "https://github.com/openai/codex") {
    throw new Error("protocol-methods.json must reference the public openai/codex repository.");
  }
  if (pinnedMethodMetadata.source?.tag !== expectedTag) {
    throw new Error(
      `protocol-methods.json references ${String(pinnedMethodMetadata.source?.tag)}, expected ${expectedTag}.`,
    );
  }

  const publicCommit = resolvePublicTagCommit(expectedTag);
  if (pinnedMethodMetadata.source?.commit !== publicCommit) {
    throw new Error(
      `protocol-methods.json records commit ${String(pinnedMethodMetadata.source?.commit)}, but public ${expectedTag} resolves to ${publicCommit}.`,
    );
  }

  const publicMethodMap = await fetchMethodMap(pinnedVersion);
  const differences = compareMethodMaps(pinnedMethodMetadata, publicMethodMap);
  if (differences.length > 0) {
    throw new Error(
      `Pinned method metadata differs from public ${expectedTag}:\n${differences.map((item) => `- ${item}`).join("\n")}`,
    );
  }
}

function resolvePublicTagCommit(tag) {
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      "https://github.com/openai/codex.git",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  let directCommit;
  let peeledCommit;
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const [commit, reference] = line.split("\t");
    if (reference === `refs/tags/${tag}`) directCommit = commit;
    else if (reference === `refs/tags/${tag}^{}`) peeledCommit = commit;
  }
  const commit = peeledCommit ?? directCommit;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Unable to resolve public Codex tag ${tag} to a commit.`);
  }
  return commit;
}

function installCodex(version, prefix) {
  execNpmSync(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      prefix,
      `@openai/codex@${version}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
}

async function fetchMethodMap(version) {
  const url = new URL(
    `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/app-server-protocol/src/protocol/common.rs`,
  );
  const response = await fetch(url, {
    headers: { "user-agent": "codex-app-server-client-protocol-drift" },
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${url}: HTTP ${response.status}.`);
  }
  return parseProtocolMethodMap(await response.text());
}

function generateProtocol(entry, types, schemas) {
  runCodex(entry, ["app-server", "generate-ts", "--experimental", "--out", types]);
  runCodex(entry, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    schemas,
  ]);
}

function runCodex(entry, args) {
  execFileSync(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: "inherit",
  });
}

function compareTrees(expectedRoot, actualRoot, label, normalize) {
  const expected = listFiles(expectedRoot);
  const actual = listFiles(actualRoot);
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  const differences = [];
  for (const path of [...paths].sort()) {
    if (!expected.has(path)) differences.push(`${label}/${path} was added`);
    else if (!actual.has(path)) differences.push(`${label}/${path} was removed`);
    else if (!normalize(expected.get(path)).equals(normalize(actual.get(path)))) {
      differences.push(`${label}/${path} differs`);
    }
  }
  return differences;
}

function compareMethodMaps(expected, actual) {
  const differences = [];
  for (const key of ["methods", "serverRequests"]) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      differences.push(`method-map/${key} differs`);
    }
  }
  return differences;
}

function listFiles(rootPath) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        files.set(relative(rootPath, entryPath), readFileSync(entryPath));
      }
    }
  };
  visit(rootPath);
  return files;
}

function normalizeJson(contents) {
  const value = JSON.parse(contents.toString("utf8"));
  return Buffer.from(JSON.stringify(sortJson(value)));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}
