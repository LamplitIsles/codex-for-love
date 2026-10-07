import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { Submission, ImageRef } from '@lamplit/contracts';
import type { MaterializedGeneratedImage, MaterializedInputImage } from './images.ts';
import type { CompactBoundary, ContextObservation } from './continuity.ts';

/** UI/domain metadata only. Official Codex owns the conversation transcript. */
export type MessageMeta = { id: string; created: number; sequence: number; revision: number };
export type PendingMessage = MessageMeta & { input: string };
export type StoredInput = { input: string; images: StoredImage[] };
/** Non-body ownership metadata for an acknowledged source input. */
export type StoredInputSegment = {
  message_id: string;
  turn_id: string;
  item_id: string;
  segment_index: number;
  text_offset: number;
  text_length: number;
};
/** Facts owned by the Companion rather than official turn execution. */
export type LocalOutcomeStatus = 'replaced' | 'attachment-error';
export type LocalOutcome = { status: LocalOutcomeStatus; error: string | null };
export type MessagePageOptions = { before?: number; after?: number };
export type StoredImage = Omit<MaterializedInputImage, 'data'>;
export type StoredGeneratedImage = MaterializedGeneratedImage;
export type StagedImages = { images: StoredImage[]; refs: ImageRef[]; variants: Array<{ preview: string; model: string }> };
export type KeetDestination = { groupName: string; kind: 'group' | 'broadcast' | 'dm' };
export type KeetGroupRecord = { senderLabel: string; text: string; replyTo?: { deviceId: string; seq: number } };
export type KeetReactionContext = { targetMessageId: { deviceId: string; seq: number }; targetText: string; emoji: string; externalCount: number };
export type KeetEvent = {
  eventId: string; sequence: number; destination: KeetDestination; senderLabel: string; text: string;
  originalText: string;
  imageNote?: string;
  messageId: { deviceId: string; seq: number }; timestamp: number; localTime: string;
  trigger?: 'mention' | 'label' | 'reply' | 'dm'; replyTo?: { deviceId: string; seq: number };
  reactionContext?: readonly KeetReactionContext[];
  input?: { id: string; text: string; images?: readonly StoredImage[] };
};

function identityConflict(): Error & { code: 'MESSAGE_IDENTITY_CONFLICT' } {
  return Object.assign(new Error('Message ID already belongs to different content'), { code: 'MESSAGE_IDENTITY_CONFLICT' as const });
}

export type KeetProvenance = { kind: 'group' | 'dm'; destination: string; senderLabel: string; text: string; imageNote?: string; messageId: { deviceId: string; seq: number }; timestamp: number; localTime: string };
export type KeetContext = { provenance: KeetProvenance; groupContext?: string; reactionContext?: string };
const CONTEXT_LIMIT = 800; // Byte budget leaves room under the native 1,000-token fragment cap.
function bounded(value: string): string { let out = ''; for (const char of value) { if (Buffer.byteLength(out + char) > CONTEXT_LIMIT) break; out += char; } return out; }
function groupContext(records: readonly KeetGroupRecord[]): string | undefined {
  const lines = records.map(record => `[${record.senderLabel}] ${record.text}`);
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > CONTEXT_LIMIT) lines.shift();
  return lines.length ? bounded(lines.join('\n')) : undefined;
}

function reactionReceiptKey(destination: KeetDestination, fact: KeetReactionContext): string {
  return JSON.stringify([destination.kind, destination.groupName, fact.targetMessageId.deviceId, fact.targetMessageId.seq, fact.emoji, fact.externalCount]);
}

