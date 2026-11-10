import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseProtocolMethodMap } from "./protocol-method-map.mjs";

const sourceArgument = argument("--source");
const version = argument("--version");
const tag = argument("--tag") ?? `rust-v${version}`;
const commit = argument("--commit");

if (!sourceArgument || !version || !commit) {
  throw new Error(
    "Usage: node scripts/extract-method-map.mjs --source <common.rs> --version <cli-version> --commit <git-commit> [--tag <tag>]",
  );
}

const sourcePath = resolve(sourceArgument);
const source = readFileSync(sourcePath, "utf8");
const { methods, serverRequests } = parseProtocolMethodMap(source);
const output = {
  schemaVersion: 2,
  codexCliVersion: version,
  source: {
    repository: "https://github.com/openai/codex",
    tag,
    commit,
    path: "codex-rs/app-server-protocol/src/protocol/common.rs",
  },
  methods,
  serverRequests,
};

writeFileSync(
  resolve("protocol-methods.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(
  `Extracted ${methods.length} client methods and ${serverRequests.length} server requests from ${tag}.`,
);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
