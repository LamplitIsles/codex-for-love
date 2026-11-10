import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src";

describe("managed stdio executable selection", () => {
  it.each([undefined, "cli", "app-server"] as const)(
    "launches %s with the expected arguments and cleans up",
    async (codexExecutableType) => {
      const directory = await mkdtemp(join(tmpdir(), "sdk-stdio-launch-"));
      const executable = join(directory, "fake-app-server");
      const capture = join(directory, "launch.json");
      const client = new CodexAppServerClient({
        codexPath: executable,
        codexExecutableType,
        cwd: directory,
        env: { LAUNCH_CAPTURE: capture },
        configOverrides: ['model="fake"'],
        appServerArgs: ["--analytics-default-enabled"],
        requestTimeoutMs: 2000,
      });
      try {
        await writeFile(
          executable,
          `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(process.env.LAUNCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fake", codexHome: process.cwd(), platformFamily: "unix", platformOs: "linux" } }) + "\\n");
}).on("close", () => process.exit(0));
`,
          { mode: 0o700 },
        );
        const initialized = await client.connect();
        expect(initialized.userAgent).toBe("fake");
        const launch = JSON.parse(await readFile(capture, "utf8"));
        expect(launch.args).toEqual([
          "--config",
          'model="fake"',
          ...(codexExecutableType === "app-server" ? [] : ["app-server"]),
          "--listen",
          "stdio://",
          "--analytics-default-enabled",
        ]);
        expect(launch.cwd).toBe(directory);
        await client.close();
        expect(() => process.kill(launch.pid, 0)).toThrow();
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("requires an explicit standalone binary and rejects remote launch options", () => {
    expect(
      () => new CodexAppServerClient({ codexExecutableType: "invalid" as "cli" }),
    ).toThrow("codexExecutableType must be cli or app-server.");
    expect(() => new CodexAppServerClient({ codexExecutableType: "app-server" })).toThrow(
      "Standalone app-server requires an explicit codexPath.",
    );
    expect(
      () =>
        new CodexAppServerClient({
          codexExecutableType: "cli",
          transport: { type: "unix", socketPath: "/unused" },
        }),
    ).toThrow("Local process options cannot be used with unix transport: codexExecutableType.");
  });
});
