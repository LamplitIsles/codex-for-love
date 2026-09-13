#!/usr/bin/env bash
set -euo pipefail

readonly CODEX_SOURCE_REVISION='6b9826e3aa83b1a5947db50f4332cb9c65f1b340'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly PATCH_DIR="${PROJECT_ROOT}/patches"
readonly PATCH_1="${PATCH_DIR}/0001-local-compaction.patch"
readonly PATCH_2="${PATCH_DIR}/0002-neutral-summary-prefix.patch"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/build-codex-patches.sh --source CODEX_CHECKOUT --output OUTPUT_DIR [--build-dir BUILD_DIR]

Builds the pinned Codex release from a read-only source checkout into a new
output directory. The source checkout must already contain the pinned commit;
this command never fetches, pulls, cleans, or writes it.
Build cache defaults to .cache/codex-build in this project and survives failures.
Builds codex with opt-level 1, no LTO/debug/incremental; copies the pinned official code-mode host.
CARGO_BUILD_JOBS selects parallel jobs (default: 1).
EOF
}

fail() {
  printf 'codex patch build: %s\n' "$*" >&2
  exit 1
}

build_jobs=${CARGO_BUILD_JOBS:-1}
[[ "$build_jobs" =~ ^[1-9][0-9]*$ ]] || fail 'CARGO_BUILD_JOBS must be a positive integer'

