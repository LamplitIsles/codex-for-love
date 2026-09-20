import assert from 'node:assert/strict';
import { test } from 'node:test';
import { galleryRows } from '../src/lib/companion/client/gallery.ts';

test('gallery rows group local calendar weeks descending with newest images first', () => {
  const rows = galleryRows([
    { id: 'old', filename: 'old.png', created: new Date(2026, 0, 5, 9).getTime(), origin: 'human', available: true, url: '/old' },
    { id: 'newer', filename: 'newer.png', created: new Date(2026, 0, 12, 9).getTime(), origin: 'agent', available: true, url: '/newer' },
    { id: 'newest', filename: 'newest.png', created: new Date(2026, 0, 12, 10).getTime(), origin: 'historical', available: true, url: '/newest' },
  ], 'en-GB');
  assert.deepEqual(rows.map((row) => row.kind === 'group' ? `week:${row.key}` : row.images.map((image) => image.id).join(',')), [
    `week:${new Date(2026, 0, 12).setHours(0, 0, 0, 0)}`, 'newest,newer', `week:${new Date(2026, 0, 5).setHours(0, 0, 0, 0)}`, 'old',
  ]);
  assert.deepEqual(rows.filter((row) => row.kind === 'group').map((row) => row.label), ['2026 · W3', '2026 · W2']);
});

test('gallery week labels retain the calendar year at a year boundary', () => {
  const rows = galleryRows([
    { id: 'end', filename: 'end.png', created: new Date(2026, 11, 31, 12).getTime(), origin: 'human', available: true, url: '/end' },
    { id: 'start', filename: 'start.png', created: new Date(2027, 0, 1, 12).getTime(), origin: 'agent', available: true, url: '/start' },
  ], 'en-GB');
  assert.equal(rows.filter((row) => row.kind === 'group').length, 1);
  assert.equal(rows[0]?.kind === 'group' && rows[0].label, '2026 · W53');
});

test('gallery rows can group local calendar days descending', () => {
  const newest = new Date(2026, 0, 12, 10).getTime();
  const earlierSameDay = new Date(2026, 0, 12, 9).getTime();
  const previousDay = new Date(2026, 0, 11, 23).getTime();
  const rows = galleryRows([
    { id: 'previous-day', filename: 'previous-day.png', created: previousDay, origin: 'human', available: true, url: '/previous-day' },
    { id: 'earlier-same-day', filename: 'earlier-same-day.png', created: earlierSameDay, origin: 'agent', available: true, url: '/earlier-same-day' },
    { id: 'newest', filename: 'newest.png', created: newest, origin: 'historical', available: true, url: '/newest' },
  ], 'en-GB', 'day');
  const format = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  assert.deepEqual(rows.map((row) => row.kind === 'group' ? `day:${row.key}:${row.label}` : row.images.map((image) => image.id).join(',')), [
    `day:${new Date(newest).setHours(0, 0, 0, 0)}:${format.format(new Date(newest))}`,
    'newest,earlier-same-day',
    `day:${new Date(previousDay).setHours(0, 0, 0, 0)}:${format.format(new Date(previousDay))}`,
    'previous-day',
  ]);
});
