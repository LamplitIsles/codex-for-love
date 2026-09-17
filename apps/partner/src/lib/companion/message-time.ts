/** Local transcript time without storing a time zone alongside the message. */
export function formatMessageTime(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

export function messageTimeDateTime(value: number): string {
  return new Date(value).toISOString();
}

export type MessageTimePlacement = "none" | "inline" | "bubble-trailing" | "stack-trailing";

/** Keep text-message times inside their bubble when they cannot share its final line. */
export function messageTimePlacement(
  hasTime: boolean,
  inlineCandidate: boolean,
  hasTrailingTextBubble: boolean,
): MessageTimePlacement {
  if (!hasTime) return "none";
  if (inlineCandidate) return "inline";
  return hasTrailingTextBubble ? "bubble-trailing" : "stack-trailing";
}

/** A timestamp shares text only for a genuinely one-line visual message. */
export function messageTimeFitsInline(
  visualLineCount: number,
  sharesOnlyLine: boolean,
): boolean {
  return visualLineCount === 1 && sharesOnlyLine;
}

/** Rich and multiline content always reserves a lower trailing timestamp. */
export function isPlainTextMessage(text: string): boolean {
  return Boolean(text.trim()) && !/[\n\r`*_#[\]()<>]/u.test(text);
}
