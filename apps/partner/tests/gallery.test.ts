import assert from 'node:assert/strict';
import { test } from 'node:test';
import { galleryRows } from '../src/lib/companion/client/gallery.ts';

test('gallery rows group local calendar weeks descending with newest images first', () => {
  const rows = galleryRows([
    { id: 'old', filename: 'old.png', created: new Date(2026, 0, 5, 9).getTime(), origin: 'owner', available: true, url: '/old' },
    { id: 'newer', filename: 'newer.png', created: new Date(2026, 0, 12, 9).getTime(), origin: 'partner', available: true, url: '/newer' },
    { id: 'newest', filename: 'newest.png', created: new Date(2026, 0, 12, 10).getTime(), origin: 'historical', available: true, url: '/newest' },
  ], 'en-GB');
  assert.deepEqual(rows.map((row) => row.kind === 'week' ? `week:${row.key}` : row.images.map((image) => image.id).join(',')), [
    `week:${new Date(2026, 0, 12).setHours(0, 0, 0, 0)}`, 'newest,newer', `week:${new Date(2026, 0, 5).setHours(0, 0, 0, 0)}`, 'old',
  ]);
  assert.deepEqual(rows.filter((row) => row.kind === 'week').map((row) => row.label), ['2026 · W3', '2026 · W2']);
});

test('gallery week labels retain the calendar year at a year boundary', () => {
  const rows = galleryRows([
    { id: 'end', filename: 'end.png', created: new Date(2026, 11, 31, 12).getTime(), origin: 'owner', available: true, url: '/end' },
    { id: 'start', filename: 'start.png', created: new Date(2027, 0, 1, 12).getTime(), origin: 'partner', available: true, url: '/start' },
  ], 'en-GB');
  assert.equal(rows.filter((row) => row.kind === 'week').length, 1);
  assert.equal(rows[0]?.kind === 'week' && rows[0].label, '2026 · W53');
});
