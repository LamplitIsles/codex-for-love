import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runExamples } from "./run-examples.mjs";

// Never silently turn an attempted live acceptance into a successful mock-only run.
if (process.argv.length > 2) {
  throw new Error("examples:smoke is mock-only and accepts no arguments. Use --live only with an individual example file.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
runExamples(resolve(root, "examples"), root);
