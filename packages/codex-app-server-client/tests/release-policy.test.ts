import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error Repository-only JavaScript tooling has no public declaration.
import { candidateMode } from "../scripts/release-policy.mjs";

const manifest = (version: string, tag: string) => ({
  version, publishConfig: { tag, access: "public", registry: "https://registry.npmjs.org/" },
});
describe("candidate packaging policy", () => {
  it("keeps shipped exact-version installation and troubleshooting aligned with the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const examples = readFileSync(new URL("../examples/README.md", import.meta.url), "utf8");
    const row = examples.split("\n").find((line) => line.startsWith("| npm returns 404"));
    expect(row).toContain(`npm view ${pkg.name}@${pkg.version} version`);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`npm view ${pkg.name}@${pkg.version} version`);
    expect(readme).toContain(`codex-app-server-client-${pkg.version}.tgz`);
    const releasing = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");
    expect(releasing).toContain(`codex-app-server-client-${pkg.version}.tgz`);
    expect(releasing).toContain(`./docs/releases/${pkg.version}.md`);
    const security = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(security).toContain(`Preparing \`${pkg.version}\` does not supersede the`);
    expect(security).toContain("published `0.2.0` until the new version is actually published");
  });
  it("keeps previews and non-preview candidates explicit", () => {
    expect(candidateMode(manifest("0.1.0-preview.1", "next"), [])).toBe("preview");
    expect(candidateMode(manifest("0.1.0", "latest"), ["--release"])).toBe("release");
    expect(candidateMode(manifest("0.2.0", "latest"), ["--release"])).toBe("release");
  });
  it.each([
    ["0.1.0", "latest", []], ["0.1.0-preview.0", "next", ["--release"]],
    ["0.1.0", "next", ["--release"]], ["0.1.0-preview.0", "latest", []],
    ["0.01.0", "latest", ["--release"]], ["0.1.0", "latest", ["--publish"]],
  ])("rejects mismatched version/tag/mode %s %s %j", (version, tag, args) => {
    expect(() => candidateMode(manifest(version as string, tag as string), args)).toThrow();
  });
  it("rejects private or alternate registry candidates", () => {
    const pkg = manifest("0.1.0", "latest");
    expect(() => candidateMode({ ...pkg, private: true }, ["--release"])).toThrow();
    expect(() => candidateMode({ ...pkg, publishConfig: { ...pkg.publishConfig, registry: "https://example.com/" } }, ["--release"])).toThrow();
  });
});
