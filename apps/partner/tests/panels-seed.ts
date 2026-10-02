import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../runtime/store.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { replaceRelationshipJournal } from '../runtime/relationship-journal.ts';
import { conversationImageId, writeConversationImages } from '../runtime/conversation-images.ts';

// Values follow the app's frozen acceptance fixture; all paths belong to the caller.
export const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAIAAABAJy5dAAABM0lEQVR4nM3OzUrDUBCG4bkO94K4EZEipZQS0zTGNI1Jmv5YrVarorfkBXkB3oxLF4EjNPHMlzIOB57lzMdLJ17mFDq9yJ1CZ37hFOoMp06h86B0CnVHM3Hfn2914C/1wrmsxpoK8k79y4UgS02FXaBBtBTEBrEL5F3dCGKD2AXy45UgNohdoGB8K4gNYhcoTO4EsUHsAkWTtSA2iF2gOL2XZalB3im5fhDXWAP+UpptnEJZ/viXg+OjiuVGHBXF0w7TYdRv/g+V022l3mGYGwVk6TDm5bMaKGg5e7H4+pjsp3ENCjrs+qxWKZYdLKg3AvEp3AIW1I9aaU7BfrGgwXgPvyltvrAgL1WDBfm5GiwoKNVgQeFCDRYUrdRgQfFaDRaUbNRgQelWDRaUvarBgop3NT+e7i4f/0qiDgAAAABJRU5ErkJggg==', 'base64');
export const seedNow = Date.UTC(2026, 9, 2, 12);
export async function seedPanels(workspace: string, fakeStatePath?: string) {
  const paths = partnerPaths(workspace);
  const state = { mood: 'bright' as const, note: '一起看灯火', affinity: 65, signature: '今晚也有光' };
  const records = Array.from({ length: 25 }, (_, i) => ({ at: new Date(seedNow - (24 - i) * 60000).toISOString(), state: { ...state, affinity: 41 + i }, changes: { affinity: { delta: i === 0 ? -9 : 1, value: 41 + i, reason: `一起走过第 ${i + 1} 段路` } } }));
  await replaceRelationshipJournal(paths.relationshipJournal, records);
  const memory = join(workspace, 'memory'); await mkdir(memory, { recursive: true });
  const dates = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2026, 9, 2) - i * 86400000).toISOString().slice(0, 10) + '.md');
  for (const name of dates) await writeFile(join(memory, name), '# 灯火日记\n\n今天一起走过小岛。\n\n[看看海](https://example.com/diary)');
  await writeFile(join(memory, dates[2]!), 'x'.repeat(128 * 1024 + 1));
  await writeFile(join(memory, 'notes.md'), 'not a diary');
  const imageRoot = join(workspace, '.lamplit', 'historical-media'); await mkdir(imageRoot, { recursive: true });
  const images = Array.from({ length: 35 }, (_, i) => ({ id: conversationImageId('historical', `fixture-${35 - i}`), filename: `灯火-${35 - i}.png`, path: join(imageRoot, `${35 - i}.png`), mediaType: 'image/png', created: Date.UTC(2026, 9, 2) - i * 3600000, origin: 'historical' as const, available: i !== 1 }));
  for (const image of images) if (image.available) await writeFile(image.path, fixtureImage);
  const store = new Store(paths.database);
  const turns = [];
  try {
    for (const [i, image] of images.entries()) {
      const sourceId = `fixture-image-${i}`;
      const storedId = conversationImageId('historical', sourceId);
      image.id = conversationImageId('historical', `${sourceId}:${storedId}`);
      await store.ensureMessage(sourceId, image.created, '', [{ id: storedId, operation_id: sourceId, name: image.filename, media_type: 'image/png', path: image.path }]);
      turns.unshift({ id: `fixture-turn-${i}`, status: 'completed', startedAt: image.created / 1000, completedAt: image.created / 1000,
        items: [{ type: 'userMessage', id: `fixture-item-${i}`, clientId: sourceId, content: [{ type: 'localImage', path: image.path }] }] });
    }
  } finally { await store.close(); }
  await writeConversationImages(paths.conversationImages, images);
  if (fakeStatePath) {
    await writeFile(join(paths.managedRoot, 'thread.json'), JSON.stringify({ threadId: 'thread-fake', model: 'gpt-5.6-luna' }));
    await writeFile(fakeStatePath, JSON.stringify({ threadId: 'thread-fake', next: 100, turns }));
  }
  const reminders = [
    createAlarm(paths.alarms, '带上围巾', { kind: 'once', at: new Date(Date.UTC(2026, 9, 3)).toISOString() }, seedNow),
    createAlarm(paths.alarms, '休息一下', { kind: 'interval', everyMinutes: 5 }, seedNow),
    createAlarm(paths.alarms, '喝水', { kind: 'daily', hour: 9, minute: 30, timeZone: 'Asia/Shanghai' }, seedNow),
    createAlarm(paths.alarms, '周日看灯', { kind: 'weekly', hour: 20, minute: 0, weekday: 0, timeZone: 'Asia/Shanghai' }, seedNow),
  ];
  return { dates, records, images, reminders };
}
