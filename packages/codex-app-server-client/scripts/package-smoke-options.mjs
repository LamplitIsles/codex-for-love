import assert from "node:assert/strict";

export function smokeOptions(args) {
  const usePnpm = args.includes("--pnpm");
  const positional = args.filter((arg) => arg !== "--pnpm");
  if (positional[0] === "--registry") {
    assert.equal(positional.length, 3, "Usage: --registry VERSION SHA512_INTEGRITY [--pnpm]");
    const [, version, integrity] = positional;
    assert.match(version, /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    return { usePnpm, registry: { version, integrity } };
  }
  assert.ok(positional.length <= 1 && !positional[0]?.startsWith("--"), "Usage: [TARBALL] [--pnpm]");
  return { usePnpm, artifact: positional[0] };
}

export function verifyConsumerLock(text, usePnpm, name, version, integrity) {
  if (usePnpm) {
    const entry = text.split(`  '${name}@${version}':\n`)[1]?.split(/\n {2}[^ ]/)[0];
    assert.ok(entry?.includes(`integrity: ${integrity}`), "pnpm registry lock integrity mismatch");
  } else {
    const entry = JSON.parse(text).packages?.[`node_modules/${name}`];
    assert.equal(entry?.version, version);
    assert.equal(entry?.integrity, integrity);
    assert.ok(entry?.resolved?.startsWith("https://registry.npmjs.org/"), "npm did not install from the public registry");
  }
}
