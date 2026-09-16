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

/** Rich and multiline content always reserves a lower trailing timestamp. */
export function isPlainTextMessage(text: string): boolean {
  return Boolean(text.trim()) && !/[\n\r`*_#[\]()<>]/u.test(text);
}
