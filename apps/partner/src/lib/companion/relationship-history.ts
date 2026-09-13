import type {
  CompanionHistoryChange,
  CompanionStateRecord,
  Mood,
} from "./domain.js";

/** Project one persisted record for the drawer without repeating carried fields. */
export function companionHistoryChanges(
  record: CompanionStateRecord,
  predecessor?: CompanionStateRecord,
): CompanionHistoryChange[] {
  if (record.changes.seed) return [];
  const changes: CompanionHistoryChange[] = [];
  const before = predecessor?.state;
  if (record.changes.mood) {
    changes.push({
      dimension: "mood",
      ...(before === undefined
        ? {}
        : {
            before: {
              value: before.mood as Mood,
              ...(before.note === undefined ? {} : { note: before.note }),
            },
          }),
      after: {
        value: record.state.mood as Mood,
        ...(record.state.note === undefined ? {} : { note: record.state.note }),
      },
      ...(record.changes.mood.reason === undefined
        ? {}
        : { reason: record.changes.mood.reason }),
    });
  }
  if (record.changes.affinity) {
    changes.push({
      dimension: "affinity",
      ...(before === undefined ? {} : { before: { value: before.affinity } }),
      after: { value: record.state.affinity },
      ...(record.changes.affinity.reason === undefined
        ? {}
        : { reason: record.changes.affinity.reason }),
    });
  }
  if (record.changes.signature) {
    changes.push({
      dimension: "signature",
      ...(before === undefined ? {} : { before: { value: before.signature } }),
      after: { value: record.state.signature },
      ...(record.changes.signature.reason === undefined
        ? {}
        : { reason: record.changes.signature.reason }),
    });
  }
  return changes;
}
