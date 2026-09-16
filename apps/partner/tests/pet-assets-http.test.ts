import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localPetClip } from '../runtime/pet-assets.ts';
import type { Partner } from '../runtime/partner.ts';
import { createWebServer } from '../runtime/server.ts';

const activities = ['idle', 'thinking', 'read', 'work', 'replying', 'success', 'concern'] as const;

test('pet asset HTTP route exposes only a complete valid local set', async () => {
  const state = await mkdtemp(join(tmpdir(), 'lamplit-pet-http-')); const assets = join(state, 'build'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<!doctype html>');
  const root = join(state, 'pet-assets'); await mkdir(root);
  const clips = Object.fromEntries(activities.map((activity) => [activity, { file: `${activity}.webp`, frameCount: ['thinking', 'work', 'replying'].includes(activity) ? 8 : 6, fps: activity === 'replying' ? 10 : 6, loop: activity !== 'success' }]));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, character: 'shio', revision: 'fixture', clips }));
  await Promise.all(activities.map((activity) => writeFile(join(root, `${activity}.webp`), webp(clips[activity].frameCount * 512, 512))));
  let enabled = false;
  const partner = { petAsset: (activity: typeof activities[number]) => enabled ? localPetClip(state, activity) : Promise.resolve(undefined), close: async () => {} } as unknown as Partner;
  const app = createWebServer(partner, assets); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/api/pet-assets/idle`)).status, 404);
    enabled = true; const valid = await fetch(`${base}/api/pet-assets/replying`); assert.equal(valid.status, 200); assert.equal(valid.headers.get('content-type'), 'image/webp'); assert.equal(valid.headers.get('cache-control'), 'no-store'); assert.equal(valid.headers.get('x-pet-frame-count'), '8'); assert.equal(valid.headers.get('x-pet-fps'), '10'); assert.equal(valid.headers.get('x-pet-loop'), 'true');
    await writeFile(join(root, 'idle.webp'), webp(512, 512)); assert.equal((await fetch(`${base}/api/pet-assets/idle`)).status, 404);
    await writeFile(join(root, 'idle.webp'), Buffer.alloc(1_500_001)); assert.equal((await fetch(`${base}/api/pet-assets/idle`)).status, 404);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

function webp(width: number, height: number): Buffer { const data = Buffer.alloc(30); data.write('RIFF'); data.writeUInt32LE(22, 4); data.write('WEBP', 8); data.write('VP8X', 12); data.writeUInt32LE(10, 16); data[24] = (width - 1) & 255; data[25] = ((width - 1) >> 8) & 255; data[26] = ((width - 1) >> 16) & 255; data[27] = (height - 1) & 255; data[28] = ((height - 1) >> 8) & 255; data[29] = ((height - 1) >> 16) & 255; return data; }
