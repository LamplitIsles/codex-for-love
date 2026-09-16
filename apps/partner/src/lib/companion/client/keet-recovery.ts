import type { KeetLossRange } from "./companion-bridge.js";
import type { CompanionTranslate } from "./locale.js";

/** Operator-facing recovery status for retained, unrecoverable Keet ranges. */
export function keetRecoveryNotice(
  losses: readonly KeetLossRange[],
  t: CompanionTranslate,
): string | undefined {
  if (!losses.length) return undefined;
  const ranges = losses
    .map(({ first, last }) => (first === last ? `${first}` : `${first}\u2013${last}`))
    .join(", ");
  return t("keet.recoveryLoss", { ranges });
}
