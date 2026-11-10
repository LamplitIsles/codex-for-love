import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { smokeExamples } from "../examples/lib/catalog.mjs";

export function runExamples(directory, cwd) {
  // Check the shipped catalog, too: a source-only list must not mask omitted package files.
  const catalog = pathToFileURL(join(directory, "lib", "catalog.mjs")).href;
  const shipped = execFileSync(process.execPath, ["--input-type=module", "--eval",
    `import { smokeExamples } from ${JSON.stringify(catalog)}; console.log(JSON.stringify(smokeExamples));`],
  { cwd, encoding: "utf8", timeout: 10_000 });
  assert.deepEqual(JSON.parse(shipped), smokeExamples);
  for (const example of smokeExamples) {
    execFileSync(process.execPath, [join(directory, example + ".mjs")], {
      cwd, stdio: "inherit", timeout: 60_000,
    });
  }
  for (const [name, input, turns] of [
    ["exit", "\nHello\nAgain\n/exit\nMust not run\n", 2],
    ["quit", "Hello\n/quit\nMust not run\n", 1],
    ["eof", "Hello\nAgain\n", 2],
    ["empty", "\n/exit\n", 0],
  ]) {
    const output = execFileSync(process.execPath, [join(directory, "11_cli_mini_app.mjs"), "--interactive"], {
      cwd, input, encoding: "utf8", timeout: 60_000,
    });
    assert.match(output, new RegExp(`cli\\.turns: ${turns}(?:\\r?\\n)`));
    assert.match(output, /\[example\] mini-cli passed/);
    console.log(`Mini CLI ${name} input passed (${turns} turns).`);
  }
  console.log(`${smokeExamples.length} examples plus 4 CLI input cases passed; local fixtures, no model usage.`);
}
