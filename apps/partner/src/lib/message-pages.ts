/** Merge independent history pages and change batches without regressing an input. */
export function mergeMessages<T extends { id: string; sequence: number; revision: number }>(current: readonly T[], incoming: readonly T[]): T[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    if (!previous || message.revision > previous.revision) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a,b) => a.sequence-b.sequence);
}

/** Merge canonical turn results, keeping a newer result over a stale page. */
export function mergeResults<T extends { id: string; sequence: number; revision: number }>(current: readonly T[], incoming: readonly T[]): T[] {
  const results = new Map(current.map(result => [result.id, result]));
  for (const result of incoming) {
    const previous = results.get(result.id);
    if (!previous || result.revision > previous.revision) results.set(result.id, result);
  }
  return [...results.values()].sort((a, b) => a.sequence - b.sequence || a.revision - b.revision);
}
