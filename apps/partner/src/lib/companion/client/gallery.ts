export type GalleryImage = { id: string; filename: string; created: number; origin: string; available: boolean; url: string };
export type GalleryRow = { kind: 'week'; key: string; label: string } | { kind: 'images'; key: string; images: GalleryImage[] };

/** Group instants by the viewer's local calendar week, newest week and image first. */
export function galleryRows(images: readonly GalleryImage[], locale = 'en'): GalleryRow[] {
  const info = (Intl.Locale.prototype as unknown as { getWeekInfo?: () => { firstDay: number; minimalDays: number } }).getWeekInfo?.call(new Intl.Locale(locale));
  const firstDay = (info?.firstDay ?? 1) % 7;
  const minimalDays = info?.minimalDays ?? 4;
  const week = (created: number) => {
    const value = new Date(created); value.setHours(0, 0, 0, 0);
    value.setDate(value.getDate() - ((value.getDay() - firstDay + 7) % 7));
    return value;
  };
  const firstWeek = (year: number) => {
    const january = new Date(year, 0, 1); const first = week(january.getTime());
    const daysInYear = 7 - ((january.getDay() - firstDay + 7) % 7);
    return new Date(first.getTime() + (daysInYear < minimalDays ? 7 : 0) * 24 * 60 * 60 * 1_000);
  };
  const weekLabel = (created: number) => {
    const date = new Date(created); const start = week(created); let year = date.getFullYear();
    if (start < firstWeek(year)) year -= 1;
    else if (start >= firstWeek(year + 1)) year += 1;
    const number = Math.floor((start.getTime() - firstWeek(year).getTime()) / (7 * 24 * 60 * 60 * 1_000)) + 1;
    return `${year} · W${number}`;
  };
  const grouped = new Map<string, { start: Date; images: GalleryImage[] }>();
  for (const image of [...images].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))) {
    const start = week(image.created); const key = String(start.getTime());
    const group = grouped.get(key) ?? { start, images: [] }; group.images.push(image); grouped.set(key, group);
  }
  return [...grouped.entries()].sort(([, a], [, b]) => b.start.getTime() - a.start.getTime()).flatMap(([key, group]) => [
    { kind: 'week' as const, key, label: weekLabel(group.images[0]!.created) },
    ...Array.from({ length: Math.ceil(group.images.length / 3) }, (_, index) => ({ kind: 'images' as const, key: `${key}:${index}`, images: group.images.slice(index * 3, index * 3 + 3) })),
  ]);
}
