#!/bin/sh
set -eu
: "${CI_COMMIT_SHA:?Set CI_COMMIT_SHA to the exact checked-out CFL commit}"
: "${_EXPERIMENTAL_DAGGER_RUNNER_HOST:?Select the existing Dagger engine before building}"
test -z "$(git status --porcelain --untracked-files=all)" || { echo 'Snapshot source must be clean' >&2; exit 1; }
node scripts/snapshot-publish.mjs verify-head
mkdir .snapshot-artifacts
mkdir .snapshot-artifacts/source
node scripts/snapshot-publish.mjs stage-to "$PWD/.snapshot-artifacts/staged-package.json"
git archive --output=.snapshot-artifacts/source.tar "$CI_COMMIT_SHA"
tar -xf .snapshot-artifacts/source.tar -C .snapshot-artifacts/source
dagger_cli=${DAGGER_CLI:-dagger}
case "$dagger_cli" in /*) ;; */*) dagger_cli="$PWD/$dagger_cli" ;; esac
(
  cd .snapshot-artifacts/source/dagger
  "$dagger_cli" call --output=../../package snapshot \
    --source=.. \
    --staged-manifest=../../staged-package.json \
    --revision="$CI_COMMIT_SHA"
)
(cd .snapshot-artifacts/package && sha256sum -c snapshot.sha256)
