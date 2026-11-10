import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { CodexBinaryResolutionError } from "./errors";

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

export interface ResolvedCodexBinary {
  executablePath: string;
  pathDirectories: string[];
}

export function resolveCodexBinary(override?: string): ResolvedCodexBinary {
  if (override) return { executablePath: override, pathDirectories: [] };

  const target = targetTriple(process.platform, process.arch);
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[target];
  if (!platformPackage) {
    throw new CodexBinaryResolutionError(`Unsupported Codex target: ${target}.`);
  }

  try {
    const codexPackageJson = require.resolve("@openai/codex/package.json");
    const fromCodexPackage = createRequire(codexPackageJson);
    const platformPackageJson = fromCodexPackage.resolve(`${platformPackage}/package.json`);
    const vendorRoot = join(dirname(platformPackageJson), "vendor", target);
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const currentBinary = join(vendorRoot, "bin", executableName);
    const legacyBinary = join(vendorRoot, "codex", executableName);
    const executablePath = isFile(currentBinary)
      ? currentBinary
      : isFile(legacyBinary)
        ? legacyBinary
        : null;

    if (!executablePath) {
      throw new CodexBinaryResolutionError(
        `The ${platformPackage} package does not contain a Codex executable for ${target}.`,
      );
    }

    return {
      executablePath,
      pathDirectories: [join(vendorRoot, "codex-path"), join(vendorRoot, "path")].filter(
        isDirectory,
      ),
    };
  } catch (error) {
    if (error instanceof CodexBinaryResolutionError) throw error;
    throw new CodexBinaryResolutionError(
      "Unable to resolve the bundled Codex CLI. Reinstall @jaminzhou/codex-app-server-client with optional dependencies enabled, or provide codexPath.",
      { cause: error },
    );
  }
}

export function prependPathDirectories(
  env: NodeJS.ProcessEnv,
  directories: readonly string[],
): NodeJS.ProcessEnv {
  if (directories.length === 0) return env;
  const output = { ...env };
  const key = findPathKey(output);
  if (process.platform === "win32") {
    for (const existingKey of Object.keys(output)) {
      if (existingKey.toLowerCase() === "path" && existingKey !== key) delete output[existingKey];
    }
  }
  output[key] = [...directories, output[key]].filter(Boolean).join(delimiter);
  return output;
}

function targetTriple(platform: NodeJS.Platform, architecture: string): string {
  const key = `${platform}:${architecture}`;
  switch (key) {
    case "darwin:x64":
      return "x86_64-apple-darwin";
    case "darwin:arm64":
      return "aarch64-apple-darwin";
    case "linux:x64":
      return "x86_64-unknown-linux-musl";
    case "linux:arm64":
      return "aarch64-unknown-linux-musl";
    case "win32:x64":
      return "x86_64-pc-windows-msvc";
    case "win32:arm64":
      return "aarch64-pc-windows-msvc";
    default:
      throw new CodexBinaryResolutionError(`Unsupported platform: ${platform} (${architecture}).`);
  }
}

function findPathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
