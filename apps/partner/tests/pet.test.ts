import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../runtime/config.ts';
import { activityForItem, PetActivityProjection } from '../runtime/pet.ts';
import { localPetManifest } from '../runtime/pet-assets.ts';
import { defaultDock, dockPoint, keyboardDock, snapDock } from '../src/lib/pet/dock.ts';
import { clipPlan, nextFrame } from '../src/lib/pet/playback.ts';

test('pet configuration defaults off and finite projection never carries execution content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-pet-test-'));
  try {
    const config = join(directory, 'partner.toml');
    await writeFile(config, 'name="Mica"\npersona="persona.md"\nstate="state"\n');
    assert.equal((await loadConfig(config)).pet.enabled, false);
    await writeFile(config, 'name="Mica"\npersona="persona.md"\nstate="state"\n[pet]\nenabled=true\n');
    assert.equal((await loadConfig(config)).pet.enabled, true);
    const pet = new PetActivityProjection(); pet.turnStarted(); pet.itemStarted({ type: 'agentMessage', text: 'secret answer' });
    assert.deepEqual(pet.snapshot(), { activity: 'replying', revision: 2 });
    assert.equal(JSON.stringify(pet.snapshot()).includes('secret'), false);
    assert.equal(activityForItem({ type: 'mcpToolCall', server: 'companion', tool: 'read_relationship_history', arguments: { private: 'nope' } }), 'read');
    assert.equal(activityForItem({ type: 'commandExecution', command: 'secret command' }), 'work');
    assert.equal(activityForItem({ type: 'mcpToolCall', server: 'keet', tool: 'keet_send_message' }), 'replying');
    assert.equal(activityForItem({ type: 'mcpToolCall', server: 'keet', tool: 'keet_read_recent_messages' }), 'read');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a pet override needs every regular local clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-pet-assets-test-'));
  try {
    const root = join(directory, 'pet-assets'); await mkdir(root);
    const names = ['idle', 'thinking', 'read', 'work', 'replying', 'success', 'concern'];
    const clips = Object.fromEntries(names.map((name) => [name, { file: `${name}.webp`, frameCount: name === 'thinking' || name === 'work' || name === 'replying' ? 8 : 6, fps: 6, loop: name !== 'success' }]));
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, character: 'shio', revision: 'fixture', clips }));
    assert.equal(await localPetManifest(directory), undefined);
    await Promise.all(names.map((name) => writeFile(join(root, `${name}.webp`), webp(name === 'thinking' || name === 'work' || name === 'replying' ? 4096 : 3072, 512))));
    assert.equal((await localPetManifest(directory))?.character, 'shio');
    await writeFile(join(root, 'idle.webp'), webp(512, 512)); assert.equal(await localPetManifest(directory), undefined);
    await writeFile(join(root, 'idle.webp'), webp(3072, 512)); assert.equal((await localPetManifest(directory))?.character, 'shio');
    await rm(join(root, 'read.webp')); assert.equal(await localPetManifest(directory), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pet transient expiry notifies subscribers and retains another active item', async () => {
  let changes = 0; const pet = new PetActivityProjection(() => { changes += 1; }, { success: 5, concern: 5 });
  pet.turnStarted(); pet.itemStarted({ id: 'read', type: 'webSearch' }); pet.itemStarted({ id: 'reply', type: 'agentMessage' }); pet.itemCompleted({ id: 'read', type: 'webSearch' });
  assert.equal(pet.snapshot().activity, 'replying'); pet.turnCompleted('completed'); assert.equal(pet.snapshot().activity, 'success'); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(pet.snapshot().activity, 'idle'); assert.equal(changes >= 5, true);
});

test('playback and dock helpers honor manifest metadata and current placement', () => {
  assert.deepEqual(clipPlan(new Headers([['x-pet-frame-count', '6'], ['x-pet-fps', '10'], ['x-pet-loop', 'false']])), { frameCount: 6, fps: 10, loop: false });
  assert.equal(nextFrame(4, 200, { frameCount: 6, fps: 10, loop: false }), 5); assert.equal(nextFrame(5, 200, { frameCount: 6, fps: 10, loop: true }), 1);
  const view = { width: 800, height: 600, size: 128 }; const initial = defaultDock(view); const point = dockPoint(initial, view); assert.equal(point.y > 300, true); const moved = keyboardDock(initial, 'ArrowUp', view)!; assert.equal(dockPoint(moved, view).y < point.y, true); assert.deepEqual(snapDock({ x: 400, y: 580 }, view).edge, 'bottom');
});

function webp(width: number, height: number): Buffer { const data = Buffer.alloc(30); data.write('RIFF'); data.writeUInt32LE(22, 4); data.write('WEBP', 8); data.write('VP8X', 12); data.writeUInt32LE(10, 16); data[24] = (width - 1) & 255; data[25] = ((width - 1) >> 8) & 255; data[26] = ((width - 1) >> 16) & 255; data[27] = (height - 1) & 255; data[28] = ((height - 1) >> 8) & 255; data[29] = ((height - 1) >> 16) & 255; return data; }
