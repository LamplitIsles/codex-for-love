import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Repository-only JavaScript tooling has no public declaration.
import { promoteCandidate } from "../scripts/promote-candidate.mjs";

it.each([0, 1, 2])("never leaves stale evidence when promotion fails at rename %i", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "candidate-promotion-"));
  try {
    const archive = join(root, "candidate.tgz");
    const evidence = join(root, "evidence.json");
    const stagedArchive = join(root, "new.tgz");
    const stagedEvidence = join(root, "new.json");
    writeFileSync(archive, "old archive"); writeFileSync(evidence, "old evidence");
    writeFileSync(stagedArchive, "new archive"); writeFileSync(stagedEvidence, "new evidence");
    let renames = 0;
    const promote = () => promoteCandidate(stagedArchive, stagedEvidence, archive, evidence, {
      rmSync,
      renameSync: (from: string, to: string) => {
        expect(existsSync(evidence)).toBe(false);
        if (++renames === failure) throw new Error("injected promotion failure");
        renameSync(from, to);
      },
    });
    if (failure) {
      expect(promote).toThrow("injected promotion failure");
      expect(existsSync(evidence)).toBe(false);
      expect(readFileSync(archive, "utf8")).toBe(failure === 1 ? "old archive" : "new archive");
    } else {
      promote();
      expect(readFileSync(archive, "utf8")).toBe("new archive");
      expect(readFileSync(evidence, "utf8")).toBe("new evidence");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
