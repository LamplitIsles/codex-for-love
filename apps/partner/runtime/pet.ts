/** The deliberately small, browser-safe representation of companion activity. */
export const PET_ACTIVITIES = ['idle', 'thinking', 'read', 'work', 'replying', 'success', 'concern'] as const;
export type PetActivity = typeof PET_ACTIVITIES[number];
export type PetSnapshot = { activity: PetActivity; revision: number };

type Item = Record<string, unknown>;

/**
 * Converts app-server lifecycle metadata into a finite presentation state.
 * Never retain item text, arguments, results, paths, commands, or errors here.
 */
export class PetActivityProjection {
  #activity: PetActivity = 'idle'; #revision = 0; #turnActive = false; #items = new Map<string, PetActivity>(); #timer: ReturnType<typeof setTimeout> | undefined;
  #changed: () => void; #durations: { success: number; concern: number };
  constructor(changed: () => void = () => {}, durations = { success: 1200, concern: 2000 }) { this.#changed = changed; this.#durations = durations; }
  snapshot(): PetSnapshot { return { activity: this.#activity, revision: this.#revision }; }
  close(): void { if (this.#timer) clearTimeout(this.#timer); }
  idle(): void { this.#turnActive = false; this.#items.clear(); this.#set('idle'); }
  turnStarted(): void { this.#turnActive = true; this.#set('thinking'); }
  itemStarted(item: Item): void {
    this.#turnActive = true;
    const activity = activityForItem(item); const id = typeof item.id === 'string' ? item.id : `anonymous:${this.#items.size}`;
    this.#items.set(id, activity); this.#set(activity);
  }
  itemCompleted(item: Item): void {
    const id = typeof item.id === 'string' ? item.id : undefined; if (id) this.#items.delete(id);
    if (failedItem(item)) this.#transient('concern', 2000);
    else this.#set(this.#current());
  }
  turnCompleted(status: unknown): void {
    this.#turnActive = false; this.#items.clear();
    this.#transient(['failed', 'cancelled', 'interrupted'].includes(String(status)) ? 'concern' : 'success',
      ['failed', 'cancelled', 'interrupted'].includes(String(status)) ? this.#durations.concern : this.#durations.success);
  }
  #current(): PetActivity { return [...this.#items.values()].at(-1) ?? (this.#turnActive ? 'thinking' : 'idle'); }
  #transient(activity: PetActivity, ms: number): void { this.#set(activity); if (this.#timer) clearTimeout(this.#timer); this.#timer = setTimeout(() => { this.#timer = undefined; this.#set(this.#current()); }, ms); }
  #set(activity: PetActivity): void { if (this.#timer && !['success', 'concern'].includes(activity)) { clearTimeout(this.#timer); this.#timer = undefined; } if (this.#activity !== activity) { this.#activity = activity; this.#revision += 1; this.#changed(); } }
}

export function activityForItem(item: Item): PetActivity {
  switch (item.type) {
    case 'agentMessage': return 'replying'; // item start is sufficient; no delta text is read.
    case 'webSearch': case 'web': return 'read';
    case 'commandExecution': case 'fileChange': case 'imageGeneration': return 'work';
    case 'mcpToolCall': return activityForMcp(String(item.server ?? ''), String(item.tool ?? ''));
    default: return 'thinking';
  }
}
function activityForMcp(server: string, tool: string): PetActivity {
  if (server === 'companion') {
    if (tool === 'read_relationship_history') return 'read';
    if (tool === 'send_voice' || tool === 'roll_dice') return tool === 'send_voice' ? 'replying' : 'thinking';
    return 'work';
  }
  if (server === 'keet') return tool === 'send_message' || tool === 'send_file' ? 'replying' : 'read';
  if (server === 'web' || server === 'openaiDeveloperDocs') return 'read';
  if (['project', 'flicknote', 'guion-email', 'og', 'skill'].includes(server)) return /(?:create|edit|update|write|send|apply|delete|move|organize)/iu.test(tool) ? (server === 'guion-email' && /(?:draft|send)/iu.test(tool) ? 'replying' : 'work') : 'read';
  return 'thinking';
}
function failedItem(item: Item): boolean { return ['failed', 'error', 'cancelled', 'interrupted'].includes(String(item.status)); }
