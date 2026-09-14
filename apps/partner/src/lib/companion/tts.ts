export type TtsSegment = { kind: "text"; text: string } | { kind: "voice"; text: string };
const OPEN = "[[tts:text]]";
const CLOSE = "[[/tts:text]]";
const MAX_CHARS = 240;

function fenced(input: string, start: number): boolean {
  let open: string | undefined;
  let offset = 0;
  for (const line of input.split(/\n/u)) {
    if (offset >= start) break;
    const mark = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/u.exec(line)?.[1];
    if (mark) {
      if (!open) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && /^[ \t]*$/u.test(line.slice(mark.length))) open = undefined;
    }
    offset += line.length + 1;
  }
  return Boolean(open);
}

/** One valid, non-fenced passage; all invalid or additional markup stays prose. */
export function parseTtsSegments(input: string): TtsSegment[] {
  const first = input.indexOf(OPEN); if (first < 0) return [{ kind: "text", text: input }];
  const close = input.indexOf(CLOSE, first + OPEN.length); if (close < 0) return [{ kind: "text", text: input }];
  const end = close + CLOSE.length; const raw = input.slice(first + OPEN.length, close); const text = raw.replace(/[\s\u00a0]+/gu, " ").trim();
  if (!text || Array.from(text).length > MAX_CHARS || raw.includes("[[") || raw.includes("]]" ) || fenced(input, first) || input.indexOf(OPEN, end) >= 0) return [{ kind: "text", text: input }];
  return [ ...(first ? [{ kind: "text" as const, text: input.slice(0, first) }] : []), { kind: "voice", text }, ...(end < input.length ? [{ kind: "text" as const, text: input.slice(end) }] : []) ];
}
