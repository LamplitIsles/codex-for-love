# 0.1.0 candidate compared with 0.1.0-preview.0

This comparison also ships in local candidates; it is not a publication-status announcement.

Baseline: published `0.1.0-preview.0`, source `3829953920ad37757178e2892f17e585ddd93006`.
Candidate: the proposed `0.1.0` version branch; use the exact committed source and integrity
in `artifacts/release-evidence.json` when selecting bytes for approval.

| Surface | Change |
| --- | --- |
| Root and protocol ESM exports / public TypeScript signatures | None intended; compare generated declarations and export maps during candidate verification |
| Generated protocol types, schemas and method maps | Unchanged; runtime remains exactly `0.153.4` |
| Runtime dependencies / Node engine range | Unchanged; installed Node 18+ compatibility, Node 22+ source build |
| Development dependencies / lockfile | Vitest floor raised to `^4.1.11`, with `@vitest/mocker` and related development/build transitive resolutions updated for the redirect-mock security fix |
| Transport, approval and turn lifecycle implementation | Unchanged; new deterministic tests exercise existing behavior |
| Default initialize client-info version | `0.1.0-preview.0` → `0.1.0`, derived from package metadata; explicit clientInfo overrides remain available |
| Release metadata and preparation tooling | Version `0.1.0`, intended `latest` tag, guarded `release:pack`; no publishing command is run automatically |

No migration is expected for existing imports or method calls. Consumers that explicitly inspect
the default client-info version must account for the metadata change. This is a non-preview **0.x**
release, not a 1.0 compatibility promise or complete high-level coverage of every protocol method.
Exact runtime compatibility and experimental transport limits remain in [COMPATIBILITY.md](../COMPATIBILITY.md).

For reproducibility, compare `src/`, `schemas/`, `package.json` exports/dependencies/engines and
`pnpm-lock.yaml` against the baseline above; also compare the packed `dist/*.d.ts` with the
retained published archive. Record results in candidate evidence, not merely this intended-delta table.

Preparation check on 2026-09-08: no source/schema/lockfile diff against that baseline. All three
built declaration files (`index.d.ts`, `protocol.d.ts`, `_tsup-dts-rollup.d.ts`) were byte-identical
to the retained registry preview archive, and exports/dependencies/engines matched. Repeat the
comparison if a later review changes code or dependencies.

Security follow-up on 2026-09-09 changes the development dependency lockfile described above;
the earlier no-lockfile-diff observation is historical, not a claim about this updated candidate.
Regenerate candidate evidence after the toolchain change; do not reuse an earlier archive hash.
