import { renameSync, rmSync } from "node:fs";

// Both staged files must already be complete and on the destination filesystem.
// A missing evidence file means there is no selected/verified candidate.
export function promoteCandidate(stagedArchive, stagedEvidence, archive, evidence, ops = { renameSync, rmSync }) {
  ops.rmSync(evidence, { force: true });
  ops.renameSync(stagedArchive, archive);
  ops.renameSync(stagedEvidence, evidence);
}
