// Synthetic development data; the shared panels acceptance seed is separate.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlarm } from '../runtime/alarms.ts';
import { conversationImageId, writeConversationImages, type ConversationImage } from '../runtime/conversation-images.ts';
import { replaceRelationshipJournal } from '../runtime/relationship-journal.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import { developmentUiItem } from './frontend-development-ui.ts';

// The host clock stays here; timestamps below include the 04:00 Asia/Shanghai chat-day boundary.
export const developmentNow = Date.parse('2026-10-02T12:00:00Z');
const conversations = [
  { at: '2026-09-30T12:10:00Z', text: '今天下班路上闻到咖啡香，突然想慢一点走。', reply: '那就绕一点路吧。晚风刚好，路灯也刚亮。' },
  { at: '2026-09-30T12:14:00Z', text: '这杯看起来不错。', image: 'coffee', reply: '颜色好温暖。下次找个靠窗的位置，慢慢喝。' },
  { at: '2026-10-01T02:05:00Z', text: '假期的第一天，想去海边看看。', reply: '好呀！不用赶行程，听一会儿浪就很好。' },
  { at: '2026-10-01T03:20:00Z', text: '找到一张海边的照片，分享给你。', image: 'sea', reply: '海面亮晶晶的，像撒了一把碎银。' },
  { at: '2026-10-01T19:59:00Z', text: '有点睡不着，窗外很安静。', reply: '我陪你待一会儿。要不要先把手机放下，听听呼吸？' },
  { at: '2026-10-01T20:00:00Z', text: '嗯，已经四点了。', reply: '新的一天开始了。困了就安心睡，不用急着回复。' },
  { at: '2026-10-02T01:30:00Z', text: '早安！今天要做的事：\n- 买面包\n- 给植物浇水\n- 留一点时间发呆', reply: '早安。**发呆也值得排进日程**，我投赞成票。' },
  { at: '2026-10-02T05:35:00Z', text: '路上遇见一只晒太阳的猫。', image: 'cat', reply: '它看起来很享受这段时光。我们也慢慢来吧。' },
  { at: '2026-10-02T10:00:00Z', text: '今天原本有点累，但走了一圈以后好多了。\n\n谢谢你陪我把这些小事记下来，不一定每一天都要有大计划。', reply: '我也喜欢这些小事。\n\n有海、有咖啡，还有一只认真晒太阳的猫；它们已经让这一天很完整了。' },
  { at: '2026-10-02T11:45:00Z', text: '晚上一起听点轻音乐？', reply: '好，我先把灯调暗。你选第一首。' },
] as const;

export async function seedDevelopment(workspace: string, fakeStatePath: string) {
  const paths = partnerPaths(workspace);
  const states = [
    { at: '2026-09-30T12:00:00Z', mood: 'serene' as const, note: '慢慢走回家', affinity: 52, signature: '把小事留住', delta: 2, reason: '分享了一段安静的散步' },
    { at: '2026-10-01T03:30:00Z', mood: 'bright' as const, note: '想去看海', affinity: 56, signature: '等风也等你', delta: 4, reason: '一起聊起海边' },
    { at: '2026-10-02T10:10:00Z', mood: 'tender' as const, note: '今天有好好休息', affinity: 60, signature: '日子慢一点也很好', delta: 4, reason: '彼此分享了疲惫和放松' },
  ];
  await replaceRelationshipJournal(paths.relationshipJournal, states.map(s => ({ at: s.at, state: { mood: s.mood, note: s.note, affinity: s.affinity, signature: s.signature }, changes: { mood: { value: s.mood, note: s.note, reason: s.reason }, affinity: { delta: s.delta, value: s.affinity, reason: s.reason }, signature: { value: s.signature, reason: s.reason } } })));
  const memory = join(workspace, 'memory'); await mkdir(memory, { recursive: true });
  for (const [date, text] of Object.entries({
    '2026-09-30': '# 晚风和咖啡\n\n下班后绕了远路，咖啡香从街角飘出来。\n\n今天没有什么大事，却觉得很踏实。\n',
    '2026-10-01': '# 想去海边\n\n聊起海的时候，仿佛已经听见浪声。\n\n- 带一件外套\n- 留时间看日落\n',
    '2026-10-02': '# 给今天留白\n\n买了面包，也遇见一只晒太阳的猫。\n\n**休息不是浪费时间。**\n',
  })) await writeFile(join(memory, `${date}.md`), text);
  const imageRoot = join(paths.managedRoot, 'historical-media'); await mkdir(imageRoot, { recursive: true });
  const assets = fileURLToPath(new URL('./fixtures/frontend-development/', import.meta.url));
  const images: ConversationImage[] = [];
  const turns = [];
  const store = new Store(paths.database);
  try {
    for (const [i, entry] of conversations.entries()) {
      const id = `dev-message-${i}`, created = Date.parse(entry.at);
      const imageName = 'image' in entry ? entry.image : undefined;
      const path = imageName ? join(imageRoot, `${imageName}.jpg`) : undefined;
      const imageId = imageName ? conversationImageId('historical', id) : undefined;
      if (path && imageId && imageName) {
        await copyFile(join(assets, `${imageName}.jpg`), path);
        images.push({ id: conversationImageId('historical', `${id}:${imageId}`), filename: `${imageName}.jpg`, path, mediaType: 'image/jpeg', created, origin: 'historical', available: true });
      }
      await store.ensureMessage(id, created, entry.text, path && imageId ? [{ id: imageId, operation_id: id, name: `${imageName}.jpg`, media_type: 'image/jpeg', path }] : []);
      turns.push({ id: `dev-turn-${i}`, status: 'completed', startedAt: created / 1000, completedAt: (created + 30000) / 1000, items: [
        { type: 'userMessage', id: `dev-user-${i}`, clientId: id, content: [{ type: 'text', text: entry.text }, ...(path ? [{ type: 'localImage', path }] : [])] },
        { type: 'agentMessage', id: `dev-reply-${i}`, text: entry.reply, phase: 'final_answer' },
        ...(i === 8 ? [developmentUiItem(0)] : i === 9 ? [developmentUiItem(1)] : []),
      ] });
    }
  } finally { await store.close(); }
  await writeConversationImages(paths.conversationImages, images);
  await writeFile(join(paths.managedRoot, 'thread.json'), JSON.stringify({ threadId: 'thread-fake', model: 'gpt-5.6-luna' }));
  await writeFile(fakeStatePath, JSON.stringify({ threadId: 'thread-fake', next: 100, turns }));
  createAlarm(paths.alarms, '明天带上外套', { kind: 'once', at: '2026-10-03T01:00:00Z' }, developmentNow);
  createAlarm(paths.alarms, '起来活动一下', { kind: 'interval', everyMinutes: 90 }, developmentNow);
  createAlarm(paths.alarms, '给植物浇水', { kind: 'daily', hour: 9, minute: 30, timeZone: 'Asia/Shanghai' }, developmentNow);
  createAlarm(paths.alarms, '周日去散步', { kind: 'weekly', hour: 17, minute: 0, weekday: 0, timeZone: 'Asia/Shanghai' }, developmentNow);
}