export class Store {
  private readonly db: DatabaseSync;
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // One Partner runtime owns the store for its lifetime. The database is
      // not a model journal; it contains only presentation/domain metadata.
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS staged_images (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS failed_submissions (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, error TEXT NOT NULL, replaced_by TEXT);
        CREATE TABLE IF NOT EXISTS shared_submissions (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rejected_inputs (message_id TEXT PRIMARY KEY, error TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_completed_items (turn_id TEXT NOT NULL, item_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS message_meta (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          created INTEGER NOT NULL,
          fingerprint TEXT
        );
        CREATE TABLE IF NOT EXISTS pending_inputs (
          message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE,
          input TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS input_segments (
          message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
          text_offset INTEGER NOT NULL CHECK(text_offset >= 0),
          text_length INTEGER NOT NULL CHECK(text_length >= 0)
        );
        CREATE TABLE IF NOT EXISTS message_outcomes (
          message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('replaced','attachment-error')),
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS compact_boundaries (
          id TEXT PRIMARY KEY,
          anchor_id TEXT,
          position TEXT NOT NULL CHECK(position IN ('before','after-user','after')),
          time INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS context_observation (
          id INTEGER PRIMARY KEY CHECK(id=1),
          active_tokens INTEGER,
          window_tokens INTEGER
        );
        CREATE TABLE IF NOT EXISTS input_images (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generated_images (
          id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY(operation_id,id)
        );
        CREATE TABLE IF NOT EXISTS generated_image_items (
          operation_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          image_id TEXT NOT NULL,
          PRIMARY KEY(operation_id,item_id)
        );
        CREATE TABLE IF NOT EXISTS message_revisions (
          revision INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE REFERENCES message_meta(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS keet_webhook_events (event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keet_group_buffers (group_name TEXT PRIMARY KEY, records TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS keet_reaction_receipts (fact_key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS keet_sources (message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE, context TEXT NOT NULL);
      `);
      this.db.exec(`
        INSERT OR IGNORE INTO message_revisions(message_id)
          SELECT id FROM message_meta ORDER BY sequence;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(callback: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Session store is closed'));
    const result = this.writes.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const value = await callback();
        this.db.exec('COMMIT');
        return value;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  async markChatItemCompleted(turnId: string, itemId: string): Promise<void> {
    await this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO chat_completed_items(turn_id,item_id) VALUES(?,?)').run(turnId,itemId); });
  }
  async completedChatItems(turnId: string): Promise<Set<string>> {
    return this.transaction(() => new Set(this.db.prepare('SELECT item_id FROM chat_completed_items WHERE turn_id=?').all(turnId).map(row => String((row as { item_id: string }).item_id))));
  }

  private async revision(): Promise<number> {
    return this.transaction(() => Number((this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS value FROM message_revisions').get() as { value: number }).value));
  }

  async admit(id: string, input: string, images: readonly StoredImage[] = [], shared?: { sessionId: string; input: Submission }): Promise<MessageMeta> {
    return this.transaction(() => {
      const fingerprint = createHash('sha256').update(JSON.stringify([input, images.map((image) => image.id).sort()])).digest('hex');
      const existing = this.db.prepare('SELECT sequence,id,created,fingerprint FROM message_meta WHERE id=?').get(id) as { sequence: number; id: string; created: number; fingerprint: string | null } | undefined;
      if (existing) {
        const pending = this.db.prepare('SELECT input FROM pending_inputs WHERE message_id=?').get(id) as { input: string } | undefined;
        if ((existing.fingerprint && existing.fingerprint !== fingerprint) || (pending && pending.input !== input)) throw identityConflict();
        const oldImages = this.db.prepare('SELECT id FROM input_images WHERE operation_id=? ORDER BY id').all(id).map((row) => String((row as { id: string }).id));
        const newImages = images.map((image) => image.id).sort();
        if (JSON.stringify(oldImages) !== JSON.stringify(newImages)) throw identityConflict();
        return this.meta(existing);
      }
      if (shared) {
        for (const sourceId of shared.input.replacementSourceIds ?? []) {
          if ((!this.db.prepare('SELECT 1 FROM pending_inputs p JOIN rejected_inputs r ON r.message_id=p.message_id WHERE p.message_id=?').get(sourceId)
            || this.db.prepare("SELECT 1 FROM message_outcomes WHERE message_id=? AND status='replaced'").get(sourceId))
            && !this.db.prepare('SELECT 1 FROM failed_submissions WHERE operation_id=? AND replaced_by IS NULL').get(sourceId)) throw new Error('Replacement source is not eligible');
        }
        this.db.prepare('INSERT INTO shared_submissions(operation_id,session_id,fingerprint) VALUES(?,?,?)').run(id, shared.sessionId, createHash('sha256').update(JSON.stringify(shared.input)).digest('hex'));
        for (const sourceId of shared.input.replacementSourceIds ?? []) {
          if (this.db.prepare('UPDATE failed_submissions SET replaced_by=? WHERE operation_id=? AND replaced_by IS NULL').run(id, sourceId).changes) continue;
          this.db.prepare("INSERT INTO message_outcomes(message_id,status,error) VALUES(?,'replaced','replaced') ON CONFLICT(message_id) DO UPDATE SET status='replaced',error='replaced'").run(sourceId);
          this.db.prepare('DELETE FROM pending_inputs WHERE message_id=?').run(sourceId);
          this.addRevision(sourceId);
        }
      }
      const created = Date.now();
      this.db.prepare('INSERT INTO message_meta(id,created,fingerprint) VALUES(?,?,?)').run(id, created, fingerprint);
      this.db.prepare('INSERT INTO pending_inputs(message_id,input) VALUES(?,?)').run(id, input);
      for (const image of images) {
        this.db.prepare('INSERT INTO input_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)')
          .run(image.id, id, image.name, image.media_type, image.path);
      }
      this.addRevision(id);
      return this.meta(this.db.prepare('SELECT sequence,id,created FROM message_meta WHERE id=?').get(id) as { sequence: number; id: string; created: number });
    });
  }

  async stageImages(operationId: string, sessionId: string, fingerprint: string, payload: StagedImages): Promise<void> {
    await this.transaction(() => {
      const old = this.db.prepare('SELECT session_id,fingerprint FROM staged_images WHERE operation_id=?').get(operationId) as { session_id: string; fingerprint: string } | undefined;
      if (old) { if (old.session_id !== sessionId || old.fingerprint !== fingerprint) throw identityConflict(); return; }
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(operationId)) throw identityConflict();
      this.db.prepare('INSERT INTO staged_images(operation_id,session_id,fingerprint,payload) VALUES(?,?,?,?)').run(operationId, sessionId, fingerprint, JSON.stringify(payload));
    });
  }
  async stagedImages(operationId: string, sessionId: string): Promise<StagedImages | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM staged_images WHERE operation_id=? AND session_id=?').get(operationId, sessionId) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) : undefined;
    });
  }
  async stagedMedia(id: string, sessionId: string): Promise<{ image: StoredImage; preview: string; model: string } | undefined> {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM staged_images WHERE session_id=?').all(sessionId) as Array<{ payload: string }>;
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as StagedImages;
        const index = payload.images.findIndex(image => image.id === id);
        if (index >= 0) return { image: payload.images[index]!, ...payload.variants[index]! };
      }
      return undefined;
    });
  }
  async sharedSubmission(id: string, sessionId: string): Promise<string | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT fingerprint,session_id FROM shared_submissions WHERE operation_id=?').get(id) as { fingerprint: string; session_id: string } | undefined;
      if (row && row.session_id !== sessionId) throw identityConflict();
      return row?.fingerprint;
    });
  }
  async failedSubmission(id: string, sessionId: string): Promise<{ input: Submission; error: string; replacedBy: string | null } | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT payload,error,replaced_by FROM failed_submissions WHERE operation_id=? AND session_id=?').get(id, sessionId) as { payload: string; error: string; replaced_by: string | null } | undefined;
      return row ? { input: JSON.parse(row.payload), error: row.error, replacedBy: row.replaced_by } : undefined;
    });
  }
  async failedSubmissions(sessionId: string): Promise<Submission[]> {
    return this.transaction(() => (this.db.prepare('SELECT payload FROM failed_submissions WHERE session_id=? AND replaced_by IS NULL ORDER BY rowid DESC LIMIT 20').all(sessionId) as Array<{ payload: string }>).reverse().map(row => JSON.parse(row.payload)));
  }
  /** Record definite rolled-back admission, never an execution/transport outcome. */
  async failSubmission(input: Submission, sessionId: string, error: string): Promise<void> {
    await this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(input.operationId)) throw new Error('Cannot fail a durably admitted input');
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const old = this.db.prepare('SELECT fingerprint FROM failed_submissions WHERE operation_id=?').get(input.operationId) as { fingerprint: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint) throw identityConflict(); return; }
      this.db.prepare('INSERT INTO failed_submissions(operation_id,session_id,fingerprint,payload,error) VALUES(?,?,?,?,?)').run(input.operationId, sessionId, fingerprint, JSON.stringify(input), error);
    });
  }
  async markRejected(ids: readonly string[], error: string): Promise<void> {
    await this.transaction(() => { for (const id of ids) this.db.prepare('INSERT OR REPLACE INTO rejected_inputs(message_id,error) VALUES(?,?)').run(id, error); });
  }
  async rejected(id: string): Promise<string | undefined> {
    return this.transaction(() => (this.db.prepare('SELECT error FROM rejected_inputs WHERE message_id=?').get(id) as { error: string } | undefined)?.error);
  }

  /** Atomically make one gateway event durable and, when qualified, create its native input. */
  async hasKeetEvent(eventId: string): Promise<boolean> {
    return this.transaction(() => Boolean(this.db.prepare('SELECT 1 FROM keet_webhook_events WHERE event_id=?').get(eventId)));
  }

  async recordKeetEvent(event: KeetEvent): Promise<boolean> {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM keet_webhook_events WHERE event_id=?').get(event.eventId)) return false;
      this.db.prepare('INSERT INTO keet_webhook_events(event_id,sequence) VALUES(?,?)').run(event.eventId, event.sequence);
      if (event.destination.kind === 'broadcast') return true;
      if (event.destination.kind === 'group' && !event.trigger) {
        const prior = this.db.prepare('SELECT records FROM keet_group_buffers WHERE group_name=?').get(event.destination.groupName) as { records: string } | undefined;
        const records = prior ? JSON.parse(prior.records) as KeetGroupRecord[] : [];
        records.push({ senderLabel: event.senderLabel, text: event.text, ...(event.replyTo ? { replyTo: event.replyTo } : {}) });
        while (records.length > 64 || records.reduce((total, record) => total + record.senderLabel.length + record.text.length + 4, 0) > 16_000) records.shift();
        this.db.prepare('INSERT INTO keet_group_buffers(group_name,records) VALUES(?,?) ON CONFLICT(group_name) DO UPDATE SET records=excluded.records').run(event.destination.groupName, JSON.stringify(records));
        return true;
      }
      if (!event.input) throw new Error('Qualified Keet event requires an input');
      const row = event.destination.kind === 'group' ? this.db.prepare('SELECT records FROM keet_group_buffers WHERE group_name=?').get(event.destination.groupName) as { records: string } | undefined : undefined;
      const freshFacts = (event.reactionContext ?? []).filter(fact => !this.db.prepare('SELECT 1 FROM keet_reaction_receipts WHERE fact_key=?').get(reactionReceiptKey(event.destination, fact)));
      const input = event.input.text;
      const reactionLines: string[] = [];
      if (freshFacts.length) {
        for (const fact of freshFacts) {
          const key = reactionReceiptKey(event.destination, fact);
          if (this.db.prepare('SELECT 1 FROM keet_reaction_receipts WHERE fact_key=?').get(key)) continue;
          const line = `${JSON.stringify(fact.targetText)}: ${JSON.stringify(fact.emoji)} × ${fact.externalCount} external; targetMessageId ${JSON.stringify(fact.targetMessageId)}`;
          if (Buffer.byteLength([...reactionLines, line].join('\n')) > CONTEXT_LIMIT) continue;
          reactionLines.push(line);
          this.db.prepare('INSERT INTO keet_reaction_receipts(fact_key) VALUES(?)').run(key);
        }
      }
      const existing = this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(event.input.id);
      if (!existing) {
        const images = event.input.images ?? [];
        const fingerprint = createHash('sha256').update(JSON.stringify([input, images.map(image => image.id).sort()])).digest('hex');
        this.db.prepare('INSERT INTO message_meta(id,created,fingerprint) VALUES(?,?,?)').run(event.input.id, Date.now(), fingerprint);
        this.db.prepare('INSERT INTO pending_inputs(message_id,input) VALUES(?,?)').run(event.input.id, input);
        for (const image of images) this.db.prepare('INSERT INTO input_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)').run(image.id, event.input.id, image.name, image.media_type, image.path);
        this.addRevision(event.input.id);
      }
      const context: KeetContext = {
        provenance: { kind: event.destination.kind, destination: event.destination.groupName, senderLabel: event.senderLabel, text: event.originalText, ...(event.imageNote ? { imageNote: event.imageNote } : {}), messageId: event.messageId, timestamp: event.timestamp, localTime: event.localTime },
        ...(row ? { groupContext: groupContext(JSON.parse(row.records) as KeetGroupRecord[]) } : {}),
        ...(reactionLines.length ? { reactionContext: reactionLines.join('\n') } : {}),
      };
      this.db.prepare('INSERT INTO keet_sources(message_id,context) VALUES(?,?)').run(event.input.id, JSON.stringify(context));
      if (event.destination.kind === 'group') this.db.prepare('DELETE FROM keet_group_buffers WHERE group_name=?').run(event.destination.groupName);
      return true;
    });
  }

  async keetContext(id: string): Promise<KeetContext | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT context FROM keet_sources WHERE message_id=?').get(id) as { context: string } | undefined;
      return row ? JSON.parse(row.context) as KeetContext : undefined;
    });
  }

  async keetContexts(ids: readonly string[]): Promise<Map<string, KeetContext>> {
    const result = new Map<string, KeetContext>();
    for (const id of ids) { const context = await this.keetContext(id); if (context) result.set(id, context); }
    return result;
  }

  async ensureMessage(id: string, created: number, input?: string, images: readonly StoredImage[] = []): Promise<MessageMeta> {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT sequence,id,created FROM message_meta WHERE id=?').get(id) as { sequence: number; id: string; created: number } | undefined;
      const fingerprint = input === undefined
        ? undefined
        : createHash('sha256').update(JSON.stringify([input, images.map((image) => image.id).sort()])).digest('hex');
      if (existing) {
        if (fingerprint !== undefined) {
          let changed = false;
          const stored = this.db.prepare('SELECT fingerprint FROM message_meta WHERE id=?').get(id) as { fingerprint: string | null } | undefined;
          if (stored?.fingerprint && stored.fingerprint !== fingerprint) throw identityConflict();
          if (!stored?.fingerprint) { this.db.prepare('UPDATE message_meta SET fingerprint=? WHERE id=?').run(fingerprint, id); changed = true; }
          const oldImages = this.db.prepare('SELECT id FROM input_images WHERE operation_id=? ORDER BY id').all(id).map((row) => String((row as { id: string }).id));
          const newImages = images.map((image) => image.id).sort();
          if (oldImages.length && JSON.stringify(oldImages) !== JSON.stringify(newImages)) throw identityConflict();
          for (const image of images) {
            const inserted = this.db.prepare('INSERT OR IGNORE INTO input_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)')
              .run(image.id, id, image.name, image.media_type, image.path);
            if (inserted.changes) changed = true;
          }
          if (changed) this.addRevision(id);
        }
        return this.meta(existing);
      }
      this.db.prepare('INSERT INTO message_meta(id,created,fingerprint) VALUES(?,?,?)').run(id, created, fingerprint ?? null);
      for (const image of images) {
        this.db.prepare('INSERT INTO input_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)')
          .run(image.id, id, image.name, image.media_type, image.path);
      }
      this.addRevision(id);
      return this.meta(this.db.prepare('SELECT sequence,id,created FROM message_meta WHERE id=?').get(id) as { sequence: number; id: string; created: number });
    });
  }

  private meta(row: { sequence: number; id: string; created: number }): MessageMeta {
    const revision = this.db.prepare('SELECT revision FROM message_revisions WHERE message_id=?').get(row.id) as { revision: number } | undefined;
    return { id: row.id, created: row.created, sequence: Number(row.sequence), revision: Number(revision?.revision ?? 0) };
  }

  private addRevision(id: string): void {
    this.db.prepare('INSERT OR REPLACE INTO message_revisions(message_id) VALUES(?)').run(id);
  }

  async markObserved(id: string, segment?: Omit<StoredInputSegment, 'message_id'>): Promise<void> {
    // Official history owns acknowledged conversational text. Retain only
    // the source-to-item split needed to reconstruct a merged user item;
    // unresolved inputs keep their body in pending_inputs for draft recovery.
    await this.transaction(() => {
      let changed = false;
      if (segment) {
        const previous = this.db.prepare('SELECT turn_id,item_id,segment_index,text_offset,text_length FROM input_segments WHERE message_id=?').get(id) as Omit<StoredInputSegment, 'message_id'> | undefined;
        if (!previous || previous.turn_id !== segment.turn_id || previous.item_id !== segment.item_id || Number(previous.segment_index) !== segment.segment_index
          || Number(previous.text_offset) !== segment.text_offset || Number(previous.text_length) !== segment.text_length) {
          this.db.prepare(`
            INSERT INTO input_segments(message_id,turn_id,item_id,segment_index,text_offset,text_length) VALUES(?,?,?,?,?,?)
            ON CONFLICT(message_id) DO UPDATE SET turn_id=excluded.turn_id,item_id=excluded.item_id,segment_index=excluded.segment_index,text_offset=excluded.text_offset,text_length=excluded.text_length
          `).run(id, segment.turn_id, segment.item_id, segment.segment_index, segment.text_offset, segment.text_length);
          changed = true;
        }
      }
      const retired = this.db.prepare('DELETE FROM pending_inputs WHERE message_id=?').run(id).changes;
      if (retired) changed = true;
      if (changed) this.addRevision(id);
    });
  }

  async inputPayload(id: string): Promise<StoredInput | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT input FROM pending_inputs WHERE message_id=?').get(id) as { input: string } | undefined;
      if (!row) return undefined;
      const images = this.db.prepare('SELECT id,operation_id,name,media_type,path FROM input_images WHERE operation_id=? ORDER BY rowid').all(id) as StoredImage[];
      return { input: row.input, images };
    });
  }

  async inputSegment(id: string): Promise<StoredInputSegment | undefined> {
    return this.transaction(() => this.db.prepare('SELECT message_id,turn_id,item_id,segment_index,text_offset,text_length FROM input_segments WHERE message_id=?').get(id) as StoredInputSegment | undefined);
  }

  async markOutcome(id: string, status: LocalOutcomeStatus, error: string | null = null): Promise<void> {
    await this.transaction(() => {
      const previous = this.db.prepare('SELECT status,error FROM message_outcomes WHERE message_id=?').get(id) as { status: string; error: string | null } | undefined;
      this.db.prepare(`
        INSERT INTO message_outcomes(message_id,status,error) VALUES(?,?,?)
        ON CONFLICT(message_id) DO UPDATE SET status=excluded.status,error=excluded.error
      `).run(id, status, error);
      const retired = status === 'replaced' ? this.db.prepare('DELETE FROM pending_inputs WHERE message_id=?').run(id).changes : 0;
      if (!previous || previous.status !== status || previous.error !== error || retired) this.addRevision(id);
    });
  }

  async outcome(id: string): Promise<LocalOutcome | undefined> {
    return this.transaction(() => this.db.prepare('SELECT status,error FROM message_outcomes WHERE message_id=?').get(id) as LocalOutcome | undefined);
  }

  async outcomes(ids: readonly string[]): Promise<Map<string, LocalOutcome>> {
    return this.transaction(() => {
      const result = new Map<string, LocalOutcome>();
      if (!ids.length) return result;
      const rows = this.db.prepare(`SELECT message_id,status,error FROM message_outcomes WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ message_id: string } & LocalOutcome>;
      for (const row of rows) result.set(row.message_id, { status: row.status, error: row.error });
      return result;
    });
  }

  async messagePosition(ids: readonly string[]): Promise<{ sequence: number; revision: number }> {
    return this.transaction(() => {
      if (!ids.length) return { sequence: 0, revision: 0 };
      const row = this.db.prepare(`
        SELECT COALESCE(MAX(m.sequence),0) AS sequence, COALESCE(MAX(r.revision),0) AS revision
        FROM message_meta m JOIN message_revisions r ON r.message_id=m.id
        WHERE m.id IN (${ids.map(() => '?').join(',')})
      `).get(...ids) as { sequence: number; revision: number };
      return { sequence: Number(row.sequence), revision: Number(row.revision) };
    });
  }

  async touchMessage(id: string): Promise<void> {
    await this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(id)) this.addRevision(id);
    });
  }

  async messagePage(options: MessagePageOptions = {}) {
    return this.transaction(() => {
      const cursor = Number((this.db.prepare('SELECT COALESCE(MAX(revision),0) AS value FROM message_revisions').get() as { value: number }).value);
      if (options.after !== undefined && options.after > cursor) throw new Error('Message cursor is ahead of this session');
      const changes = options.after !== undefined;
      const rows = this.db.prepare(`
        SELECT m.sequence,m.id,m.created,r.revision
        FROM message_meta m JOIN message_revisions r ON r.message_id=m.id
        WHERE ${changes ? 'r.revision>?' : 'm.sequence<?'}
        ORDER BY ${changes ? 'r.revision ASC' : 'm.sequence DESC'} LIMIT 31
      `).all(options.after ?? options.before ?? Number.MAX_SAFE_INTEGER) as Array<{ sequence: number; id: string; created: number; revision: number }>;
      const more = rows.length > 30;
      const page = rows.slice(0, 30).map((row) => ({ id: row.id, created: Number(row.created), sequence: Number(row.sequence), revision: Number(row.revision) }));
      const next = changes && more ? page.at(-1)!.revision : cursor;
      page.sort((a, b) => a.sequence - b.sequence);
      return {
        messages: page,
        cursor: next,
        hasChangesMore: changes && more,
        hasMore: !changes && more,
        before: page[0]?.sequence ?? null,
      };
    });
  }

  async allMessages(): Promise<MessageMeta[]> {
    return this.transaction(() => this.db.prepare(`
      SELECT m.sequence,m.id,m.created,r.revision
      FROM message_meta m JOIN message_revisions r ON r.message_id=m.id
      ORDER BY m.sequence
    `).all().map((row) => {
      const value = row as { sequence: number; id: string; created: number; revision: number };
      return { id: value.id, created: Number(value.created), sequence: Number(value.sequence), revision: Number(value.revision) };
    }));
  }

  async messageMeta(id: string): Promise<MessageMeta | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT m.sequence,m.id,m.created,r.revision
        FROM message_meta m JOIN message_revisions r ON r.message_id=m.id
        WHERE m.id=?
      `).get(id) as { sequence: number; id: string; created: number; revision: number } | undefined;
      return row ? { id: row.id, created: Number(row.created), sequence: Number(row.sequence), revision: Number(row.revision) } : undefined;
    });
  }

  async pendingMessages(): Promise<PendingMessage[]> {
    return this.transaction(() => this.db.prepare(`
      SELECT m.sequence,m.id,m.created,r.revision,p.input
      FROM message_meta m JOIN message_revisions r ON r.message_id=m.id
      JOIN pending_inputs p ON p.message_id=m.id ORDER BY m.sequence
    `).all().map((row) => {
      const value = row as { sequence: number; id: string; created: number; revision: number; input: string };
      return { id: value.id, created: Number(value.created), sequence: Number(value.sequence), revision: Number(value.revision), input: value.input };
    }));
  }

  async inputImageMetadata(ids?: readonly string[]): Promise<StoredImage[]> {
    return this.transaction(() => {
      if (ids && !ids.length) return [];
      const where = ids ? ` WHERE operation_id IN (${ids.map(() => '?').join(',')})` : '';
      return this.db.prepare(`SELECT id,operation_id,name,media_type,path FROM input_images${where} ORDER BY rowid`).all(...(ids ?? [])) as StoredImage[];
    });
  }

  async image(id: string): Promise<(StoredImage & { data: Uint8Array }) | undefined> {
    const image = await this.transaction(() => this.db.prepare(`
      SELECT id,operation_id,name,media_type,path FROM input_images WHERE id=?
      UNION ALL
      SELECT id,operation_id,name,media_type,path FROM generated_images WHERE id=? LIMIT 1
    `).get(id, id) as (StoredImage | StoredGeneratedImage) | undefined);
    if (!image) return undefined;
    return { ...image, data: await readFile(image.path) };
  }

  async imageAtPath(path: string): Promise<StoredImage | undefined> {
    return this.transaction(() => this.db.prepare('SELECT id,operation_id,name,media_type,path FROM input_images WHERE path=? UNION ALL SELECT id,operation_id,name,media_type,path FROM generated_images WHERE path=? LIMIT 1').get(path, path) as StoredImage | undefined);
  }
  async imageMetadata(id: string): Promise<StoredImage | undefined> {
    return this.transaction(() => this.db.prepare(`
      SELECT id,operation_id,name,media_type,path FROM input_images WHERE id=?
      UNION ALL
      SELECT id,operation_id,name,media_type,path FROM generated_images WHERE id=? LIMIT 1
    `).get(id, id) as StoredImage | undefined);
  }

  async generatedImageForItem(operationId: string, itemId: string): Promise<StoredGeneratedImage | undefined> {
    return this.transaction(() => this.db.prepare(`
      SELECT g.id,g.operation_id,g.name,g.media_type,g.path
      FROM generated_images g
      JOIN generated_image_items i ON i.operation_id=g.operation_id AND i.image_id=g.id
      WHERE i.operation_id=? AND i.item_id=?
    `).get(operationId, itemId) as StoredGeneratedImage | undefined);
  }

  async saveGeneratedImage(image: StoredGeneratedImage, itemId: string): Promise<void> {
    await this.transaction(() => {
      const previous = this.db.prepare('SELECT name,media_type,path FROM generated_images WHERE operation_id=? AND id=?').get(image.operation_id, image.id) as { name: string; media_type: string; path: string } | undefined;
      this.db.prepare(`
        INSERT INTO generated_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)
        ON CONFLICT(operation_id,id) DO UPDATE SET name=excluded.name,media_type=excluded.media_type,path=excluded.path
      `).run(image.id, image.operation_id, image.name, image.media_type, image.path);
      const association = this.db.prepare('SELECT image_id FROM generated_image_items WHERE operation_id=? AND item_id=?').get(image.operation_id, itemId) as { image_id: string } | undefined;
      this.db.prepare(`
        INSERT INTO generated_image_items(operation_id,item_id,image_id) VALUES(?,?,?)
        ON CONFLICT(operation_id,item_id) DO UPDATE SET image_id=excluded.image_id
      `).run(image.operation_id, itemId, image.id);
      if ((!previous || previous.name !== image.name || previous.media_type !== image.media_type || previous.path !== image.path || association?.image_id !== image.id)
        && this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(image.operation_id)) this.addRevision(image.operation_id);
    });
  }

  async generatedImageMetadata(ids?: readonly string[]): Promise<StoredGeneratedImage[]> {
    return this.transaction(() => {
      if (ids && !ids.length) return [];
      const where = ids ? ` WHERE operation_id IN (${ids.map(() => '?').join(',')})` : '';
      return this.db.prepare(`SELECT id,operation_id,name,media_type,path FROM generated_images${where} ORDER BY rowid`).all(...(ids ?? [])) as StoredGeneratedImage[];
    });
  }


  async observeContext(context: ContextObservation): Promise<void> {
    await this.transaction(() => this.db.prepare(`
      INSERT INTO context_observation(id,active_tokens,window_tokens) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET active_tokens=excluded.active_tokens,window_tokens=excluded.window_tokens
    `).run(context.activeTokens, context.windowTokens));
  }

  async observedContext(): Promise<ContextObservation | null> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT active_tokens,window_tokens FROM context_observation WHERE id=1').get() as { active_tokens: number | null; window_tokens: number | null } | undefined;
      return row ? { activeTokens: row.active_tokens === null ? null : Number(row.active_tokens), windowTokens: row.window_tokens === null ? null : Number(row.window_tokens) } : null;
    });
  }

  async saveCompactBoundary(boundary: CompactBoundary): Promise<void> {
    await this.transaction(() => this.db.prepare('INSERT OR IGNORE INTO compact_boundaries(id,anchor_id,position,time) VALUES(?,?,?,?)').run(boundary.id, boundary.anchorId, boundary.position, boundary.time));
  }

  async compactBoundaries(): Promise<CompactBoundary[]> {
    return this.transaction(() => this.db.prepare('SELECT id,anchor_id AS anchorId,position,time FROM compact_boundaries ORDER BY time,id').all() as CompactBoundary[]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    this.db.close();
  }
}
