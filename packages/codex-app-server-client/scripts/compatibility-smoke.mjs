import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execNpmSync } from "./npm-exec.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson(join(root, "package.json"));
const matrix = readJson(join(root, "compatibility-matrix.json"));
const pinnedVersion = packageJson.dependencies?.["@openai/codex"];
const versions = validateMatrix(matrix, pinnedVersion);
const checkOnly = process.argv.includes("--check");

console.log(`Codex compatibility matrix: ${versions.join(", ")}.`);
if (checkOnly) process.exit(0);

const builtEntry = join(root, "dist", "index.js");
if (!existsSync(builtEntry)) {
  throw new Error("dist/index.js is missing. Run pnpm build before the compatibility smoke.");
}

const { AppServerMethodNotFoundError, CodexAppServerClient } = await import(
  pathToFileURL(builtEntry).href
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-app-server-compatibility-"));

try {
  for (const version of versions) await smokeVersion(version);
} finally {
  rmSync(temporaryRoot, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

async function smokeVersion(version) {
  const versionRoot = join(temporaryRoot, version);
  const installRoot = join(versionRoot, "runtime");
  const codexHome = join(versionRoot, "codex-home");
  const workspace = join(versionRoot, "workspace");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(codexHome);
  mkdirSync(workspace);
  writeFileSync(join(codexHome, "config.toml"), "[features]\nplugins = false\n");

  execNpmSync(
    [
      "install",
      "--ignore-scripts",
      "--include=optional",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      installRoot,
      `@openai/codex@${version}`,
    ],
    { cwd: root, stdio: "inherit" },
  );

  const resolved = resolveInstalledCodexBinary(installRoot);
  const env = prependPathDirectories(
    {
      ...process.env,
      CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
      CODEX_HOME: codexHome,
      RUST_LOG: "warn",
    },
    resolved.pathDirectories,
  );
  const reportedVersion = execFileSync(resolved.executablePath, ["--version"], {
    encoding: "utf8",
    env,
  }).trim();
  if (reportedVersion !== `codex-cli ${version}`) {
    throw new Error(`Expected codex-cli ${version}, received ${reportedVersion}.`);
  }

  const client = new CodexAppServerClient({
    codexPath: resolved.executablePath,
    cwd: workspace,
    env,
    protocolValidation: "strict",
    requestTimeoutMs: 10_000,
  });
  try {
    const initialization = await client.connect();
    if (!initialization.userAgent.includes("codex")) {
      throw new Error(`Codex ${version} returned an unexpected initialization user agent.`);
    }
    const listed = await client.call("thread/list", { limit: 1 });
    if (!Array.isArray(listed.data)) {
      throw new Error(`Codex ${version} returned an invalid thread/list response.`);
    }
    const models = await client.modelList({ includeHidden: true, limit: 1 });
    if (!Array.isArray(models.data)) {
      throw new Error(`Codex ${version} returned an invalid model/list response.`);
    }
    const thread = await client.createThread({ cwd: workspace });
    const read = await thread.read();
    if (read.thread.id !== thread.id) {
      throw new Error(`Codex ${version} returned a mismatched thread/read response.`);
    }
    const goal = await thread.goal();
    if (goal.goal !== null) {
      throw new Error(`Codex ${version} returned an unexpected initial thread goal.`);
    }
    const importHistories = await client.call("externalAgentConfig/import/readHistories");
    if (!Array.isArray(importHistories.data)) {
      throw new Error(`Codex ${version} returned invalid external-agent import histories.`);
    }
    try {
      const items = await client.call("thread/items/list", { limit: 1, threadId: thread.id });
      if (!Array.isArray(items.data)) {
        throw new Error(`Codex ${version} returned an invalid thread item page.`);
      }
    } catch (error) {
      if (!(error instanceof AppServerMethodNotFoundError)) throw error;
    }
  } finally {
    await client.close();
  }

  console.log(`Codex ${version} compatibility smoke passed on Node ${process.versions.node}.`);
}

function validateMatrix(value, expectedPinnedVersion) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.codexCliVersions)) {
    throw new Error("compatibility-matrix.json must use schemaVersion 1 and codexCliVersions.");
  }
  if (value.codexCliVersions.length < 2) {
    throw new Error("The compatibility matrix must contain at least two Codex CLI versions.");
  }
  const versions = value.codexCliVersions;
  for (const version of versions) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`Compatibility version must be an exact stable semver: ${String(version)}.`);
    }
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error("The compatibility matrix must not contain duplicate versions.");
  }
  for (let index = 1; index < versions.length; index += 1) {
    if (compareVersions(versions[index - 1], versions[index]) >= 0) {
      throw new Error("Compatibility versions must be ordered from oldest to newest.");
    }
  }
  if (versions.at(-1) !== expectedPinnedVersion) {
    throw new Error(
      `The newest compatibility version must match pinned Codex ${expectedPinnedVersion}.`,
    );
  }
  return versions;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function resolveInstalledCodexBinary(installRoot) {
  const target = codexTarget(process.platform, process.arch);
  const packageRoot = join(installRoot, "node_modules", ...target.packageName.split("/"));
  const vendorRoot = join(packageRoot, "vendor", target.triple);
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const executablePath = [
    join(vendorRoot, "bin", executableName),
    join(vendorRoot, "codex", executableName),
  ].find(isFile);
  if (!executablePath) {
    throw new Error(`Installed ${target.packageName} does not contain the Codex executable.`);
  }
  return {
    executablePath,
    pathDirectories: [join(vendorRoot, "codex-path"), join(vendorRoot, "path")].filter(
      isDirectory,
    ),
  };
}

function codexTarget(platform, architecture) {
  const target = {
    "darwin:arm64": ["aarch64-apple-darwin", "@openai/codex-darwin-arm64"],
    "darwin:x64": ["x86_64-apple-darwin", "@openai/codex-darwin-x64"],
    "linux:arm64": ["aarch64-unknown-linux-musl", "@openai/codex-linux-arm64"],
    "linux:x64": ["x86_64-unknown-linux-musl", "@openai/codex-linux-x64"],
    "win32:arm64": ["aarch64-pc-windows-msvc", "@openai/codex-win32-arm64"],
    "win32:x64": ["x86_64-pc-windows-msvc", "@openai/codex-win32-x64"],
  }[`${platform}:${architecture}`];
  if (!target) throw new Error(`Unsupported Codex target: ${platform} (${architecture}).`);
  return { triple: target[0], packageName: target[1] };
}

function prependPathDirectories(env, directories) {
  if (directories.length === 0) return env;
  const output = { ...env };
  const key =
    process.platform === "win32"
      ? Object.keys(output).find((item) => item.toLowerCase() === "path") ?? "Path"
      : "PATH";
  output[key] = [...directories, output[key]].filter(Boolean).join(delimiter);
  return output;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
