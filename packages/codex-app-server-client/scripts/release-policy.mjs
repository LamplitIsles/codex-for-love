// Candidate preparation only. This policy never grants permission to publish.
export function candidateMode(manifest, args) {
  const release = args.length === 1 && args[0] === "--release";
  if (args.length && !release) throw new Error("Usage: preview-pack.mjs [--release]");
  const mode = release ? "release" : "preview";
  const version = release ? /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    : /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/;
  const tag = release ? "latest" : "next";
  if (manifest.private || !version.test(manifest.version ?? "")
    || manifest.publishConfig?.tag !== tag || manifest.publishConfig?.access !== "public"
    || manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
    throw new Error(`Invalid ${mode} candidate: require a public 0.x.y${release ? "" : "-preview.N"} version and npm ${tag} tag.`);
  }
  return mode;
}
