// Local, display-only examples using the same contract and tool-result envelope
// as a real Companion send_ui call. Images already belong to the conversation.
import { A2UI_BASIC_CATALOG_ID } from '@lamplit/contracts';
import { sendUiResult } from '../runtime/ui-dispatch.ts';

const image = (name: string) => `workspace:${encodeURIComponent(`.lamplit/historical-media/${name}.jpg`)}`;

const surfaces = [
  { version: '1.0', createSurface: { surfaceId: 'dev-seaside', catalogId: A2UI_BASIC_CATALOG_ID,
    dataModel: { title: '给海边留一点时间', note: '不用赶路，选一个喜欢的角落坐一会儿。' },
    components: [
      { id: 'root', component: 'Card', child: 'layout' },
      { id: 'layout', component: 'Column', children: ['title', 'note', 'photo', 'divider', 'tabs', 'modal'] },
      { id: 'title', component: 'Text', text: { '@path': '/title' } },
      { id: 'note', component: 'Text', text: { '@path': '/note' }, variant: 'caption' },
      { id: 'divider', component: 'Divider' },
      { id: 'tabs', component: 'Tabs', tabs: [{ title: '看海', child: 'sea' }, { title: '出发前', child: 'packing' }] },
      { id: 'sea', component: 'Column', children: ['sea-caption'] },
      { id: 'photo', component: 'Image', url: image('sea'), description: '明亮的海面', variant: 'mediumFeature', fit: 'cover' },
      { id: 'sea-caption', component: 'Text', text: '海风、阳光，还有没有排满的下午。' },
      { id: 'packing', component: 'List', children: ['coat', 'water', 'time'] },
      { id: 'coat', component: 'Text', text: '带一件挡风的外套' },
      { id: 'water', component: 'Text', text: '装一瓶水' },
      { id: 'time', component: 'Text', text: '留一点发呆的时间' },
      { id: 'modal', component: 'Modal', trigger: 'open', content: 'detail' },
      { id: 'open', component: 'Button', child: 'open-label', action: { event: { name: 'open_modal' } }, variant: 'primary' },
      { id: 'open-label', component: 'Text', text: '打开小约定' },
      { id: 'detail', component: 'Column', children: ['detail-title', 'detail-text'] },
      { id: 'detail-title', component: 'Text', text: '我们的海边约定' },
      { id: 'detail-text', component: 'Text', text: '天气好就去，不好也没关系。记得慢慢走。' },
    ],
  } },
  { version: '1.0', createSurface: { surfaceId: 'dev-small-moments', catalogId: A2UI_BASIC_CATALOG_ID,
    components: [
      { id: 'root', component: 'Column', children: ['heading', 'intro', 'gallery', 'tabs', 'modal'] },
      { id: 'heading', component: 'Row', children: ['icon', 'title'], align: 'center' },
      { id: 'icon', component: 'Icon', name: 'favorite' },
      { id: 'title', component: 'Text', text: '今天的小收藏' },
      { id: 'intro', component: 'Text', text: '两张照片，两种慢下来的方式。', variant: 'caption' },
      { id: 'gallery', component: 'Row', children: ['coffee-image', 'cat-image'] },
      { id: 'tabs', component: 'Tabs', tabs: [{ title: '咖啡', child: 'coffee-card' }, { title: '猫咪', child: 'cat-card' }] },
      { id: 'coffee-card', component: 'Card', child: 'coffee' },
      { id: 'coffee', component: 'Column', children: ['coffee-text'] },
      { id: 'coffee-image', component: 'Image', url: image('coffee'), description: '窗边的一杯咖啡', variant: 'smallFeature', fit: 'cover' },
      { id: 'coffee-text', component: 'Text', text: '找个靠窗的位置，慢慢喝。' },
      { id: 'cat-card', component: 'Card', child: 'cat' },
      { id: 'cat', component: 'Column', children: ['cat-text'] },
      { id: 'cat-image', component: 'Image', url: image('cat'), description: '晒太阳的猫', variant: 'smallFeature', fit: 'cover' },
      { id: 'cat-text', component: 'Text', text: '向晒太阳的专家学习休息。' },
      { id: 'modal', component: 'Modal', trigger: 'open', content: 'detail' },
      { id: 'open', component: 'Button', child: 'open-label', action: { event: { name: 'open_modal' } } },
      { id: 'open-label', component: 'Text', text: '看看今天的备注' },
      { id: 'detail', component: 'Text', text: '不必把每一分钟都填满，休息也是今天的一部分。' },
    ],
  } },
] as const;

export function developmentUiItem(index: 0 | 1) {
  const result = sendUiResult(surfaces[index]);
  if ('isError' in result && result.isError) throw new Error('Invalid development A2UI example');
  return { type: 'mcpToolCall', id: `dev-ui-${index}`, server: 'companion', tool: 'send_ui', status: 'completed', arguments: { ui: surfaces[index] }, error: null, result };
}

// For an explicitly managed, stopped development fixture: append this turn once
// after checking for conflicting IDs. The caller owns locking and state updates.
export function developmentUiDemoTurn(at: number) {
  return { id: 'dev-a2ui-demo-v1', status: 'completed', startedAt: Math.floor(at / 1000), completedAt: Math.floor(at / 1000), items: [
    { type: 'userMessage', id: 'dev-a2ui-demo-user-v1', clientId: 'dev-a2ui-demo-input-v1', content: [{ type: 'text', text: '给我看看今天的小卡片。' }] },
    { type: 'agentMessage', id: 'dev-a2ui-demo-reply-v1', text: '【模拟示例】这是两张可以浏览的小卡片。', phase: 'final_answer' },
    developmentUiItem(0), developmentUiItem(1),
  ] };
}
