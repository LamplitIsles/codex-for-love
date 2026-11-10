# Acceptance for the first non-preview release

Target: evaluate `0.1.0`, not promise a date or a stable 1.0 API. Historical published baseline:
`0.1.0-preview.0`, bundled public runtime `0.153.4`. Changes in the `0.1.0` changelog are not in
that already-published archive. Client and runtime versions remain independent.
This checklist is a procedure, not live publication status; consult exact registry availability
and source/hash-specific acceptance records for completed releases.

## Supported scope and evidence

The primary scope is a local Node.js host / Electron main process using managed stdio, explicit
approval handlers, streaming, and persisted thread recovery. Unix attachment remains documented;
TCP WebSocket remains experimental. This is not a browser SDK, automatic reconnect/replay system,
or a promise of high-level wrappers for every generated method.

| Gate | Evidence / command | What it does not establish |
| --- | --- | --- |
| Protocol and declarations | `pnpm check` | Compatibility with arbitrary new upstream runtimes |
| Overlapping threads | `tests/release-readiness.test.ts`: two live streams, reverse completion, exact content and IDs | Arbitrary load or soak-test limits |
| Approval inheritance | Same suite: persisted restart/resume, fork, explicit override, original policy unchanged, actual command declines | Every approval type or permission profile |
| Interruption / recovery | Same suite: same-process follow-up; shipped `interrupt-resume.mjs`: new-process resume and prior history | Exactly-once replay after a lost connection |
| Process failure | Same suite: kill only the exact test-owned child, fail active stream, explicit reconnect without replay; RPC tests reject pending calls | Recovery of unfinished external side effects |
| Consumer installation | `pnpm release:pack`, npm/pnpm archive checks, three-platform CI | Successful future registry publication |
| Public source baseline | Exact generated protocol provenance and compatibility matrix | Private Desktop feature parity |
| Real account path | Manual acceptance below, pending explicit authorization | Covered by the mock tests |

New fixtures use the real pinned binary and loopback Responses service with isolated temporary
homes/workspaces. Model output is scripted; they do not use user credentials or call model services.
The approach follows the public Python SDK's testing layers, not a claim of full upstream parity.
An upstream `main` test is not evidence that the same behavior shipped in its published SDK.

## Manual account acceptance — not run automatically

Before running, record Jamin's approval of: selected account/provider and login path, exact
candidate hash, an empty test workspace, whether an existing home may be read or a dedicated
authenticated test home should be used, chosen model, usage budget, and permitted operations.
Do not copy credentials to test artifacts or enable this in ordinary CI.

Proposed first pass: one approved ChatGPT login path with managed stdio, read-only sandbox,
explicit command/file-change declines, no permission escalation, at most three short turns
(a text response, an interrupted response, and a resumed response). No deliberate tool execution.
Model billing/entitlement must be confirmed by the user; token limits are not a hard cost guarantee.
Set an overall deadline, interrupt on expiry, then close; never automatically replay a timed-out
mutating request. A model finishing before interruption is inconclusive for that scenario, not
proof of interrupt behavior. Add another attempt only within the approved budget.

Record only redacted evidence: version/hash, OS/architecture/Node, login path, pass/fail per scenario,
terminal statuses, elapsed time, and reported token usage. Do not store tokens, auth payloads,
private prompts, raw stderr, or personal thread history. List any untested API-key/device-code/
Unix-attachment path explicitly; do not infer its live acceptance from a different account path.
Authentication changes, credential cleanup, real command/file execution, and extra paid attempts
need separate approval when outside the agreed scope.

### Development baseline evidence, not final-candidate acceptance

PR [#31](https://github.com/JaminZhou/codex-app-server-client/pull/31) passed 53 deterministic tests,
cross-platform CI, npm/pnpm and Git installation checks, and a fresh clean bot review after two
test findings were fixed. On 2026-09-08, Jamin authorized three live ChatGPT turns using the
development archive from `447b77f`: completed, interrupted, completed. Restart/resume recovered
the first turn's synthetic marker, with no tool calls observed or workspace changes. A one-off
harness double-consumption error was corrected without replaying the first turn. Usage for the
first and interrupted turns was unavailable; no total-usage claim is made.

That archive was still labeled `0.1.0-preview.0` and was never published. Its live acceptance
does not automatically certify new candidate bytes. [The API comparison](./api-diff-0.1.0.md)
records the planned delta; repeat account acceptance on final candidate bytes only with renewed
authorization. Do not silently spend additional model usage based on the completed three-turn budget.

## Candidate decision

- [ ] Current proposed source passes required checks and local CR; any regressions are fixed.
- [ ] Final PR head has successful required platform CI, a fresh clean bot review, and no unresolved
  actionable bot threads. Human threads require their author's / Jamin's direction.
- [ ] Review Node/OS support claims against tested environments; Node 18 compatibility does not
  imply the upstream runtime is still security-maintained. No platform expansion by assumption.
- [ ] The agreed live-account acceptance is recorded; untested paths and limitations are disclosed.
- [ ] No unresolved unauthorized execution, credential exposure, lost/cross-routed data, or hanging
  lifecycle defect in the supported scope.
- [ ] Version/CHANGELOG/README/security policy agree; an API diff identifies any breaking changes.
- [ ] The actual NEW candidate is built from clean reviewed source, hashed and installed with npm
  and pnpm. Do not reuse the hash or tests of an earlier candidate after changing its contents.
- [ ] Jamin explicitly approves publishing that exact candidate as `0.1.0` to `latest`.
- [ ] After publication: verify registry version, all tags and downloaded integrity; install exact
  registry bytes in fresh consumers and repeat smoke checks before declaring publication complete.

These boxes are release gates, not a report that they have already passed. Fixes and document edits
alone do not authorize merging, changing registry tags, publishing, or creating a GitHub release.
