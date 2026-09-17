#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage:
  publish-native-wizard.sh login
  publish-native-wizard.sh publish <native-version> --linux
  publish-native-wizard.sh publish <native-version> --mac
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" = login ]]; then
  [[ "$#" = 1 ]] || { usage >&2; exit 64; }
  exec npm login --registry https://registry.npmjs.org
fi

[[ "${1:-}" = publish && "$#" = 3 ]] || { usage >&2; exit 64; }
VERSION=$2
PLATFORM=$3
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || fail "native version must be valid semver: $VERSION"

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
INPUT_DIR=${CFL_NATIVE_INPUT_DIR:-"$ROOT/.scratch/native-release-$VERSION"}
REGISTRY=https://registry.npmjs.org
DIST_TAG=latest
[[ "$VERSION" == *-* ]] && DIST_TAG=beta

case "$PLATFORM" in
  --linux)
    NAME=@lamplitisles/codex-for-love-linux-x64
    OS=linux
    CPU=x64
    ARCHIVE_PATTERN='*x86_64-unknown-linux-musl.tar.gz'
    TEMPLATE="$ROOT/packages/codex-for-love-linux-x64/package.json"
    ;;
  --mac)
    NAME=@lamplitisles/codex-for-love-darwin-arm64
    OS=darwin
    CPU=arm64
    ARCHIVE_PATTERN='*aarch64-apple-darwin.tar.gz'
    TEMPLATE="$ROOT/packages/codex-for-love-darwin-arm64/package.json"
    ;;
  *) usage >&2; exit 64 ;;
esac

ARCHIVE=$(find "$INPUT_DIR" -maxdepth 1 -type f -name "$ARCHIVE_PATTERN" -print -quit)
[[ -n "$ARCHIVE" ]] || fail "expected $ARCHIVE_PATTERN in $INPUT_DIR"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cfl-native-publish.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

archive_root() {
  local executable
  executable=$(tar -tzf "$1" | awk '/\/bin\/codex-app-server$/ { print; exit }')
  [[ -n "$executable" ]] || fail "archive lacks bin/codex-app-server: $1"
  printf '%s' "${executable%/bin/codex-app-server}"
}

assert_artifact() {
  local directory=$1 executable
  for executable in bin/codex-app-server bin/codex-code-mode-host; do
    [[ -x "$directory/$executable" ]] || fail "$NAME archive lacks executable $executable"
  done
}

PACKAGE_DIR=$(mktemp -d "$WORK/package.XXXXXX")
tar -xzf "$ARCHIVE" -C "$PACKAGE_DIR"
PACKAGE_DIR="$PACKAGE_DIR/$(archive_root "$ARCHIVE")"
node - "$TEMPLATE" "$PACKAGE_DIR/package.json" "$VERSION" "$NAME" "$OS" "$CPU" "$DIST_TAG" <<'NODE'
const fs = require('node:fs');
const [template, output, version, name, os, cpu, distTag] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(template, 'utf8'));
manifest.name = name;
manifest.version = version;
manifest.os = [os];
manifest.cpu = [cpu];
manifest.publishConfig = { access: 'public', tag: distTag, registry: 'https://registry.npmjs.org/' };
manifest.repository = { type: 'git', url: 'git+https://github.com/LamplitIsles/codex.git' };
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
assert_artifact "$PACKAGE_DIR"

mkdir -p "$WORK/tarballs"
PACKED=$(npm pack --json --pack-destination "$WORK/tarballs" "$PACKAGE_DIR")
FILENAME=$(node -e 'console.log(JSON.parse(process.argv[1])[0].filename)' "$PACKED")
TARBALL="$WORK/tarballs/$FILENAME"
[[ -f "$TARBALL" ]] || fail "npm did not create $FILENAME"

VERIFY_DIR=$(mktemp -d "$WORK/packed.XXXXXX")
tar -xzf "$TARBALL" -C "$VERIFY_DIR"
assert_artifact "$VERIFY_DIR/package"
node - "$VERIFY_DIR/package/package.json" "$NAME" "$VERSION" "$OS" "$CPU" <<'NODE'
const fs = require('node:fs');
const [path, name, version, os, cpu] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
if (manifest.name !== name || manifest.version !== version || manifest.os?.join(',') !== os || manifest.cpu?.join(',') !== cpu) process.exit(1);
NODE

printf 'Publishing %s@%s with dist-tag %s…\n' "$NAME" "$VERSION" "$DIST_TAG"
npm publish "$TARBALL" --access public --tag "$DIST_TAG" --registry "$REGISTRY"
printf 'Submitted %s@%s. Registry propagation is asynchronous; do not republish while npm processes it.\n' "$NAME" "$VERSION"