source_checkout=''
output_dir=''
build_dir="${PROJECT_ROOT}/.cache/codex-build"
while (($# > 0)); do
  case "$1" in
    --source)
      (($# >= 2)) || { usage; fail '--source requires a checkout path'; }
      source_checkout=$2
      shift 2
      ;;
    --output)
      (($# >= 2)) || { usage; fail '--output requires a directory path'; }
      output_dir=$2
      shift 2
      ;;
    --build-dir)
      (($# >= 2)) || fail '--build-dir requires a directory path'
      build_dir=$2
      shift 2
      ;;
    -h|--help)
      usage >&2
      exit 0
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$(uname -s)" == 'Linux' ]] || fail 'Linux is the only supported build host'
[[ -n "$source_checkout" ]] || { usage; fail '--source is required'; }
[[ -n "$output_dir" ]] || { usage; fail '--output is required'; }

command -v git >/dev/null 2>&1 || fail 'git is required'
command -v cargo >/dev/null 2>&1 || fail 'cargo is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command -v node >/dev/null 2>&1 || fail 'Node.js is required to write provenance JSON'

[[ -f "$PATCH_1" ]] || fail "missing patch: $PATCH_1"
[[ -f "$PATCH_2" ]] || fail "missing patch: $PATCH_2"

source_checkout=$(realpath -e -- "$source_checkout") || fail "source checkout does not exist: $source_checkout"
[[ -d "$source_checkout" ]] || fail "source is not a directory: $source_checkout"
source_root=$(git -C "$source_checkout" rev-parse --show-toplevel 2>/dev/null) \
  || fail "source is not a Git checkout: $source_checkout"
source_root=$(realpath -e -- "$source_root")

if ! git -C "$source_root" cat-file -e "${CODEX_SOURCE_REVISION}^{commit}" 2>/dev/null; then
  fail "source checkout does not contain pinned Codex commit ${CODEX_SOURCE_REVISION}; acquire that revision before building (the build does not fetch)"
fi

output_dir=$(realpath -m -- "$output_dir")
[[ "$output_dir" != "$source_root" && "$output_dir" != "$source_root/"* ]] \
  || fail 'output directory must be outside the source checkout'
[[ ! -e "$output_dir" ]] || fail "output already exists; choose a new directory without overwriting it: $output_dir"
output_parent=$(dirname -- "$output_dir")
mkdir -p -- "$output_parent"

patch_1_sha=$(sha256sum "$PATCH_1" | awk '{print $1}')
patch_2_sha=$(sha256sum "$PATCH_2" | awk '{print $1}')

build_root=$(realpath -m -- "$build_dir")
[[ "$build_root" != "$source_root" && "$build_root" != "$source_root/"* ]] \
  || fail 'build directory must be outside the source checkout'
mkdir -p -- "$build_root"
command -v flock >/dev/null 2>&1 || fail 'flock is required'
exec 9>"${build_root}/build.lock"
flock -n 9 || fail "another build owns ${build_root}"

# Source snapshots are immutable per revision/patch set; target is reusable.
source_key=$(printf '%s\n' "$CODEX_SOURCE_REVISION" "$patch_1_sha" "$patch_2_sha" | sha256sum | cut -d ' ' -f 1)
build_source="${build_root}/source-${source_key}"
if [[ ! -f "${build_source}/.cfl-patches-ready" ]]; then
  [[ ! -e "$build_source" ]] || fail "incomplete source snapshot: $build_source; inspect before removing"
  mkdir -- "$build_source"
  git -C "$source_root" archive --format=tar "$CODEX_SOURCE_REVISION" | tar -x -C "$build_source"
  for patch in "$PATCH_1" "$PATCH_2"; do
    (cd -- "$build_source" && GIT_CEILING_DIRECTORIES="$build_root" git apply --check --whitespace=error-all "$patch") \
      || fail "patch does not apply cleanly: $(basename -- "$patch")"
    (cd -- "$build_source" && GIT_CEILING_DIRECTORIES="$build_root" git apply --whitespace=error-all "$patch")
  done
  touch "${build_source}/.cfl-patches-ready"
fi

# Check the actual source, not just a completion marker. Prevent silent skips
# when this cache sits beneath an enclosing Git worktree.
for patch in "$PATCH_1" "$PATCH_2"; do
  (cd -- "$build_source" && GIT_CEILING_DIRECTORIES="$build_root" git apply --reverse --check "$patch") \
    || fail "cached source does not contain patch: $(basename -- "$patch")"
done

# Release source bumps workspace version while its lock retains 0.0.0 for
# local packages. Normalize only those source-less entries; dependencies stay pinned.
node --input-type=module - "${build_source}/codex-rs/Cargo.lock" <<'LOCK'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const raw = readFileSync(path, 'utf8');
const fixed = raw.split('[[package]]').map(block =>
  !/^source = /m.test(block) ? block.replace(/^version = "0\.0\.0"$/m, 'version = "0.154.0"') : block
).join('[[package]]');
if (fixed !== raw) writeFileSync(path, fixed);
LOCK

# Reuse the unmodified helper from the SDK's lockfile-pinned official release.
code_mode_host=$(cd "$PROJECT_ROOT/apps/partner" && node --input-type=module <<'HELPER'
import { resolveCodexBinary } from '@jaminzhou/codex-app-server-client';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const { executablePath } = resolveCodexBinary();
if (execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.154.0')
  throw new Error('Official helper must come from Codex 0.154.0');
console.log(join(dirname(executablePath), 'codex-code-mode-host'));
HELPER
)
[[ -x "$code_mode_host" ]] || fail 'install pinned SDK optional dependencies to obtain codex-code-mode-host'

target_dir="${build_root}/target"
printf 'Building pinned Codex with %s jobs; cache: %s\n' "$build_jobs" "$build_root"
(
  cd -- "${build_source}/codex-rs"
  CARGO_TARGET_DIR="$target_dir" CARGO_BUILD_JOBS="$build_jobs" \
  CARGO_INCREMENTAL=0 CARGO_PROFILE_RELEASE_INCREMENTAL=false \
  CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_DEBUG=0 \
  CARGO_PROFILE_RELEASE_STRIP=symbols CARGO_PROFILE_RELEASE_OPT_LEVEL=1 \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
  cargo build --locked --release -j "$build_jobs" -p codex-cli --bin codex
)

built_binary="${target_dir}/release/codex"
[[ -x "$built_binary" ]] || fail "cargo build completed without producing $built_binary"
# Preserve Cargo's cached binary; finalize runtime search paths on the artifact.
mkdir -- "$output_dir"
install -m 0755 -- "$built_binary" "${output_dir}/codex"
install -m 0755 -- "$code_mode_host" "${output_dir}/codex-code-mode-host"
if command -v "${PKG_CONFIG:-pkg-config}" >/dev/null 2>&1; then
  openssl_libdir=$("${PKG_CONFIG:-pkg-config}" --variable=libdir openssl 2>/dev/null || true)
  if [[ "$openssl_libdir" == /nix/store/* ]]; then
    command -v patchelf >/dev/null 2>&1 || fail 'patchelf is required for Nix OpenSSL runtime paths'
    patchelf --add-rpath "$openssl_libdir" "${output_dir}/codex"
  fi
fi
binary_identity=$("${output_dir}/codex" --version) \
  || fail 'built Codex did not respond to --version (see stderr above)'
[[ "$binary_identity" == *'0.154.0'* ]] \
  || fail "built Codex identity does not contain 0.154.0: $binary_identity"

"${output_dir}/codex-code-mode-host" --help >/dev/null || fail 'code-mode host cannot start'
helper_sha=$(sha256sum "${output_dir}/codex-code-mode-host" | awk '{print $1}')
binary_sha=$(sha256sum "${output_dir}/codex" | awk '{print $1}')

PROVENANCE_OUTPUT="${output_dir}/codex.provenance.json" \
SOURCE_REVISION="$CODEX_SOURCE_REVISION" \
PATCH_1_SHA="$patch_1_sha" \
PATCH_2_SHA="$patch_2_sha" \
BINARY_SHA="$binary_sha" HELPER_SHA="$helper_sha" \
BINARY_IDENTITY="$binary_identity" \
BINARY_PATH="${output_dir}/codex" \
node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';

const required = [
  'PROVENANCE_OUTPUT',
  'SOURCE_REVISION',
  'PATCH_1_SHA',
  'PATCH_2_SHA',
  'BINARY_SHA',
  'BINARY_IDENTITY',
  'BINARY_PATH',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing provenance value: ${name}`);
}

const provenance = {
  schemaVersion: 1,
  codexVersion: '0.154.0',
  sdkVersion: '0.2.1',
  upstreamRepository: 'https://github.com/openai/codex',
  sourceRevision: process.env.SOURCE_REVISION,
  patches: [
    { path: 'patches/0001-local-compaction.patch', sha256: process.env.PATCH_1_SHA },
    { path: 'patches/0002-neutral-summary-prefix.patch', sha256: process.env.PATCH_2_SHA },
  ],
  binaryPath: process.env.BINARY_PATH,
  binarySha256: process.env.BINARY_SHA,
  codeModeHostSha256: process.env.HELPER_SHA,
  binaryIdentity: process.env.BINARY_IDENTITY.trim(),
};
await writeFile(process.env.PROVENANCE_OUTPUT, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
NODE

printf 'Built %s (%s)\nProvenance: %s\n' "${output_dir}/codex" "$binary_identity" "${output_dir}/codex.provenance.json"
