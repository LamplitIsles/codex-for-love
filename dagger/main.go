package main

import (
	"dagger/cfl-snapshot/internal/dagger"
	"fmt"
	"regexp"
)

type CflSnapshot struct{}

// Snapshot checks and packages one Git-verified CFL revision using the real pinned App Git checkout.
func (m *CflSnapshot) Snapshot(source *dagger.Directory, stagedManifest *dagger.File, revision string) (*dagger.Directory, error) {
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(revision) {
		return nil, fmt.Errorf("a full CFL commit SHA is required")
	}
	container := dag.Container(dagger.ContainerOpts{Platform: dagger.Platform("linux/amd64")}).
		From("node:24.18.1-bookworm@sha256:19cd848a0e073d34bd8cd5545a1b6b4d28489b3e3b607366621ced442bd5f6b4").
		WithExec([]string{"npm", "install", "--global", "corepack@0.35.0", "bun@1.3.14"}).
		WithExec([]string{"corepack", "enable"}).
		WithExec([]string{"corepack", "prepare", "pnpm@11.22.0", "--activate"}).
		WithMountedCache("/bun-cache", dag.CacheVolume("cfl-app-prepare-bun-1.3.14-linux-amd64-v1"), dagger.ContainerWithMountedCacheOpts{Sharing: dagger.CacheSharingModeLocked}).
		WithMountedCache("/pnpm/store", dag.CacheVolume("cfl-pnpm-11.22.0-node24-linux-amd64-v1"), dagger.ContainerWithMountedCacheOpts{Sharing: dagger.CacheSharingModeLocked}).
		WithEnvVariable("BUN_INSTALL_CACHE_DIR", "/bun-cache").
		WithEnvVariable("CFL_SOURCE_SHA", revision).
		WithEnvVariable("CI", "true").
		WithDirectory("/src/codex-for-love", source).
		WithFile("/tmp/cfl-staged-package.json", stagedManifest).
		WithWorkdir("/src/codex-for-love").
		WithExec([]string{"sh", "-ec", `
app_sha=$(cat lamplit-app.sha)
case "$app_sha" in *[!0-9a-f]*|'') exit 1 ;; esac
test "${#app_sha}" -eq 40
git init ../lamplit-app
git -C ../lamplit-app fetch --depth=1 https://github.com/LamplitIsles/lamplit-app.git "$app_sha"
git -C ../lamplit-app checkout --detach FETCH_HEAD
pnpm --config.verify-deps-before-run=false source:prepare --strict
pnpm install --frozen-lockfile --store-dir /pnpm/store
pnpm check
pnpm build
pnpm test
node scripts/snapshot-apply-stage.mjs /tmp/cfl-staged-package.json "$CFL_SOURCE_SHA"
mkdir /out
pnpm release:prepare /out --strict
pnpm release:check
set -- /out/*.tgz
test "$#" -eq 1 && test -f "$1"
node scripts/packaged-frontend-smoke.mjs "$1"
mv "$1" /out/snapshot.tgz
cd /out
sha256sum snapshot.tgz > snapshot.sha256
`})
	return container.Directory("/out"), nil
}
