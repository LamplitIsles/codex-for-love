export interface HighlightPart { text: string; matched: boolean }

/** FlickLog supplies only literal mark delimiters. Svelte renders every part as text. */
export function snippetParts(value: string): HighlightPart[] {
  const result: HighlightPart[] = [];
  let matched = false;
  for (const part of value.split(/(<\/?mark>)/gu)) {
    if (part === '<mark>') { matched = true; continue; }
    if (part === '</mark>') { matched = false; continue; }
    if (part) result.push({ text: part, matched });
  }
  return result;
}

/** Highlight a literal query inside the expanded source text. */
export function textParts(value: string, query: string): HighlightPart[] {
  if (!query) return [{ text: value, matched: false }];
  const haystack = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const result: HighlightPart[] = [];
  let offset = 0;
  while (result.length < 200) {
    const at = haystack.indexOf(needle, offset);
    if (at < 0) break;
    if (at > offset) result.push({ text: value.slice(offset, at), matched: false });
    result.push({ text: value.slice(at, at + query.length), matched: true });
    offset = at + query.length;
  }
  if (offset < value.length) result.push({ text: value.slice(offset), matched: false });
  return result;
}

export function contextTargetIndex(
  targetSourceRecordIndex: number,
  items: Array<{ sourceRecordIndex: number }>,
): number {
  return items.findIndex((item) => item.sourceRecordIndex === targetSourceRecordIndex);
}
