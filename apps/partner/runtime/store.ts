import { postInput, postInputId, postPresentation } from './post.ts';
import type { EventV1 } from './post-contract.ts';
import { type MatrixEvent, type MatrixContext } from './matrix.ts';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, resolve } from 'node:path';
import type { Submission, ImageRef, FileRef } from '@lamplit/contracts';
import type { MaterializedInputImage } from './images.ts';
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
export type StoredGeneratedImage = StoredImage;
export type StoredFile = { id: string; operation_id: string; owner_id: string; session_id: string; position: number; name: string; media_type: string; size: number; path: string };
export type StagedFiles = { files: StoredFile[]; refs: FileRef[] };
export type FileManifest = { sessionId: string; operationId: string; files: Array<{ id: string; name: string; mediaType: string; size: number }> };
export type FileReservationRow = { file_id: string; position: number; digest: string | null; path: string | null; attachment_id: string | null };
export type FileReservation = { manifest: FileManifest; status: 'uploading' | 'complete'; dirKey: string; files: FileReservationRow[]; staged?: StagedFiles };
export type RetirementCandidate = { ownerId: string; sessionId: string; reservation: FileReservation };
export class FileOperationRetired extends Error {
  constructor() { super('File operation retired; start a new attempt explicitly.'); }
}
export class FileOperationNotFound extends Error {
  constructor() { super('File operation not found'); }
}
export type StagedImages = { images: StoredImage[]; refs: ImageRef[]; variants: Array<({ preview: string; model: string } | { previewPath: string; modelPath: string }) & { stickerTags?: string[] }> };
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

