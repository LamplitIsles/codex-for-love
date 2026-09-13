#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
for arg in "$@"; do
  if [[ "$arg" == --help || "$arg" == -h ]]; then
    printf 'Local wrapper: defaults to 8 jobs, 8 CPU quota, 6 GiB memory and 512 MiB swap.\n'
    exec bash "$PROJECT_ROOT/scripts/build-codex-patches.sh" "$@"
  fi
done
readonly jobs=${CARGO_BUILD_JOBS:-8}
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'CARGO_BUILD_JOBS must be a positive integer' >&2; exit 1; }
# Forward only build prerequisites, never the caller's complete environment.
build_env=(--setenv="PATH=$PATH" --setenv="CARGO_BUILD_JOBS=$jobs")
for name in PKG_CONFIG PKG_CONFIG_PATH; do
  if [[ -v "$name" ]]; then build_env+=(--setenv="$name=${!name}"); fi
done
exec systemd-run --user --wait --pipe --collect \
  --unit=cfl-codex-build-local \
  --property="WorkingDirectory=$PROJECT_ROOT" \
  --property=MemoryMax=6G --property=MemorySwapMax=512M \
  --property=CPUQuota=800% --property=TasksMax=256 \
  "${build_env[@]}" \
  "$(command -v bash)" "$PROJECT_ROOT/scripts/build-codex-patches.sh" "$@"