function fileDirectoryKey(path: string): string | undefined {
  const target = resolve(path), directory = dirname(target), key = basename(directory);
  if (/^[a-f0-9]{32}$/u.test(key) && basename(dirname(directory)) === '.file-operations') return key;
  const targetKey = basename(target);
  return /^[a-f0-9]{32}$/u.test(targetKey) && basename(directory) === '.file-operations' ? targetKey : undefined;
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
  private fileExpiryCursor = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // One Partner runtime owns the store for its lifetime. The database is
      // not a model journal; it contains only presentation/domain metadata.
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS staged_images (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS staged_files (operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file_upload_operations (
          operation_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          manifest TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('uploading','complete')),
          created_at INTEGER NOT NULL CHECK(created_at >= 0),
          updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
          dir_key TEXT NOT NULL CHECK(length(dir_key) = 32 AND dir_key NOT GLOB '*[^0-9a-f]*')
        );
        CREATE INDEX IF NOT EXISTS file_upload_operations_scope ON file_upload_operations(owner_id,session_id,status);
        CREATE INDEX IF NOT EXISTS file_upload_operations_expiry ON file_upload_operations(status,updated_at);
        CREATE TABLE IF NOT EXISTS file_upload_files (
          operation_id TEXT NOT NULL REFERENCES file_upload_operations(operation_id) ON DELETE CASCADE,
          file_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(position >= 0 AND position < 6),
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0 AND size <= 100000000),
          digest TEXT,
          path TEXT,
          attachment_id TEXT,
          uploaded_at INTEGER,
          CHECK((digest IS NULL AND path IS NULL AND attachment_id IS NULL AND uploaded_at IS NULL) OR
                (digest IS NOT NULL AND length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*' AND
                 path IS NOT NULL AND attachment_id IS NOT NULL AND length(attachment_id) = 64 AND
                 attachment_id NOT GLOB '*[^0-9a-f]*' AND uploaded_at IS NOT NULL AND uploaded_at >= 0)),
          PRIMARY KEY(operation_id,file_id),
          UNIQUE(operation_id,position)
        );
        CREATE TABLE IF NOT EXISTS file_upload_retirements (
          operation_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(reason IN ('expired_uploading','abandoned_complete')),
          state TEXT NOT NULL CHECK(state IN ('cleanup_pending','retired')),
          retired_at INTEGER NOT NULL CHECK(retired_at >= 0)
        );
        CREATE INDEX IF NOT EXISTS file_upload_retirements_pending ON file_upload_retirements(state,retired_at);
        CREATE TABLE IF NOT EXISTS failed_submissions (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, error TEXT NOT NULL, replaced_by TEXT);
        CREATE TABLE IF NOT EXISTS deleted_failures (operation_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS retry_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT);
        CREATE TABLE IF NOT EXISTS shared_submissions (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rejected_inputs (message_id TEXT PRIMARY KEY, error TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_completed_items (turn_id TEXT NOT NULL, item_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS chat_timeline_slots (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user','text','image','voice','ui')),
          position INTEGER NOT NULL CHECK(position >= 0),
          PRIMARY KEY(session_id,turn_id,item_id),
          UNIQUE(session_id,turn_id,position)
        );
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
        CREATE TABLE IF NOT EXISTS input_files (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(position >= 0 AND position < 6),
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0 AND size <= 100000000),
          path TEXT NOT NULL,
          UNIQUE(operation_id, position)
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
        CREATE TABLE IF NOT EXISTS post_receipts_v1 (service TEXT NOT NULL, agent TEXT NOT NULL, delivery TEXT NOT NULL, body TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(service,agent,delivery));
        CREATE TABLE IF NOT EXISTS post_sources_v1 (message_id TEXT PRIMARY KEY REFERENCES message_meta(id), service TEXT NOT NULL, canonical_key TEXT NOT NULL UNIQUE, native_key TEXT NOT NULL UNIQUE, event TEXT NOT NULL, media TEXT NOT NULL DEFAULT '{}', ready INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS post_media_v1 (message_id TEXT NOT NULL, asset_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, PRIMARY KEY(message_id,asset_id));
        CREATE TABLE IF NOT EXISTS matrix_sources (message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE, context TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS keet_webhook_events (event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keet_group_buffers (group_name TEXT PRIMARY KEY, records TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS keet_reaction_receipts (fact_key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS keet_sources (message_id TEXT PRIMARY KEY REFERENCES message_meta(id) ON DELETE CASCADE, context TEXT NOT NULL);
      `);
      const uploadColumns = this.db.prepare('PRAGMA table_info(file_upload_operations)').all() as Array<{ name: string; type: string; notnull: number }>;
      const directory = uploadColumns.find(column => column.name === 'dir_key');
      if (!directory || directory.type.toUpperCase() !== 'TEXT' || directory.notnull !== 1) throw new Error('Unrecognized file upload directory schema');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS file_upload_operations_dir_key ON file_upload_operations(dir_key)');
      this.migrateFileSizeLimit();
      this.migrateTimelineSlots();
      this.db.exec(`
        INSERT OR IGNORE INTO message_revisions(message_id)
          SELECT id FROM message_meta ORDER BY sequence;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // SQLite cannot change a CHECK in place. Copy metadata only; attachment
  // bytes and paths remain untouched. Fail closed on an unfamiliar schema.
  private migrateFileSizeLimit(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='input_files'").get() as { sql: string } | undefined;
    if (!schema?.sql) throw new Error('Missing input_files schema');
    const sizeCheck = /size\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*size\s*>=\s*0\s+AND\s+size\s*<=\s*(\d+)\s*\)/iu.exec(schema.sql);
    if (!sizeCheck || !['8000000', '100000000'].includes(sizeCheck[1]!)) throw new Error('Unrecognized input_files size constraint');
    if (sizeCheck[1] === '100000000') return;
    // Rebuilding a customized table would silently discard extra constraints or
    // column defaults. Only migrate the schema shipped by the previous version.
    const definition = schema.sql.slice(schema.sql.indexOf('(')).replace(/\s+/gu, '').toLowerCase();
    const legacyDefinition = `(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0 AND position < 6),
      name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 8000000),
      path TEXT NOT NULL, UNIQUE(operation_id, position))`.replace(/\s+/gu, '').toLowerCase();
    if (definition !== legacyDefinition) throw new Error('Unrecognized input_files schema');
    const columns = this.db.prepare('PRAGMA table_info(input_files)').all() as Array<{ name: string }>;
    const expected = ['id', 'operation_id', 'owner_id', 'session_id', 'position', 'name', 'media_type', 'size', 'path'];
    if (JSON.stringify(columns.map(column => column.name)) !== JSON.stringify(expected) ||
        !/UNIQUE\s*\(\s*operation_id\s*,\s*position\s*\)/iu.test(schema.sql)) {
      throw new Error('Unrecognized input_files schema');
    }
    // Unknown foreign keys must not be silently redirected by a table rebuild.
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const escaped = name.replaceAll('"', '""');
      const foreign = this.db.prepare(`PRAGMA foreign_key_list("${escaped}")`).all() as Array<{ table: string }>;
      if (foreign.some(key => key.table === 'input_files')) throw new Error('Unsupported foreign key to input_files');
    }
    const dependent = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='input_files' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as Array<{ sql: string }>;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE input_files_large_v2 (
          id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(position >= 0 AND position < 6), name TEXT NOT NULL,
          media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 100000000),
          path TEXT NOT NULL, UNIQUE(operation_id, position)
        );
        INSERT INTO input_files_large_v2(id,operation_id,owner_id,session_id,position,name,media_type,size,path)
          SELECT id,operation_id,owner_id,session_id,position,name,media_type,size,path FROM input_files;
        DROP TABLE input_files;
        ALTER TABLE input_files_large_v2 RENAME TO input_files;
      `);
      for (const { sql } of dependent) this.db.exec(sql);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Preserve positions and identities while extending the old CHECK constraint.
  private migrateTimelineSlots(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_timeline_slots'").get() as { sql: string } | undefined;
    if (!schema?.sql) throw new Error('Missing chat_timeline_slots schema');
    const normalize = (sql: string) => sql.replace(/\s+/gu, '').toLowerCase();
    const definition = normalize(schema.sql.slice(schema.sql.indexOf('(')));
    const expected = (kinds: string) => normalize(`(session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN (${kinds})),
      position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(session_id,turn_id,item_id),
      UNIQUE(session_id,turn_id,position))`);
    if (definition === expected("'user','text','image','voice','ui'")) return;
    if (definition !== expected("'user','text','image','voice'")) throw new Error('Unrecognized chat_timeline_slots schema');
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const escaped = name.replaceAll('"', '""');
      const foreign = this.db.prepare(`PRAGMA foreign_key_list("${escaped}")`).all() as Array<{ table: string }>;
      if (foreign.some(key => key.table === 'chat_timeline_slots')) throw new Error('Unsupported foreign key to chat_timeline_slots');
    }
    const dependent = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='chat_timeline_slots' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as Array<{ sql: string }>;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE chat_timeline_slots_ui_v2 (
          session_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user','text','image','voice','ui')),
          position INTEGER NOT NULL CHECK(position >= 0),
          PRIMARY KEY(session_id,turn_id,item_id), UNIQUE(session_id,turn_id,position)
        );
        INSERT INTO chat_timeline_slots_ui_v2 SELECT session_id,turn_id,item_id,kind,position FROM chat_timeline_slots;
        DROP TABLE chat_timeline_slots;
        ALTER TABLE chat_timeline_slots_ui_v2 RENAME TO chat_timeline_slots;
      `);
      for (const { sql } of dependent) this.db.exec(sql);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private transaction<T>(callback: () => T | Promise<T>, beforeCommit?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Session store is closed'));
    const result = this.writes.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const value = await callback();
        beforeCommit?.();
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

  async recordTimelineSlot(sessionId: string, turnId: string, itemId: string, kind: 'user' | 'text' | 'image' | 'voice' | 'ui'): Promise<void> {
    await this.transaction(() => {
      const previous = this.db.prepare('SELECT kind FROM chat_timeline_slots WHERE session_id=? AND turn_id=? AND item_id=?').get(sessionId, turnId, itemId) as { kind: string } | undefined;
      if (previous) { if (previous.kind !== kind) throw identityConflict(); return; }
      this.db.prepare('INSERT INTO chat_timeline_slots(session_id,turn_id,item_id,kind,position) SELECT ?,?,?,?,COALESCE(MAX(position)+1,0) FROM chat_timeline_slots WHERE session_id=? AND turn_id=?').run(sessionId, turnId, itemId, kind, sessionId, turnId);
    });
  }
  async timelineSlots(sessionId: string, turnId: string): Promise<Array<{ itemId: string; kind: 'user' | 'text' | 'image' | 'voice' | 'ui'; position: number }>> {
    return this.transaction(() => (this.db.prepare('SELECT item_id,kind,position FROM chat_timeline_slots WHERE session_id=? AND turn_id=? ORDER BY position').all(sessionId, turnId) as Array<{ item_id: string; kind: 'user' | 'text' | 'image' | 'voice' | 'ui'; position: number }>).map(row => ({ itemId: row.item_id, kind: row.kind, position: row.position })));
  }

  private async revision(): Promise<number> {
    return this.transaction(() => Number((this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS value FROM message_revisions').get() as { value: number }).value));
  }

  async admit(id: string, input: string, images: readonly StoredImage[] = [], shared?: { sessionId: string; input: Submission }, authorize?: () => Promise<void>, beforeCommit?: () => void, fileScope?: { ownerId: string; sessionId: string; files: StoredFile[] }): Promise<MessageMeta> {
    return this.transaction(async () => {
      this.assertNotRetired(id);
      this.assertPathsNotRetired(fileScope?.files ?? []);
      this.assertPathsNotRetired(images);
      // The transaction may have waited behind other writes after admission began.
      if (authorize) await authorize();
      const reservedFiles = this.db.prepare('SELECT owner_id,session_id,status FROM file_upload_operations WHERE operation_id=?').get(id) as { owner_id: string; session_id: string; status: string } | undefined;
      if (reservedFiles && (reservedFiles.status !== 'complete' || !fileScope || fileScope.ownerId !== reservedFiles.owner_id || fileScope.sessionId !== reservedFiles.session_id)) throw identityConflict();
      if (this.db.prepare('SELECT 1 FROM failed_submissions WHERE operation_id=?').get(id)) throw identityConflict();
      const retry = this.db.prepare('SELECT session_id,payload FROM retry_attempts WHERE attempt_id=?').get(id) as { session_id: string; payload: string | null } | undefined;
      if (retry && (!shared || retry.session_id !== shared.sessionId || retry.payload !== JSON.stringify(shared.input))) throw identityConflict();
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
        const row = this.db.prepare('SELECT owner_id,session_id,payload FROM staged_files WHERE operation_id=?').get(id) as { owner_id: string; session_id: string; payload: string } | undefined;
        const staged = row ? JSON.parse(row.payload) as StagedFiles : undefined;
        if (fileScope) {
          if (!row || row.owner_id !== fileScope.ownerId || row.session_id !== shared.sessionId || fileScope.sessionId !== shared.sessionId || JSON.stringify(staged?.files) !== JSON.stringify(fileScope.files) || JSON.stringify(staged?.refs) !== JSON.stringify(shared.input.files)) throw identityConflict();
          if (fileScope.files.length > 6 || fileScope.files.reduce((sum, file) => sum + file.size, 0) > 200_000_000 || fileScope.files.some((file, index) => {
            const ref = staged!.refs[index];
            return file.operation_id !== id || file.owner_id !== fileScope.ownerId || file.session_id !== fileScope.sessionId || file.position !== index || file.size < 0 || file.size > 100_000_000 || !ref || ref.attachmentId !== file.id || ref.name !== file.name || ref.mediaType !== file.media_type || ref.size !== file.size || ref.availability !== 'available';
          })) throw identityConflict();
        } else if (row || shared.input.files?.length) throw identityConflict();
      }
      if (shared) {
        for (const sourceId of shared.input.replacementSourceIds ?? []) {
          if (this.db.prepare('SELECT 1 FROM deleted_failures WHERE operation_id=?').get(sourceId)) throw new Error('Replacement source is not eligible');
          if ((!this.db.prepare('SELECT 1 FROM pending_inputs p JOIN rejected_inputs r ON r.message_id=p.message_id WHERE p.message_id=?').get(sourceId)
            || this.db.prepare("SELECT 1 FROM message_outcomes WHERE message_id=? AND status='replaced'").get(sourceId))
            && !this.db.prepare('SELECT 1 FROM failed_submissions WHERE operation_id=? AND replaced_by IS NULL AND operation_id NOT IN (SELECT operation_id FROM deleted_failures)').get(sourceId)) throw new Error('Replacement source is not eligible');
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
      // JSON strings preserve even isolated surrogate code units through SQLite UTF-8.
      for (const file of fileScope?.files ?? []) this.db.prepare('INSERT INTO input_files(id,operation_id,owner_id,session_id,position,name,media_type,size,path) VALUES(?,?,?,?,?,?,?,?,?)').run(file.id,id,file.owner_id,file.session_id,file.position,JSON.stringify(file.name),JSON.stringify(file.media_type),file.size,file.path);
      this.addRevision(id);
      return this.meta(this.db.prepare('SELECT sequence,id,created FROM message_meta WHERE id=?').get(id) as { sequence: number; id: string; created: number });
    }, beforeCommit);
  }

  private reservation(operationId: string, ownerId: string, sessionId: string): FileReservation | undefined {
    const retired = this.db.prepare('SELECT owner_id,session_id FROM file_upload_retirements WHERE operation_id=?').get(operationId) as { owner_id: string; session_id: string } | undefined;
    if (retired) { if (retired.owner_id === ownerId && retired.session_id === sessionId) throw new FileOperationRetired(); return undefined; }
    const row = this.db.prepare('SELECT manifest,status,dir_key FROM file_upload_operations WHERE operation_id=? AND owner_id=? AND session_id=?').get(operationId, ownerId, sessionId) as { manifest: string; status: 'uploading' | 'complete'; dir_key: string } | undefined;
    if (!row) return undefined;
    const files = this.db.prepare('SELECT file_id,position,digest,path,attachment_id FROM file_upload_files WHERE operation_id=? ORDER BY position').all(operationId) as FileReservationRow[];
    const staged = row.status === 'complete' ? this.db.prepare('SELECT payload FROM staged_files WHERE operation_id=? AND owner_id=? AND session_id=?').get(operationId, ownerId, sessionId) as { payload: string } | undefined : undefined;
    if (row.status === 'complete' && !staged) throw new Error('Completed file staging unavailable');
    return { manifest: JSON.parse(row.manifest), status: row.status, dirKey: row.dir_key, files, ...(staged ? { staged: JSON.parse(staged.payload) } : {}) };
  }
  async fileReservation(operationId: string, ownerId: string, sessionId: string): Promise<FileReservation | undefined> {
    return this.transaction(() => this.reservation(operationId, ownerId, sessionId));
  }
  private fileOperationIdentityTaken(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM staged_files WHERE operation_id=? UNION ALL SELECT 1 FROM message_meta WHERE id=? UNION ALL SELECT 1 FROM failed_submissions WHERE operation_id=? UNION ALL SELECT 1 FROM retry_attempts WHERE attempt_id=? UNION ALL SELECT 1 FROM shared_submissions WHERE operation_id=? UNION ALL SELECT 1 FROM deleted_failures WHERE operation_id=? UNION ALL SELECT 1 FROM file_upload_retirements WHERE operation_id=? LIMIT 1').get(id, id, id, id, id, id, id);
  }
  private assertNotRetired(id: string): void {
    if (this.db.prepare('SELECT 1 FROM file_upload_retirements WHERE operation_id=?').get(id)) throw identityConflict();
  }
  private assertCompleteUpload(id: string): void {
    if (this.db.prepare("SELECT 1 FROM file_upload_operations WHERE operation_id=? AND status<>'complete'").get(id)) throw identityConflict();
  }
  private assertPathsNotRetired(files: readonly { path: string }[]): void {
    for (const file of files) {
      const path = resolve(file.path);
      const key = fileDirectoryKey(path);
      if (!key) continue;
      const row = this.db.prepare('SELECT f.path,r.operation_id AS retired FROM file_upload_operations o LEFT JOIN file_upload_retirements r ON r.operation_id=o.operation_id LEFT JOIN file_upload_files f ON f.operation_id=o.operation_id AND f.path=? WHERE o.dir_key=?').get(path,key) as { path: string | null; retired: string | null } | undefined;
      if (!row?.path || row.retired) throw identityConflict();
    }
  }
  private imagesReferencePaths(paths: ReadonlySet<string>, dirKey: string): boolean {
    const matches = (path: string) => paths.has(resolve(path)) || fileDirectoryKey(path) === dirKey;
    for (const row of this.db.prepare('SELECT path FROM input_images').iterate() as Iterable<{ path: string }>) if (matches(row.path)) return true;
    for (const row of this.db.prepare('SELECT payload FROM staged_images').iterate() as Iterable<{ payload: string }>) {
      const staged = JSON.parse(row.payload) as StagedImages;
      if (!Array.isArray(staged.images) || !Array.isArray(staged.variants)) return true;
      for (const image of staged.images) if (typeof image.path !== 'string' || matches(image.path)) return true;
      for (const variant of staged.variants) {
        if (!variant || typeof variant !== 'object') return true;
        if ('previewPath' in variant || 'modelPath' in variant) {
          if (!('previewPath' in variant) || !('modelPath' in variant) || typeof variant.previewPath !== 'string' || typeof variant.modelPath !== 'string' || matches(variant.previewPath) || matches(variant.modelPath)) return true;
        }
      }
    }
    return false;
  }
  // Quota is for unadmitted uploads. A retry may give the same paths new IDs.
  private filesInHistory(source: { operation_id: string; owner_id: string; session_id: string; status: string; dir_key: string; manifest: string }): boolean {
    try {
      if (source.status !== 'complete' || this.db.prepare('SELECT 1 FROM file_upload_retirements WHERE operation_id=?').get(source.operation_id)) return false;
      const manifest = JSON.parse(source.manifest) as FileManifest;
      const files = this.db.prepare('SELECT file_id,position,name,media_type,size,digest,path,attachment_id,uploaded_at FROM file_upload_files WHERE operation_id=? ORDER BY position').all(source.operation_id) as Array<{ file_id: string; position: number; name: string; media_type: string; size: number; digest: string | null; path: string | null; attachment_id: string | null; uploaded_at: number | null }>;
      if (manifest.operationId !== source.operation_id || manifest.sessionId !== source.session_id || !Array.isArray(manifest.files) || !files.length || files.length > 6 || manifest.files.length !== files.length) return false;
      const shared = this.db.prepare('SELECT 1 FROM input_files i JOIN message_meta m ON m.id=i.operation_id JOIN shared_submissions s ON s.operation_id=i.operation_id AND s.session_id=i.session_id WHERE i.owner_id=? AND i.session_id=? AND i.position=? AND i.path=? AND i.name=? AND i.media_type=? AND i.size=? LIMIT 1');
      return files.every((file, index) => {
        const entry = manifest.files[index];
        if (!entry || file.file_id !== entry.id || file.position !== index || file.name !== JSON.stringify(entry.name) || file.media_type !== JSON.stringify(entry.mediaType) || file.size !== entry.size || !file.path || !file.digest || !file.attachment_id || file.uploaded_at === null || fileDirectoryKey(file.path) !== source.dir_key || basename(file.path) !== `p${index}-${file.digest}.file`) return false;
        return !!shared.get(source.owner_id,source.session_id,index,file.path,file.name,file.media_type,file.size);
      });
    } catch { return false; }
  }
  async reserveFiles(manifest: FileManifest, ownerId: string, dirKey: string, beforeCommit?: () => void): Promise<FileReservation> {
    return this.transaction(() => {
      const previous = this.reservation(manifest.operationId, ownerId, manifest.sessionId);
      if (previous) {
        if (JSON.stringify(previous.manifest) !== JSON.stringify(manifest) || (previous.status === 'uploading' && this.fileOperationIdentityTaken(manifest.operationId))) throw identityConflict();
        this.db.prepare('UPDATE file_upload_operations SET updated_at=? WHERE operation_id=?').run(Date.now(), manifest.operationId);
        return previous;
      }
      if (this.db.prepare('SELECT 1 FROM file_upload_operations WHERE operation_id=? UNION ALL SELECT 1 FROM file_upload_retirements WHERE operation_id=?').get(manifest.operationId, manifest.operationId)) throw new FileOperationNotFound();
      if (this.fileOperationIdentityTaken(manifest.operationId)) throw identityConflict();
      // Retirements retain their reservation charge until cleanup is durable.
      // Direct shared admission commits the message and its input files atomically.
      const charged = this.db.prepare("SELECT o.operation_id,o.owner_id,o.session_id,o.status,o.dir_key,o.manifest,(SELECT COALESCE(sum(size),0) FROM file_upload_files f WHERE f.operation_id=o.operation_id) AS bytes FROM file_upload_operations o WHERE NOT EXISTS (SELECT 1 FROM file_upload_retirements r WHERE r.operation_id=o.operation_id AND r.state='retired') AND NOT (o.status='complete' AND NOT EXISTS (SELECT 1 FROM file_upload_retirements r WHERE r.operation_id=o.operation_id) AND EXISTS (SELECT 1 FROM shared_submissions s JOIN message_meta m ON m.id=s.operation_id WHERE s.operation_id=o.operation_id AND s.session_id=o.session_id))").iterate() as Iterable<{ operation_id: string; owner_id: string; session_id: string; status: string; dir_key: string; manifest: string; bytes: number }>;
      let count = 0, bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
      for (const row of charged) if (!this.filesInHistory(row)) {
        count++; bytes += row.bytes;
        if (count >= 16 || bytes > 800_000_000) throw new Error('File reservation quota exceeded');
      }
      const now = Date.now();
      this.db.prepare("INSERT INTO file_upload_operations(operation_id,owner_id,session_id,manifest,status,created_at,updated_at,dir_key) VALUES(?,?,?,?, 'uploading',?,?,?)").run(manifest.operationId, ownerId, manifest.sessionId, JSON.stringify(manifest), now, now, dirKey);
      const insert = this.db.prepare('INSERT INTO file_upload_files(operation_id,file_id,position,name,media_type,size) VALUES(?,?,?,?,?,?)');
      manifest.files.forEach((file, position) => insert.run(manifest.operationId, file.id, position, JSON.stringify(file.name), JSON.stringify(file.mediaType), file.size));
      return this.reservation(manifest.operationId, ownerId, manifest.sessionId)!;
    }, beforeCommit);
  }
  async recordFileUpload(manifest: FileManifest, ownerId: string, fileId: string, uploaded: { digest: string; path: string; attachmentId: string }, beforeCommit?: () => void): Promise<void> {
    await this.transaction(() => {
      const op = this.reservation(manifest.operationId, ownerId, manifest.sessionId);
      if (!op) throw new FileOperationNotFound();
      if (JSON.stringify(op.manifest) !== JSON.stringify(manifest)) throw identityConflict();
      const file = op.files.find(row => row.file_id === fileId);
      if (!file) throw identityConflict();
      if (fileDirectoryKey(uploaded.path) !== op.dirKey || basename(uploaded.path) !== `p${file.position}-${uploaded.digest}.file`) throw identityConflict();
      if (file.digest !== null) {
        if (file.digest !== uploaded.digest || file.attachment_id !== uploaded.attachmentId) throw identityConflict();
        this.db.prepare('UPDATE file_upload_operations SET updated_at=? WHERE operation_id=?').run(Date.now(), manifest.operationId);
        return;
      }
      if (op.status !== 'uploading') throw identityConflict();
      this.db.prepare('UPDATE file_upload_files SET digest=?,path=?,attachment_id=?,uploaded_at=? WHERE operation_id=? AND file_id=? AND digest IS NULL').run(uploaded.digest, uploaded.path, uploaded.attachmentId, Date.now(), manifest.operationId, fileId);
      this.db.prepare('UPDATE file_upload_operations SET updated_at=? WHERE operation_id=?').run(Date.now(), manifest.operationId);
    }, beforeCommit);
  }
  async completeFileReservation(manifest: FileManifest, ownerId: string, payload: StagedFiles, beforeCommit?: () => void): Promise<StagedFiles> {
    return this.transaction(() => {
      const op = this.reservation(manifest.operationId, ownerId, manifest.sessionId);
      if (!op) throw new FileOperationNotFound();
      if (JSON.stringify(op.manifest) !== JSON.stringify(manifest)) throw identityConflict();
      if (op.status === 'complete') { if (JSON.stringify(op.staged) !== JSON.stringify(payload)) throw identityConflict(); this.db.prepare('UPDATE file_upload_operations SET updated_at=? WHERE operation_id=?').run(Date.now(), manifest.operationId); return op.staged!; }
      if (op.files.length !== payload.files.length || op.files.some((file, index) => !file.digest || file.path !== payload.files[index]?.path || file.attachment_id !== payload.files[index]?.id)) throw identityConflict();
      if (this.fileOperationIdentityTaken(manifest.operationId)) throw identityConflict();
      const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      this.db.prepare('INSERT INTO staged_files(operation_id,owner_id,session_id,fingerprint,payload) VALUES(?,?,?,?,?)').run(manifest.operationId, ownerId, manifest.sessionId, fingerprint, JSON.stringify(payload));
      this.db.prepare("UPDATE file_upload_operations SET status='complete',updated_at=? WHERE operation_id=?").run(Date.now(), manifest.operationId);
      return payload;
    }, beforeCommit);
  }
  async hasFileDirectoryKey(key: string): Promise<boolean> {
    return this.transaction(() => !!this.db.prepare('SELECT 1 FROM file_upload_operations WHERE dir_key=?').get(key));
  }
  async expiredFileReservations(cutoff: number): Promise<RetirementCandidate[]> {
    return this.transaction(() => {
      const candidates: RetirementCandidate[] = [];
      const query = this.db.prepare(`SELECT o.rowid AS scan_id,o.operation_id,o.owner_id,o.session_id FROM file_upload_operations o
        WHERE o.rowid>? AND o.updated_at<?
          AND NOT EXISTS (SELECT 1 FROM file_upload_retirements WHERE operation_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM message_meta WHERE id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM shared_submissions WHERE operation_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM pending_inputs WHERE message_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM input_files WHERE operation_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM failed_submissions WHERE operation_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM deleted_failures WHERE operation_id=o.operation_id)
          AND NOT EXISTS (SELECT 1 FROM retry_attempts WHERE attempt_id=o.operation_id OR source_id=o.operation_id)
        ORDER BY o.rowid LIMIT 32`);
      let rows = query.all(this.fileExpiryCursor, cutoff) as Array<{ scan_id: number; operation_id: string; owner_id: string; session_id: string }>;
      if (!rows.length && this.fileExpiryCursor) rows = query.all(0, cutoff) as typeof rows;
      this.fileExpiryCursor = rows.length ? rows[rows.length - 1]!.scan_id : 0;
      for (const row of rows) try {
        const reservation = this.reservation(row.operation_id, row.owner_id, row.session_id);
        if (reservation && this.retirementUnreferenced(row.operation_id, reservation.dirKey)) candidates.push({ ownerId: row.owner_id, sessionId: row.session_id, reservation });
      } catch { /* retain uncertain data */ }
      return candidates;
    });
  }
  private retirementUnreferenced(id: string, key: string): boolean {
    if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=? UNION ALL SELECT 1 FROM shared_submissions WHERE operation_id=? UNION ALL SELECT 1 FROM pending_inputs WHERE message_id=? UNION ALL SELECT 1 FROM input_files WHERE operation_id=? UNION ALL SELECT 1 FROM failed_submissions WHERE operation_id=? UNION ALL SELECT 1 FROM deleted_failures WHERE operation_id=? UNION ALL SELECT 1 FROM retry_attempts WHERE attempt_id=? OR source_id=? LIMIT 1').get(id,id,id,id,id,id,id,id)) return false;
    const own = this.db.prepare('SELECT path,attachment_id FROM file_upload_files WHERE operation_id=?').all(id) as Array<{ path: string | null; attachment_id: string | null }>;
    const paths = new Set(own.flatMap(file => file.path ? [resolve(file.path)] : []));
    const ids = own.flatMap(file => file.attachment_id ? [file.attachment_id] : []);
    const matches = (path: string) => paths.has(resolve(path)) || fileDirectoryKey(path) === key;
    if (this.imagesReferencePaths(paths, key)) return false;
    for (const row of this.db.prepare('SELECT path FROM input_files UNION ALL SELECT path FROM file_upload_files WHERE path IS NOT NULL AND operation_id<>?').iterate(id) as Iterable<{ path: string }>) if (matches(row.path)) return false;
    for (const row of this.db.prepare('SELECT payload FROM staged_files WHERE operation_id<>?').iterate(id) as Iterable<{ payload: string }>) {
      const staged = JSON.parse(row.payload) as StagedFiles;
      if (!Array.isArray(staged.files) || !Array.isArray(staged.refs)) return false;
      if (staged.files.some(file => matches(file.path) || ids.includes(file.id)) || staged.refs.some(ref => ids.includes(ref.attachmentId))) return false;
    }
    for (const row of this.db.prepare('SELECT payload FROM failed_submissions').iterate() as Iterable<{ payload: string }>) {
      const failure = JSON.parse(row.payload) as Submission;
      if (failure.replacementSourceIds && (!Array.isArray(failure.replacementSourceIds) || failure.replacementSourceIds.includes(id))) return false;
      if (failure.files && (!Array.isArray(failure.files) || failure.files.some(file => ids.includes(file.attachmentId)))) return false;
    }
    return true;
  }
  async beginFileRetirement(candidate: RetirementCandidate, cutoff: number): Promise<boolean> {
    return this.transaction(() => {
      const id = candidate.reservation.manifest.operationId;
      const row = this.db.prepare('SELECT updated_at FROM file_upload_operations WHERE operation_id=? AND owner_id=? AND session_id=?').get(id,candidate.ownerId,candidate.sessionId) as { updated_at: number } | undefined;
      if (!row || row.updated_at >= cutoff || JSON.stringify(this.reservation(id,candidate.ownerId,candidate.sessionId)) !== JSON.stringify(candidate.reservation)) return false;
      const own = this.db.prepare('SELECT payload FROM staged_files WHERE operation_id=?').get(id) as { payload: string } | undefined;
      if (candidate.reservation.status === 'uploading' ? !!own : !own || JSON.stringify(JSON.parse(own.payload)) !== JSON.stringify(candidate.reservation.staged)) return false;
      const uploaded = candidate.reservation.files.filter(file => file.path !== null);
      if (uploaded.some(file => !file.digest || !file.attachment_id || fileDirectoryKey(file.path!) !== candidate.reservation.dirKey || basename(file.path!) !== `p${file.position}-${file.digest}.file`)) return false;
      if (candidate.reservation.staged && (candidate.reservation.staged.files.length !== uploaded.length || candidate.reservation.staged.refs.length !== uploaded.length || candidate.reservation.staged.files.some((file, index) => {
        const row = uploaded[index], entry = candidate.reservation.manifest.files[index], ref = candidate.reservation.staged!.refs[index];
        return !row || !entry || !ref || file.path !== row.path || file.id !== row.attachment_id || file.operation_id !== id || file.owner_id !== candidate.ownerId || file.session_id !== candidate.sessionId || file.position !== index || file.name !== entry.name || file.media_type !== entry.mediaType || file.size !== entry.size || ref.attachmentId !== file.id || ref.name !== file.name || ref.mediaType !== file.media_type || ref.size !== file.size || ref.availability !== 'available';
      }))) return false;
      if (!this.retirementUnreferenced(id,candidate.reservation.dirKey)) return false;
      this.db.prepare('INSERT INTO file_upload_retirements(operation_id,owner_id,session_id,reason,state,retired_at) VALUES(?,?,?,?,?,?)').run(id,candidate.ownerId,candidate.sessionId,candidate.reservation.status === 'complete' ? 'abandoned_complete' : 'expired_uploading','cleanup_pending',Date.now());
      this.db.prepare('DELETE FROM staged_files WHERE operation_id=?').run(id);
      return true;
    });
  }
  async pendingFileRetirements(): Promise<Array<{ operationId: string; dirKey: string }>> {
    return this.transaction(() => (this.db.prepare("SELECT r.operation_id,o.dir_key FROM file_upload_retirements r JOIN file_upload_operations o ON o.operation_id=r.operation_id WHERE r.state='cleanup_pending' ORDER BY r.retired_at LIMIT 32").all() as Array<{ operation_id: string; dir_key: string }>).map(row => ({ operationId: row.operation_id, dirKey: row.dir_key })));
  }
  async retirementSafe(id: string, key: string): Promise<boolean> {
    return this.transaction(() => !!this.db.prepare("SELECT 1 FROM file_upload_operations o JOIN file_upload_retirements r ON r.operation_id=o.operation_id WHERE o.operation_id=? AND o.dir_key=? AND r.state='cleanup_pending'").get(id,key) && this.retirementUnreferenced(id,key));
  }
  async retirementBoundFiles(id: string, key: string): Promise<StoredFile[] | undefined> {
    return this.transaction(() => {
      const op = this.db.prepare("SELECT o.owner_id,o.session_id,o.manifest FROM file_upload_operations o JOIN file_upload_retirements r ON r.operation_id=o.operation_id WHERE o.operation_id=? AND o.dir_key=? AND r.state='cleanup_pending'").get(id,key) as { owner_id: string; session_id: string; manifest: string } | undefined;
      if (!op || !this.retirementUnreferenced(id,key)) return undefined;
      const manifest = JSON.parse(op.manifest) as FileManifest;
      const rows = this.db.prepare('SELECT position,digest,path,attachment_id FROM file_upload_files WHERE operation_id=? AND path IS NOT NULL ORDER BY position').all(id) as Array<{ position: number; digest: string; path: string; attachment_id: string }>;
      return rows.map(row => {
        const entry = manifest.files[row.position];
        if (!entry || fileDirectoryKey(row.path) !== key || basename(row.path) !== `p${row.position}-${row.digest}.file`) throw identityConflict();
        return { id: row.attachment_id, operation_id: id, owner_id: op.owner_id, session_id: op.session_id, position: row.position, name: entry.name, media_type: entry.mediaType, size: entry.size, path: row.path };
      });
    });
  }
  async finishFileRetirement(id: string, key: string): Promise<void> {
    await this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM file_upload_operations o JOIN file_upload_retirements r ON r.operation_id=o.operation_id WHERE o.operation_id=? AND o.dir_key=? AND r.state='cleanup_pending'").get(id,key) || !this.retirementUnreferenced(id,key)) return;
      this.db.prepare("UPDATE file_upload_retirements SET state='retired' WHERE operation_id=?").run(id);
    });
  }
  async stageFiles(operationId: string, ownerId: string, sessionId: string, fingerprint: string, payload: StagedFiles, beforeCommit?: () => void): Promise<void> {
    await this.transaction(() => {
      this.assertNotRetired(operationId);
      this.assertPathsNotRetired(payload.files);
      if (this.db.prepare('SELECT 1 FROM file_upload_operations WHERE operation_id=?').get(operationId)) throw identityConflict();
      const old = this.db.prepare('SELECT owner_id,session_id,fingerprint FROM staged_files WHERE operation_id=?').get(operationId) as { owner_id: string; session_id: string; fingerprint: string } | undefined;
      if (old) { if (old.owner_id !== ownerId || old.session_id !== sessionId || old.fingerprint !== fingerprint) throw identityConflict(); return; }
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(operationId)) throw identityConflict();
      this.db.prepare('INSERT INTO staged_files(operation_id,owner_id,session_id,fingerprint,payload) VALUES(?,?,?,?,?)').run(operationId,ownerId,sessionId,fingerprint,JSON.stringify(payload));
    }, beforeCommit);
  }
  async stagedFiles(operationId: string, ownerId: string, sessionId: string): Promise<StagedFiles | undefined> {
    return this.transaction(() => { const row = this.db.prepare('SELECT payload FROM staged_files WHERE operation_id=? AND owner_id=? AND session_id=?').get(operationId,ownerId,sessionId) as { payload: string } | undefined; return row ? JSON.parse(row.payload) : undefined; });
  }
  async file(id: string, ownerId: string, sessionId: string): Promise<StoredFile | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM input_files WHERE id=? AND owner_id=? AND session_id=?').get(id,ownerId,sessionId) as StoredFile | undefined;
      if (row) return { ...row, name: JSON.parse(row.name), media_type: JSON.parse(row.media_type) };
      const staged = this.db.prepare('SELECT payload FROM staged_files WHERE owner_id=? AND session_id=?').all(ownerId,sessionId) as Array<{ payload: string }>;
      for (const entry of staged) { const file = (JSON.parse(entry.payload) as StagedFiles).files.find(item => item.id === id); if (file) return file; }
      return undefined;
    });
  }
  async inputFiles(operationId: string, ownerId: string, sessionId: string): Promise<StoredFile[]> {
    return this.transaction(() => (this.db.prepare('SELECT * FROM input_files WHERE operation_id=? AND owner_id=? AND session_id=? ORDER BY position').all(operationId,ownerId,sessionId) as StoredFile[]).map(row => ({ ...row, name: JSON.parse(row.name), media_type: JSON.parse(row.media_type) })));
  }

  async stageImages(operationId: string, sessionId: string, fingerprint: string, payload: StagedImages, beforeCommit?: () => void): Promise<void> {
    await this.transaction(() => {
      this.assertNotRetired(operationId);
      const variants: Array<{ path: string }> = [];
      for (const variant of payload.variants) if ('previewPath' in variant || 'modelPath' in variant) {
        if (!('previewPath' in variant) || !('modelPath' in variant) || typeof variant.previewPath !== 'string' || typeof variant.modelPath !== 'string') throw identityConflict();
        variants.push({ path: variant.previewPath }, { path: variant.modelPath });
      }
      this.assertPathsNotRetired([...payload.images, ...variants]);
      const old = this.db.prepare('SELECT session_id,fingerprint FROM staged_images WHERE operation_id=?').get(operationId) as { session_id: string; fingerprint: string } | undefined;
      if (old) { if (old.session_id !== sessionId || old.fingerprint !== fingerprint) throw identityConflict(); return; }
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(operationId)) throw identityConflict();
      this.db.prepare('INSERT INTO staged_images(operation_id,session_id,fingerprint,payload) VALUES(?,?,?,?)').run(operationId, sessionId, fingerprint, JSON.stringify(payload));
    }, beforeCommit);
  }
  async stagedImages(operationId: string, sessionId: string): Promise<StagedImages | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM staged_images WHERE operation_id=? AND session_id=?').get(operationId, sessionId) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) : undefined;
    });
  }
  async assertImageStageActive(operationId: string): Promise<void> {
    await this.transaction(() => this.assertNotRetired(operationId));
  }
  async stagedImageRef(id: string, sessionId: string): Promise<{ image: StoredImage; ref: ImageRef } | undefined> {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM staged_images WHERE session_id=?').all(sessionId) as Array<{ payload: string }>;
      for (const row of rows) { const payload = JSON.parse(row.payload) as StagedImages; const index = payload.images.findIndex(image => image.id === id); if (index >= 0) return { image: payload.images[index]!, ref: payload.refs[index]! }; }
      return undefined;
    });
  }
  async stagedMedia(id: string, sessionId: string): Promise<{ image: StoredImage; ref: ImageRef; preview: string; model: string; stickerTags?: string[] } | undefined> {
    const entry = await this.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM staged_images WHERE session_id=?').all(sessionId) as Array<{ payload: string }>;
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as StagedImages;
        const index = payload.images.findIndex(image => image.id === id);
        if (index >= 0) return { image: payload.images[index]!, ref: payload.refs[index]!, variant: payload.variants[index]! };
      }
      return undefined;
    });
    if (!entry) return undefined;
    const variant = entry.variant;
    if ('preview' in variant) return { image: entry.image, ref: entry.ref, ...variant };
    const readVariant = async (path: string, max: number) => {
      const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size <= 0 || stat.size > max) throw new Error('Sticker variant unavailable'); const bytes = await file.readFile(); const match = /\.([a-f0-9]{64})\.(?:preview|model)\.jpg$/u.exec(path); if (bytes.length !== stat.size || !match || createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error('Sticker variant changed'); return bytes.toString('base64'); }
      finally { await file.close(); }
    };
    const [preview, model] = await Promise.all([readVariant(variant.previewPath, 160_000), readVariant(variant.modelPath, 320_000)]);
    return { image: entry.image, ref: entry.ref, preview, model, ...(variant.stickerTags ? { stickerTags: variant.stickerTags } : {}) };
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
    return this.transaction(() => (this.db.prepare('SELECT payload FROM failed_submissions WHERE session_id=? AND replaced_by IS NULL AND operation_id NOT IN (SELECT operation_id FROM deleted_failures) ORDER BY rowid DESC LIMIT 20').all(sessionId) as Array<{ payload: string }>).reverse().map(row => JSON.parse(row.payload)));
  }
  /** Record definite rolled-back admission, never an execution/transport outcome. */
  async failSubmission(input: Submission, sessionId: string, error: string, beforeCommit?: () => void): Promise<void> {
    await this.transaction(() => {
      this.assertNotRetired(input.operationId);
      if (input.files?.length) this.assertCompleteUpload(input.operationId);
      for (const sourceId of input.replacementSourceIds ?? []) { this.assertNotRetired(sourceId); this.assertCompleteUpload(sourceId); }
      for (const file of input.files ?? []) {
        if (this.db.prepare('SELECT 1 FROM file_upload_files f JOIN file_upload_retirements r ON r.operation_id=f.operation_id WHERE f.attachment_id=?').get(file.attachmentId)) throw identityConflict();
        const staged = this.db.prepare('SELECT payload FROM staged_files WHERE session_id=?').all(sessionId) as Array<{ payload: string }>;
        if (!this.db.prepare('SELECT 1 FROM input_files WHERE id=? AND session_id=?').get(file.attachmentId,sessionId) && !staged.some(row => (JSON.parse(row.payload) as StagedFiles).refs.some(ref => ref.attachmentId === file.attachmentId && ref.name === file.name && ref.mediaType === file.mediaType && ref.size === file.size))) throw identityConflict();
      }
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(input.operationId)) throw new Error('Cannot fail a durably admitted input');
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const retry = this.db.prepare('SELECT session_id,source_id,payload FROM retry_attempts WHERE attempt_id=?').get(input.operationId) as { session_id: string; source_id: string; payload: string | null } | undefined;
      if (retry && (retry.session_id !== sessionId || retry.payload !== JSON.stringify(input))) throw identityConflict();
      const old = this.db.prepare('SELECT fingerprint,session_id FROM failed_submissions WHERE operation_id=?').get(input.operationId) as { fingerprint: string; session_id: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint || old.session_id !== sessionId) throw identityConflict(); return; }
      this.db.prepare('INSERT INTO failed_submissions(operation_id,session_id,fingerprint,payload,error) VALUES(?,?,?,?,?)').run(input.operationId, sessionId, fingerprint, JSON.stringify(input), error);
      if (retry) this.db.prepare('UPDATE failed_submissions SET replaced_by=? WHERE operation_id=? AND session_id=? AND replaced_by IS NULL').run(input.operationId,retry.source_id,sessionId);
    }, beforeCommit);
  }
  async retryAttempt(attemptId: string, sessionId: string, sourceId: string, bind = false, beforeCommit?: () => void): Promise<Submission | null | undefined> {
    return this.transaction(() => {
      if (bind) { this.assertNotRetired(attemptId); this.assertNotRetired(sourceId); this.assertCompleteUpload(attemptId); this.assertCompleteUpload(sourceId); }
      const row = this.db.prepare('SELECT session_id,source_id,payload FROM retry_attempts WHERE attempt_id=?').get(attemptId) as { session_id: string; source_id: string; payload: string | null } | undefined;
      if (row) {
        if (row.session_id !== sessionId || row.source_id !== sourceId) throw identityConflict();
        return row.payload ? JSON.parse(row.payload) : null;
      }
      if (bind) {
        if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(attemptId) || this.db.prepare('SELECT 1 FROM failed_submissions WHERE operation_id=?').get(attemptId)) throw identityConflict();
        this.db.prepare('INSERT INTO retry_attempts(attempt_id,session_id,source_id) VALUES(?,?,?)').run(attemptId,sessionId,sourceId);
      }
      return undefined;
    }, beforeCommit);
  }
  async retryBinding(attemptId: string, sessionId: string): Promise<{ sourceId: string; input: Submission | null } | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT source_id,payload FROM retry_attempts WHERE attempt_id=? AND session_id=?').get(attemptId, sessionId) as { source_id: string; payload: string | null } | undefined;
      return row ? { sourceId: row.source_id, input: row.payload ? JSON.parse(row.payload) : null } : undefined;
    });
  }
  async bindRetry(input: Submission, beforeCommit?: () => void): Promise<void> {
    await this.transaction(() => {
      this.assertNotRetired(input.operationId);
      const source = this.db.prepare('SELECT source_id FROM retry_attempts WHERE attempt_id=?').get(input.operationId) as { source_id: string } | undefined;
      if (source) this.assertNotRetired(source.source_id);
      this.db.prepare('UPDATE retry_attempts SET payload=? WHERE attempt_id=? AND payload IS NULL').run(JSON.stringify(input),input.operationId);
    }, beforeCommit);
  }
  async failureDeleted(id: string): Promise<boolean> {
    return this.transaction(() => !!this.db.prepare('SELECT 1 FROM deleted_failures WHERE operation_id=?').get(id));
  }
  async deleteFailed(id: string, sessionId: string, beforeCommit?: () => void): Promise<boolean> {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM message_meta WHERE id=?').get(id)) return false;
      if (!this.db.prepare('SELECT 1 FROM failed_submissions WHERE operation_id=? AND session_id=? AND replaced_by IS NULL').get(id,sessionId)) return false;
      this.db.prepare('INSERT OR IGNORE INTO deleted_failures(operation_id) VALUES(?)').run(id);
      return true;
    }, beforeCommit);
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
      this.assertNotRetired(event.input.id);
      this.assertPathsNotRetired(event.input.images ?? []);
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

  /** Receipt, original provenance and pending input commit before HTTP ACK. */
  async recordPostEvent(service: string, event: EventV1, body: string): Promise<string> {
    return this.transaction(() => {
      const id = postInputId(service, event);
      this.assertNotRetired(id);
      const receipt = this.db.prepare('SELECT body FROM post_receipts_v1 WHERE service=? AND agent=? AND delivery=?').get(service,event.agent_id,event.delivery_id) as { body: string } | undefined;
      if (receipt) { if (receipt.body !== body) throw identityConflict(); return id; }
      const canonical = this.db.prepare('SELECT message_id FROM post_sources_v1 WHERE canonical_key=? OR native_key=?').all(JSON.stringify([service,event.agent_id,event.message.id]),JSON.stringify([service,event.agent_id,event.message.account_id,event.message.conversation.id,event.message.native_message_id])) as Array<{ message_id: string }>;
      if (canonical.some(row => row.message_id !== id)) throw identityConflict();
      const source = this.db.prepare('SELECT event FROM post_sources_v1 WHERE message_id=?').get(id) as { event: string } | undefined;
      if (source) {
        const original = JSON.parse(source.event) as EventV1;
        if (JSON.stringify(original.message) !== JSON.stringify(event.message) || original.wake.reason !== event.wake.reason) throw identityConflict();
      } else {
        this.db.prepare('INSERT INTO message_meta(id,created) VALUES(?,?)').run(id,event.message.timestamp);
        this.db.prepare('INSERT INTO pending_inputs(message_id,input) VALUES(?,?)').run(id,postInput(event));
        this.db.prepare('INSERT INTO post_sources_v1(message_id,service,canonical_key,native_key,event) VALUES(?,?,?,?,?)').run(id,service,JSON.stringify([service,event.agent_id,event.message.id]),JSON.stringify([service,event.agent_id,event.message.account_id,event.message.conversation.id,event.message.native_message_id]),JSON.stringify(event));
        for (const asset of event.message.assets) this.db.prepare('INSERT INTO post_media_v1(message_id,asset_id) VALUES(?,?)').run(id,asset.asset_id);
        this.addRevision(id);
      }
      this.db.prepare('INSERT INTO post_receipts_v1(service,agent,delivery,body,message_id) VALUES(?,?,?,?,?)').run(service,event.agent_id,event.delivery_id,body,id);
      return id;
    });
  }
  async postContext(id: string): Promise<{ service: string; event: EventV1; media: Record<string,string>; ready: boolean } | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT service,event,media,ready FROM post_sources_v1 WHERE message_id=?').get(id) as { service: string; event: string; media: string; ready: number } | undefined;
      return row ? { service: row.service, event: JSON.parse(row.event), media: JSON.parse(row.media), ready: Boolean(row.ready) } : undefined;
    });
  }
  async postSources(ids: readonly string[]) {
    return this.transaction(() => {
      const result = new Map<string, ReturnType<typeof postPresentation>>();
      const read = this.db.prepare('SELECT event,media FROM post_sources_v1 WHERE message_id=?');
      for (const id of ids) {
        const row = read.get(id) as { event: string; media: string } | undefined;
        if (row) {
          const event = JSON.parse(row.event) as EventV1;
          result.set(id, postPresentation(event, JSON.parse(row.media), event.message.conversation.name));
        }
      }
      return result;
    });
  }
  async postMediaAttempt(id: string, asset: string): Promise<{ claimed: boolean; result: string | null }> {
    return this.transaction(() => {
      const update = this.db.prepare('UPDATE post_media_v1 SET attempts=attempts+1 WHERE message_id=? AND asset_id=? AND result IS NULL AND attempts<2').run(id,asset);
      const row = this.db.prepare('SELECT result FROM post_media_v1 WHERE message_id=? AND asset_id=?').get(id,asset) as { result: string | null };
      return { claimed: update.changes === 1, result: row.result };
    });
  }
  async recordPostMedia(id: string, asset: string, result: string, image?: StoredImage): Promise<void> {
    await this.transaction(() => {
      if (image) this.assertPathsNotRetired([image]);
      this.db.prepare('UPDATE post_media_v1 SET result=? WHERE message_id=? AND asset_id=? AND result IS NULL').run(result,id,asset);
      if (image) this.db.prepare('INSERT OR IGNORE INTO input_images(id,operation_id,name,media_type,path) VALUES(?,?,?,?,?)').run(image.id,id,image.name,image.media_type,image.path);
    });
  }
  async finishPostMedia(id: string): Promise<void> {
    await this.transaction(() => {
      const row = this.db.prepare('SELECT event FROM post_sources_v1 WHERE message_id=?').get(id) as { event: string };
      const results = this.db.prepare('SELECT asset_id,result FROM post_media_v1 WHERE message_id=?').all(id) as Array<{ asset_id: string; result: string | null }>;
      if (results.some(r => r.result === null)) throw new Error('Post media pending');
      const media = Object.fromEntries(results.map(r => [r.asset_id,r.result!]));
      const input = postInput(JSON.parse(row.event),media);
      this.db.prepare('UPDATE pending_inputs SET input=? WHERE message_id=?').run(input,id);
      this.db.prepare('UPDATE post_sources_v1 SET media=?,ready=1 WHERE message_id=?').run(JSON.stringify(media),id);
      this.addRevision(id);
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

  async matrixSources(ids: readonly string[]) {
    return this.transaction(() => {
      const result = new Map<string, Pick<MatrixEvent, 'sender_id' | 'sender_display_name' | 'room_id' | 'body' | 'timestamp'>>();
      const read = this.db.prepare('SELECT context FROM matrix_sources WHERE message_id=?');
      for (const id of ids) {
        const row = read.get(id) as { context: string } | undefined;
        if (row) {
          const { sender_id, sender_display_name, room_id, body, timestamp } = (JSON.parse(row.context) as MatrixContext).provenance;
          result.set(id, { sender_id, sender_display_name, room_id, body, timestamp });
        }
      }
      return result;
    });
  }

  async ensureMessage(id: string, created: number, input?: string, images: readonly StoredImage[] = []): Promise<MessageMeta> {
    return this.transaction(() => {
      this.assertNotRetired(id);
      this.assertPathsNotRetired(images);
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
