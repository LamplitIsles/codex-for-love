import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from '@jaminzhou/codex-app-server-client';
import type { v2 } from '@jaminzhou/codex-app-server-client/protocol';
import type { Config } from './config.ts';
import {
  bootstrapPath,
  ensureHookDeclaration,
  formatBootstrapContext,
  trustOwnedHooks,
  writeBootstrapFile,
} from './context-bootstrap.ts';
import { compactionPrompt, companionPrompt } from './prompts.ts';
import { Store } from './store.ts';
import { replaceRelationshipJournal } from './relationship-journal.ts';
import { partnerPaths } from './storage-paths.ts';
import {
  canonicalizeChangeReason,
  canonicalizeMood,
  canonicalizeSignature,
  clampAffinity,
  type CompanionState,
  type CompanionStateRecord,
} from '../src/lib/companion/domain.ts';
import type { CompactBoundary } from '../src/lib/continuity.ts';

/** The logical DSH session-log generation admitted by this one-time converter. */
export const DSH_SESSION_FORMAT_VERSION = 3;
export const DSH_RELEASED_PHYSICAL_FORMAT_VERSION = 0;

type JsonRecord = Record<string, unknown>;
export type DshCompression = 'jsonl' | 'jsonl.zstd';
export type DshSessionImportErrorKind = 'invalid-input' | 'unsupported-version' | 'ambiguous-checkpoint' | 'missing-data' | 'occupied-destination' | 'candidate-created';
type ImportErrorKind = DshSessionImportErrorKind;

export type DshSessionImportCandidate = {
  path: string;
  workspacePath: string;
  rolloutPath: string;
  provisionalThreadId: string;
};

/** Machine-readable extraction evidence. Text is returned separately for dry-run inspection. */
export type DshImportReport = {
  source: {
    path: string;
    sessionId: string;
    formatVersion: number;
    compression: DshCompression;
  };
  messages: { user: number; assistant: number };
  compactions: Array<{ compactionId: string; startSeq: number; summarySeq: number; replacementSeq: number; endSeq: number }>;
  relationships: number;
  media: number;
  avatars: number;
  omitted: {
    nonTextBlocks: Record<string, number>;
    toolEvents: number;
    opaqueEvents: number;
    packedChunkRows: number;
    fileBlocks: number;
    fileReferencesRemainText: false;
  };
  warnings: string[];
};

/** The complete extraction, including text only so a dry-run can be inspected. */
export type DshImportExtraction = {
  records: SemanticRecord[];
  media: MediaReference[];
  report: DshImportReport;
};

export type SessionImportDependencies = {
  appServer?: Partial<CodexAppServerClientOptions>;
};

export type DshSessionImportResult = {
  dryRun: boolean;
  report: DshImportReport;
  destination: {
    path: string;
    created: boolean;
    threadId?: string;
    rolloutPath?: string;
    workspacePath?: string;
  };
  records?: SemanticRecord[];
};

export class DshSessionImportError extends Error {
  readonly kind: ImportErrorKind;
  readonly candidate?: DshSessionImportCandidate;

  constructor(kind: ImportErrorKind, message: string, options?: ErrorOptions, candidate?: DshSessionImportCandidate) {
    super(message, options);
    this.kind = kind;
    this.candidate = candidate;
    this.name = 'DshSessionImportError';
  }
}

type DshEvent = JsonRecord & {
  type: string;
  seq: number;
  data: JsonRecord;
};

type NormalizedReplace = { op: 'replace'; startSeq: number; endSeq: number };
type SurfaceOperation = 'append' | NormalizedReplace;
type SurfaceReplacement = {
  event: DshEvent;
  operation: NormalizedReplace;
  shadowedSeqs: number[];
  eventIndex: number;
  surfaceAfter: number[];
};

type ParsedDshLog = {
  path: string;
  sessionId: string;
  compression: DshCompression;
  events: DshEvent[];
  eventsBySeq: Map<number, DshEvent>;
  formatVersion: 0 | 3;
  packedChunkRows: number;
  surface: number[];
  replacements: SurfaceReplacement[];
  turnBySeq: Map<number, number | undefined>;
  completedTurns: Map<number, { completed: boolean; superseded: boolean; eventIndex: number }>;
};

type Checkpoint = {
  compactionId: string;
  start: DshEvent;
  summary: DshEvent;
  replacement: SurfaceReplacement;
  end: DshEvent;
  summaryText: string;
};

export type SemanticRecord =
  | { type: 'user'; text: string; media: MediaReference[]; turn: number; seq: number; time: number }
  | { type: 'assistant'; text: string; turn: number; seq: number; time: number }
  | { type: 'compact'; compactionId: string; summary: string; replacement: Array<{ role: 'user' | 'assistant'; text: string }>; seq: number; time: number };

type MediaReference = { attachmentId: string; name: string; sourcePath?: string };

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);
const ZSTD_MAGIC = 0xFD2FB528;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string, cause?: unknown): never {
  throw new DshSessionImportError('invalid-input', message, cause === undefined ? undefined : { cause });
}

function unsupported(message: string): never {
  throw new DshSessionImportError('unsupported-version', message);
}

function ambiguous(message: string): never {
  throw new DshSessionImportError('ambiguous-checkpoint', message);
}

function missing(message: string): never {
  throw new DshSessionImportError('missing-data', message);
}

function occupied(message: string): never {
  throw new DshSessionImportError('occupied-destination', message);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be text`);
  return value;
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    invalid(`DSH session log line ${lineNumber} is not valid JSON`, error);
  }
}

/** Locate complete frames in the concatenated Zstandard container used by DSH. */
function zstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      invalid(`corrupt DSH Zstandard log at byte ${offset}`);
    }
    offset += 4;
    if (offset >= buffer.length) invalid(`truncated DSH Zstandard frame at byte ${start}`);
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) invalid(`corrupt DSH Zstandard frame header at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerBytes) invalid(`truncated DSH Zstandard frame header at byte ${start}`);
    offset += headerBytes;
    for (;;) {
      if (buffer.length - offset < 3) invalid(`truncated DSH Zstandard block at byte ${start}`);
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) invalid(`corrupt DSH Zstandard block at byte ${offset - 3}`);
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) invalid(`truncated DSH Zstandard block at byte ${start}`);
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) invalid(`truncated DSH Zstandard checksum at byte ${start}`);
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  if (!frames.length) invalid('DSH Zstandard log contains no complete frames');
  return frames;
}

function decodeLogBytes(bytes: Buffer, path: string): { text: string; compression: DshCompression } {
  const looksCompressed = bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC;
  if (path.endsWith('.zstd') && !looksCompressed) invalid('DSH .zstd log does not contain a Zstandard frame');
  let plain = bytes;
  const compression: DshCompression = looksCompressed ? 'jsonl.zstd' : 'jsonl';
  if (looksCompressed) {
    const chunks = zstdFrames(bytes).map((frame) => {
      try {
        return zstdDecompressSync(bytes.subarray(frame.start, frame.end));
      } catch (error) {
        invalid(`unable to decompress DSH Zstandard frame at byte ${frame.start}`, error);
      }
    });
    plain = Buffer.concat(chunks);
  }
  let textValue: string;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch (error) {
    invalid('DSH session log is not valid UTF-8', error);
  }
  if (!textValue.endsWith('\n')) invalid('DSH session log must end at a complete newline-delimited record');
  return { text: textValue, compression };
}

function parseHeader(value: unknown, path: string): { sessionId: string; version: 0 | 3 } {
  if (!isRecord(value) || value.type !== 'session') invalid('DSH session log does not begin with a session header');
  if (value.version !== DSH_RELEASED_PHYSICAL_FORMAT_VERSION && value.version !== DSH_SESSION_FORMAT_VERSION) {
    unsupported(`Unsupported DSH session format version ${String(value.version)} in ${path}; this converter supports released physical version 0 and logical version 3 only`);
  }
  const physical = value.version === DSH_RELEASED_PHYSICAL_FORMAT_VERSION;
  const allowed = new Set(physical
    ? ['type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'origin', 'delegationDepth', 'agentPreset']
    : ['type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) invalid(`DSH session header has unsupported field ${unexpected}`);
  const sessionId = text(value.id, 'DSH session header id');
  if (!sessionId) invalid('DSH session header id must not be empty');
  safeInteger(value.createdAt, 'DSH session header createdAt');
  safeInteger(value.delegationDepth, 'DSH session header delegationDepth');
  if (physical) {
    if (value.seedLength !== undefined) safeInteger(value.seedLength, 'DSH physical session header seedLength');
  } else if (typeof value.isSeeded !== 'boolean') invalid('DSH session header isSeeded must be boolean');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) invalid('DSH session header cwd must be an absolute path');
  if (value.parentSession !== undefined && typeof value.parentSession !== 'string') invalid('DSH session header parentSession must be text');
  if (value.origin !== undefined && value.origin !== 'subagent') invalid('DSH session header origin must be subagent');
  if (value.agentPreset !== undefined && typeof value.agentPreset !== 'string') invalid('DSH session header agentPreset must be text');
  return { sessionId, version: value.version };
}

const PACKED_CHUNK_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function packedEventCount(value: JsonRecord, lineNumber: number): number {
  const allowed = new Set(['type', 'seq0', 'time0', 'data']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`DSH packed row ${lineNumber} has unsupported fields`);
  safeInteger(value.seq0, `DSH packed row ${lineNumber} seq0`);
  if (typeof value.time0 !== 'number' || !Number.isSafeInteger(value.time0) || Object.is(value.time0, -0)) invalid(`DSH packed row ${lineNumber} has invalid time0`);
  if (!isRecord(value.data)) invalid(`DSH packed row ${lineNumber} data must be an object`);
  const isTool = value.type === 'tool-call-chunks';
  const dataKeys = new Set(isTool
    ? ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']
    : ['turn', 'step', 'index', 'dt', 'texts']);
  if (Object.keys(value.data).some((key) => !dataKeys.has(key))) invalid(`DSH packed row ${lineNumber} data has unsupported fields`);
  const payload = value.data[isTool ? 'args' : 'texts'];
  const dt = value.data.dt;
  if (!Array.isArray(payload) || !payload.length || payload.some((item) => typeof item !== 'string')) invalid(`DSH packed row ${lineNumber} payload must be a non-empty text array`);
  if (!Array.isArray(dt) || dt.length !== payload.length - 1 || dt.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) invalid(`DSH packed row ${lineNumber} dt must match its payload`);
  let lastTime = value.time0 as number;
  for (const gap of dt as number[]) {
    lastTime += gap;
    if (!Number.isSafeInteger(lastTime)) invalid(`DSH packed row ${lineNumber} final time is unsafe`);
  }
  for (const key of ['turn', 'step', 'index']) safeInteger(value.data[key], `DSH packed row ${lineNumber} ${key}`);
  if (isTool && (typeof value.data.id !== 'string' || !value.data.id || (value.data.name !== undefined && typeof value.data.name !== 'string'))) invalid(`DSH packed row ${lineNumber} has invalid tool identity`);
  return payload.length;
}

function parseEvents(textValue: string, path: string): { header: unknown; events: DshEvent[]; version: 0 | 3; packedChunkRows: number } {
  const lines = textValue.split('\n').slice(0, -1);
  if (!lines.length || lines.some((line) => line.length === 0)) invalid('DSH session log contains an empty record');
  const header = parseLine(lines[0]!, 1);
  const headerInfo = parseHeader(header, path);
  const events: DshEvent[] = [];
  let packedChunkRows = 0;
  let lastSeq = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index]!, index + 1);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') invalid(`DSH event line ${index + 1} has no event type`);
    if (PACKED_CHUNK_TYPES.has(parsed.type)) {
      if (headerInfo.version !== 0) unsupported(`DSH logical version 3 cannot contain physical packed row ${parsed.type}`);
      const eventCount = packedEventCount(parsed, index + 1);
      const seq0 = parsed.seq0 as number;
      if (seq0 <= lastSeq) invalid(`DSH packed row sequence ${seq0} is not strictly after ${lastSeq}`);
      lastSeq = seq0 + eventCount - 1;
      if (!Number.isSafeInteger(lastSeq)) invalid(`DSH packed row ${index + 1} final sequence is unsafe`);
      packedChunkRows += 1;
      continue;
    }
    const seq = safeInteger(parsed.seq, `DSH event line ${index + 1} seq`);
    if (seq <= lastSeq) invalid(`DSH event sequence ${seq} is not strictly after ${lastSeq}`);
    lastSeq = seq;
    if (typeof parsed.time !== 'number' || !Number.isSafeInteger(parsed.time) || Object.is(parsed.time, -0)) invalid(`DSH event ${seq} has invalid time`);
    if (!isRecord(parsed.data)) invalid(`DSH event ${seq} data must be an object`);
    events.push(parsed as DshEvent);
  }
  return { header, events, version: headerInfo.version, packedChunkRows };
}

function endpoint(value: unknown, label: string): number {
  return safeInteger(value, label);
}

function surfaceOperation(event: DshEvent): SurfaceOperation {
  if (!Object.hasOwn(event, 'surfaceOp')) invalid(`DSH surface event ${event.seq} is missing surfaceOp`);
  if (event.surfaceOp === 'append') return 'append';
  if (!isRecord(event.surfaceOp) || event.surfaceOp.op !== 'replace') invalid(`DSH surface event ${event.seq} has an unsupported surfaceOp`);
  const op = event.surfaceOp;
  const logical = Object.hasOwn(op, 'startSeq') || Object.hasOwn(op, 'endSeq');
  const physical = Object.hasOwn(op, 'start') || Object.hasOwn(op, 'end');
  if (logical && physical) ambiguous(`DSH surface event ${event.seq} mixes logical and serialized replace endpoints`);
  const startKey = logical ? 'startSeq' : 'start';
  const endKey = logical ? 'endSeq' : 'end';
  if (!Object.hasOwn(op, startKey) || !Object.hasOwn(op, endKey)) invalid(`DSH surface event ${event.seq} has incomplete replace endpoints`);
  const allowed = new Set(['op', startKey, endKey]);
  if (Object.keys(op).some((key) => !allowed.has(key))) invalid(`DSH surface event ${event.seq} has extra replace metadata`);
  const startSeq = endpoint(op[startKey], `DSH surface event ${event.seq} replace start`);
  const endSeq = endpoint(op[endKey], `DSH surface event ${event.seq} replace end`);
  if (startSeq >= event.seq || endSeq >= event.seq) invalid(`DSH surface event ${event.seq} replace endpoints must reference earlier events`);
  return { op: 'replace', startSeq, endSeq };
}

function sourceSequences(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || !value.length) invalid(`${label} must be a non-empty sequence list`);
  const result: number[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      if (item.length !== 2) invalid(`${label} contains an invalid compressed range`);
      const start = endpoint(item[0], `${label} range start`);
      const end = endpoint(item[1], `${label} range end`);
      if (end < start || end - start > 1_000_000) invalid(`${label} contains an invalid compressed range`);
      for (let seq = start; seq <= end; seq += 1) result.push(seq);
    } else result.push(endpoint(item, label));
  }
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate sequence numbers`);
  if (value.some((item) => Array.isArray(item))
    && result.some((seq, index) => index > 0 && seq <= result[index - 1]!)) {
    invalid(`${label} compressed ranges must be strictly increasing`);
  }
  return result;
}

function priorSequences(value: readonly number[], currentSeq: number, label: string): void {
  if (value.some((seq) => seq >= currentSeq)) invalid(`${label} must reference earlier events than seq ${currentSeq}`);
}

function messageData(event: DshEvent): JsonRecord | undefined {
  if (event.type === 'user/message') return event.data;
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return isRecord(event.data.message) ? event.data.message : undefined;
  }
  return undefined;
}

function compactSource(event: DshEvent): { compactionId: string } | undefined {
  if (event.type !== 'user/message') return undefined;
  const source = event.data.source;
  if (!isRecord(source) || source.kind !== 'plugin' || source.plugin !== 'compact') return undefined;
  if (typeof source.compactionId !== 'string' || !source.compactionId) missing(`DSH compact checkpoint at seq ${event.seq} has no compactionId`);
  return { compactionId: source.compactionId };
}

function span(value: unknown, label: string): { start: number; end: number } {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  const logical = Object.hasOwn(value, 'startSeq') || Object.hasOwn(value, 'endSeq');
  const physical = Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end');
  if (logical && physical) ambiguous(`${label} mixes logical and serialized endpoints`);
  const startKey = logical ? 'startSeq' : 'start';
  const endKey = logical ? 'endSeq' : 'end';
  if (!Object.hasOwn(value, startKey) || !Object.hasOwn(value, endKey)) invalid(`${label} has incomplete endpoints`);
  return { start: endpoint(value[startKey], `${label} start`), end: endpoint(value[endKey], `${label} end`) };
}

function messageContent(event: DshEvent, label: string): unknown[] {
  const message = messageData(event);
  if (!message || !Array.isArray(message.content)) invalid(`${label} has no content array`);
  return message.content;
}

function textBlocks(value: unknown[], label: string, omissions: Map<string, number>, allowNonText = true): { text: string; nonText: number } {
  const parts: string[] = [];
  let nonText = 0;
  for (const block of value) {
    if (!isRecord(block)) invalid(`${label} contains a non-object content block`);
    if (block.type === 'text') {
      if (typeof block.text !== 'string') invalid(`${label} contains a text block without text`);
      if (block.text.trim()) parts.push(block.text);
      continue;
    }
    nonText += 1;
    const kind = typeof block.type === 'string' ? block.type : 'unknown';
    omissions.set(kind, (omissions.get(kind) ?? 0) + 1);
    if (!allowNonText) unsupported(`${label} contains unsupported non-text summary content (${kind})`);
  }
  return { text: parts.join('\n\n').trim(), nonText };
}

function requiredTurn(value: unknown, label: string): number {
  return safeInteger(value, label, 1);
}

function optionalTurn(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredTurn(value, label);
}

function foldLog(path: string, sessionId: string, compression: DshCompression, events: DshEvent[], formatVersion: 0 | 3, packedChunkRows: number): ParsedDshLog {
  const surface: number[] = [];
  const replacements: SurfaceReplacement[] = [];
  const turnBySeq = new Map<number, number | undefined>();
  const completedTurns = new Map<number, { completed: boolean; superseded: boolean; eventIndex: number }>();
  let openTurn: number | undefined;

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === 'turn/start') {
      const turn = requiredTurn(event.data.turn, `DSH turn/start ${event.seq} turn`);
      if (openTurn !== undefined) {
        if (turn <= openTurn) invalid(`DSH turn ${turn} cannot supersede open turn ${openTurn}`);
        completedTurns.set(openTurn, { completed: false, superseded: true, eventIndex });
      } else if (completedTurns.has(turn)) {
        invalid(`DSH turn ${turn} starts more than once`);
      }
      openTurn = turn;
    }
    if (event.type === 'turn/end') {
      const turn = requiredTurn(event.data.turn, `DSH turn/end ${event.seq} turn`);
      if (openTurn !== turn) invalid(`DSH turn/end ${event.seq} does not close the open turn ${openTurn ?? 'none'}`);
      const reason = isRecord(event.data.reason) ? event.data.reason.kind : undefined;
      completedTurns.set(turn, { completed: reason === 'completed', superseded: false, eventIndex });
      openTurn = undefined;
    }

    if (!SURFACE_TYPES.has(event.type)) {
      if (Object.hasOwn(event, 'surfaceOp') || Object.hasOwn(event, 'sourceEventSeqs')) {
        unsupported(`DSH non-surface event ${event.type} at seq ${event.seq} carries surface metadata`);
      }
      continue;
    }

    const op = surfaceOperation(event);
    if (Object.hasOwn(event, 'sourceEventSeqs')) {
      const cited = sourceSequences(event.sourceEventSeqs, `DSH surface event ${event.seq} sourceEventSeqs`);
      priorSequences(cited, event.seq, `DSH surface event ${event.seq} sourceEventSeqs`);
      if (event.type === 'assistant/message' && formatVersion !== DSH_RELEASED_PHYSICAL_FORMAT_VERSION) {
        invalid(`DSH logical assistant/message ${event.seq} cannot carry sourceEventSeqs`);
      }
    }
    const directTurn = event.type === 'assistant/message' ? optionalTurn(event.data.turn, `DSH assistant/message ${event.seq} turn`) : optionalTurn(event.data.turn, `DSH user/message ${event.seq} turn`);
    const eventTurn = directTurn ?? openTurn;
    turnBySeq.set(event.seq, eventTurn);
    if (op === 'append') {
      surface.push(event.seq);
      continue;
    }
    const startIndex = surface.indexOf(op.startSeq);
    const endIndex = surface.indexOf(op.endSeq);
    if (startIndex < 0 || endIndex < 0) ambiguous(`DSH surface replacement at seq ${event.seq} does not target the current surface`);
    if (startIndex > endIndex) ambiguous(`DSH surface replacement at seq ${event.seq} reverses the current surface order`);
    const shadowedSeqs = surface.slice(startIndex, endIndex + 1);
    const cited = sourceSequences(event.sourceEventSeqs, `DSH replacement at seq ${event.seq} sourceEventSeqs`);
    priorSequences(cited, event.seq, `DSH replacement at seq ${event.seq} sourceEventSeqs`);
    const citedSet = new Set(cited);
    if (shadowedSeqs.some((seq) => !citedSet.has(seq))) invalid(`DSH replacement at seq ${event.seq} omits a shadowed surface event citation`);
    surface.splice(startIndex, shadowedSeqs.length, event.seq);
    replacements.push({ event, operation: op, shadowedSeqs, eventIndex, surfaceAfter: [...surface] });
  }
  return { path, sessionId, compression, events, eventsBySeq: new Map(events.map((event) => [event.seq, event])), formatVersion, packedChunkRows, surface, replacements, turnBySeq, completedTurns };
}

async function readDshLog(pathValue: string): Promise<ParsedDshLog> {
  const path = resolve(pathValue);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DshSessionImportError('missing-data', `DSH session log does not exist: ${path}`, { cause: error });
    throw error;
  }
  const decoded = decodeLogBytes(bytes, path);
  const parsed = parseEvents(decoded.text, path);
  const header = parsed.header as JsonRecord;
  return foldLog(path, text(header.id, 'DSH session header id'), decoded.compression, parsed.events, parsed.version, parsed.packedChunkRows);
}

function countOmittedEvents(log: ParsedDshLog): { toolEvents: number; opaqueEvents: number; fileBlocks: number } {
  let toolEvents = 0;
  let opaqueEvents = 0;
  let fileBlocks = 0;
  const known = new Set([
    'session', 'session/end-seed', 'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message',
    'tool/result', 'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
  ]);
  for (const event of log.events) {
    if (event.type.startsWith('tool/')) toolEvents += 1;
    if (!known.has(event.type)) opaqueEvents += 1;
    const data = messageData(event);
    if (!data || !Array.isArray(data.content)) continue;
    for (const block of data.content) {
      if (isRecord(block) && block.type === 'file') fileBlocks += 1;
    }
  }
  for (const event of log.events) {
    if (event.type !== 'compaction/summary' || !Array.isArray(event.data.summary)) continue;
    for (const block of event.data.summary) {
      if (isRecord(block) && block.type === 'file') fileBlocks += 1;
    }
  }
  return { toolEvents, opaqueEvents, fileBlocks };
}

function sortedCounts(values: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function checkpointsFor(log: ParsedDshLog): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  for (const replacement of log.replacements.filter((item) => compactSource(item.event))) {
    const compactionId = compactSource(replacement.event)!.compactionId;
    const starts = log.events.filter((event) => event.type === 'compaction/start' && event.data.compactionId === compactionId);
    const summaries = log.events.filter((event) => event.type === 'compaction/summary' && event.data.compactionId === compactionId);
    const ends = log.events.filter((event) => event.type === 'compaction/end' && event.data.compactionId === compactionId);
    if (starts.length !== 1 || summaries.length !== 1 || ends.length !== 1) ambiguous(`DSH compact checkpoint ${compactionId} does not have exactly one complete lifecycle`);
    const [start, summary, end] = [starts[0]!, summaries[0]!, ends[0]!];
    const indexes = [start, summary, replacement.event, end].map((event) => log.events.indexOf(event));
    if (!(indexes[0]! < indexes[1]! && indexes[1]! + 1 === indexes[2] && indexes[2]! + 1 === indexes[3])) ambiguous(`DSH compact checkpoint ${compactionId} is not one committed bracket`);
    if (Object.hasOwn(end.data, 'error')) ambiguous(`DSH compact checkpoint ${compactionId} ended with an error`);
    if (!Array.isArray(summary.data.summary)) missing(`DSH compact checkpoint ${compactionId} has no summary`);
    const summaryText = textBlocks(summary.data.summary, `DSH compaction summary ${summary.seq}`, new Map(), false).text;
    if (!summaryText) missing(`DSH compact checkpoint ${compactionId} has an empty summary`);
    const summaryRange = span(summary.data.shadowedRange, `DSH compaction summary ${summary.seq} shadowedRange`);
    if (summaryRange.start !== replacement.operation.startSeq || summaryRange.end !== replacement.operation.endSeq) ambiguous(`DSH compact checkpoint ${compactionId} range does not match its replacement`);
    const shadowed = sourceSequences(summary.data.shadowedSeqs, `DSH compaction summary ${summary.seq} shadowedSeqs`);
    if (shadowed.length !== replacement.shadowedSeqs.length || shadowed.some((seq, index) => seq !== replacement.shadowedSeqs[index])) ambiguous(`DSH compact checkpoint ${compactionId} shadowed surface does not match its replacement`);
    checkpoints.push({ compactionId, start, summary, replacement, end, summaryText });
  }
  if (!checkpoints.length) missing('DSH log contains no completed compact checkpoint');
  return checkpoints.sort((left, right) => left.replacement.eventIndex - right.replacement.eventIndex);
}

function collectMedia(value: unknown, media: Map<string, MediaReference>): void {
  if (Array.isArray(value)) { for (const item of value) collectMedia(item, media); return; }
  if (!isRecord(value)) return;
  if (typeof value.attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.attachmentId)
    && typeof value.mediaType === 'string' && value.mediaType.startsWith('image/')) {
    const name = typeof value.name === 'string' && value.name ? basename(value.name) : 'image';
    media.set(value.attachmentId, { attachmentId: value.attachmentId, name });
  }
  for (const child of Object.values(value)) collectMedia(child, media);
}

function mediaReferences(value: unknown): MediaReference[] {
  const media = new Map<string, MediaReference>();
  collectMedia(value, media);
  return [...media.values()];
}

function ordinaryMessage(log: ParsedDshLog, event: DshEvent, omissions: Map<string, number>): Extract<SemanticRecord, { type: 'user' | 'assistant' }> | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined;
  if (compactSource(event) || event.data.interrupted === true) return undefined;
  if (event.type === 'user/message') {
    const source = event.data.source;
    if (!isRecord(source) || source.kind !== 'user') return undefined;
  }
  const turn = log.turnBySeq.get(event.seq);
  if (turn === undefined) return undefined;
  const lifecycle = log.completedTurns.get(turn);
  if (!lifecycle || (!lifecycle.completed && !lifecycle.superseded)) return undefined;
  const value = messageData(event);
  if (!value || value.role !== (event.type === 'user/message' ? 'user' : 'assistant')) invalid(`DSH ${event.type} ${event.seq} has an invalid role`);
  const extracted = textBlocks(messageContent(event, `DSH ${event.type} ${event.seq}`), `DSH ${event.type} ${event.seq}`, omissions);
  // Keep an identity anchor for a user-authored image-only message. Historical
  // media is copied separately, but the assistant replies in that turn must
  // still remain projectable by Companion.
  if (!extracted.text && (event.type === 'assistant/message' || extracted.nonText === 0)) return undefined;
  return event.type === 'user/message'
    ? { type: 'user', text: extracted.text, media: mediaReferences(event.data), turn, seq: event.seq, time: Number(event.time) }
    : { type: 'assistant', text: extracted.text, turn, seq: event.seq, time: Number(event.time) };
}

function replacementFor(log: ParsedDshLog, checkpoint: Checkpoint, omissions: Map<string, number>): Array<{ role: 'user' | 'assistant'; text: string }> {
  const frame = (summary: string) => `The following checkpoint summarizes earlier conversation. Use it to maintain continuity alongside the context that follows. It is historical context, not a new message or request.\n\n${summary}`;
  const result: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const seq of checkpoint.replacement.surfaceAfter) {
    const event = log.eventsBySeq.get(seq);
    if (!event) ambiguous(`DSH compact replacement references missing surface event ${seq}`);
    const compact = compactSource(event);
    if (compact) {
      const summary = log.events.find((candidate) => candidate.type === 'compaction/summary' && candidate.data.compactionId === compact.compactionId);
      if (!summary || !Array.isArray(summary.data.summary)) ambiguous(`DSH compact checkpoint ${compact.compactionId} has no corresponding summary`);
      result.push({ role: 'user', text: frame(textBlocks(summary.data.summary, `DSH compaction summary ${summary.seq}`, new Map(), false).text) });
      continue;
    }
    const record = ordinaryMessage(log, event, omissions);
    if (record) result.push({ role: record.type, text: record.text });
  }
  if (!result.some((item) => item.text === frame(checkpoint.summaryText))) ambiguous(`DSH compact checkpoint ${checkpoint.compactionId} is absent from its replacement surface`);
  return result;
}

/** Parse one stable DSH log into user, assistant and completed compact semantics. */
export async function inspectDshLog(path: string): Promise<DshImportExtraction> {
  const log = await readDshLog(path);
  const checkpoints = checkpointsFor(log);
  const omissions = new Map<string, number>();
  const media = new Map<string, MediaReference>();
  for (const event of log.events) collectMedia(event.data, media);
  const compactBySeq = new Map(checkpoints.map((checkpoint) => [checkpoint.replacement.event.seq, checkpoint]));
  const records: SemanticRecord[] = [];
  for (const event of log.events) {
    const checkpoint = compactBySeq.get(event.seq);
    if (checkpoint) {
      records.push({ type: 'compact', compactionId: checkpoint.compactionId, summary: checkpoint.summaryText, replacement: replacementFor(log, checkpoint, omissions), seq: event.seq, time: Number(event.time) });
      continue;
    }
    const record = ordinaryMessage(log, event, omissions);
    if (record) records.push(record);
  }
  const lastConversational = [...log.events].reverse().find((event) => event.type === 'user/message' || event.type === 'assistant/message');
  if (lastConversational && !compactSource(lastConversational)) {
    const turn = log.turnBySeq.get(lastConversational.seq);
    const lifecycle = turn === undefined ? undefined : log.completedTurns.get(turn);
    if (!lifecycle || (!lifecycle.completed && !lifecycle.superseded)) invalid('DSH log ends with an incomplete, failed or active conversational turn');
  }
  const omittedEvents = countOmittedEvents(log);
  const report: DshImportReport = {
    source: { path: log.path, sessionId: log.sessionId, formatVersion: log.formatVersion, compression: log.compression },
    messages: { user: records.filter((record) => record.type === 'user').length, assistant: records.filter((record) => record.type === 'assistant').length },
    compactions: checkpoints.map((checkpoint) => ({ compactionId: checkpoint.compactionId, startSeq: checkpoint.start.seq, summarySeq: checkpoint.summary.seq, replacementSeq: checkpoint.replacement.event.seq, endSeq: checkpoint.end.seq })),
    relationships: 0,
    media: media.size,
    avatars: 0,
    omitted: { nonTextBlocks: sortedCounts(omissions), toolEvents: omittedEvents.toolEvents, opaqueEvents: omittedEvents.opaqueEvents, packedChunkRows: log.packedChunkRows, fileBlocks: omittedEvents.fileBlocks, fileReferencesRemainText: false },
    warnings: [],
  };
  return { records, media: [...media.values()], report };
}

function versionFromUserAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.match(/(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)(?:$|[^0-9])/u)?.[1];
}

async function assertEmptyDestination(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) occupied(`Destination ${path} is not a new directory`);
    const entries = await readdir(path);
    if (entries.length) occupied(`Destination ${path} is occupied; conversion refuses to overwrite existing entries`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof DshSessionImportError) throw error;
    throw error;
  }
}

function bootstrapValue() {
  const context = formatBootstrapContext(undefined);
  return { startupPending: true, context, compact: context };
}

function parseRelationshipRecord(value: unknown, line: number): CompanionStateRecord {
  if (!isRecord(value) || Object.keys(value).some((key) => !['at', 'changes', 'state'].includes(key))) invalid(`Companion state line ${line} has an invalid record`);
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) invalid(`Companion state line ${line} has an invalid timestamp`);
  if (!isRecord(value.state) || !isRecord(value.changes)) invalid(`Companion state line ${line} has invalid state or changes`);
  const rawState = value.state;
  if (Object.keys(rawState).some((key) => !['mood', 'note', 'affinity', 'signature'].includes(key))) invalid(`Companion state line ${line} has unknown state fields`);
  const mood = canonicalizeMood({ mood: rawState.mood, ...(rawState.note === undefined ? {} : { note: rawState.note }) });
  if (typeof rawState.affinity !== 'number' || !Number.isSafeInteger(rawState.affinity) || clampAffinity(rawState.affinity) !== rawState.affinity) invalid(`Companion state line ${line} has invalid affinity`);
  const state: CompanionState = { ...mood, affinity: rawState.affinity, signature: canonicalizeSignature(rawState.signature) };
  const rawChanges = value.changes;
  const keys = Object.keys(rawChanges);
  if (!keys.length || keys.some((key) => !['seed', 'mood', 'affinity', 'signature'].includes(key))) invalid(`Companion state line ${line} has invalid changes`);
  if (rawChanges.seed === true) {
    if (keys.length !== 1) invalid(`Companion state line ${line} mixes seed with changes`);
    return { at: value.at, changes: { seed: true }, state };
  }
  const changes: CompanionStateRecord['changes'] = {};
  if (rawChanges.mood !== undefined) {
    if (!isRecord(rawChanges.mood)) invalid(`Companion state line ${line} has invalid mood change`);
    const changed = canonicalizeMood({ mood: rawChanges.mood.value, ...(rawChanges.mood.note === undefined ? {} : { note: rawChanges.mood.note }) });
    if (changed.mood !== state.mood || changed.note !== state.note) invalid(`Companion state line ${line} mood change disagrees with state`);
    changes.mood = { value: changed.mood, ...(changed.note === undefined ? {} : { note: changed.note }), ...(rawChanges.mood.reason === undefined ? {} : { reason: canonicalizeChangeReason(rawChanges.mood.reason) }) };
  }
  if (rawChanges.affinity !== undefined) {
    if (!isRecord(rawChanges.affinity) || !Number.isSafeInteger(rawChanges.affinity.delta) || rawChanges.affinity.value !== state.affinity) invalid(`Companion state line ${line} has invalid affinity change`);
    changes.affinity = { delta: Number(rawChanges.affinity.delta), value: state.affinity, ...(rawChanges.affinity.reason === undefined ? {} : { reason: canonicalizeChangeReason(rawChanges.affinity.reason) }) };
  }
  if (rawChanges.signature !== undefined) {
    if (!isRecord(rawChanges.signature) || canonicalizeSignature(rawChanges.signature.value) !== state.signature) invalid(`Companion state line ${line} has invalid signature change`);
    changes.signature = { value: state.signature, ...(rawChanges.signature.reason === undefined ? {} : { reason: canonicalizeChangeReason(rawChanges.signature.reason) }) };
  }
  if (!Object.keys(changes).length) invalid(`Companion state line ${line} contains no supported change`);
  return { at: value.at, changes, state };
}

async function readRelationshipHistory(pathValue: string): Promise<CompanionStateRecord[]> {
  let source: string;
  try { source = await readFile(resolve(pathValue), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing(`Companion state does not exist: ${resolve(pathValue)}`); throw error; }
  if (!source || !source.endsWith('\n')) invalid('Companion state history must end with a complete newline-delimited record');
  const lines = source.slice(0, -1).split('\n');
  if (lines.some((line) => !line)) invalid('Companion state history contains an empty record');
  const records = lines.map((line, index) => {
    try { return parseRelationshipRecord(JSON.parse(line), index + 1); }
    catch (error) { if (error instanceof DshSessionImportError) throw error; invalid(`Companion state line ${index + 1} is invalid`, error); }
  });
  for (let index = 1; index < records.length; index += 1) {
    if (Date.parse(records[index]!.at) < Date.parse(records[index - 1]!.at)) invalid(`Companion state line ${index + 1} is not chronological`);
  }
  return records;
}

type ResolvedMedia = MediaReference & { sourcePath: string; destinationName: string; bytes: number; sha256: string };

type ImportedAvatar = { kind: 'companion' | 'user'; data: Buffer; mediaType: string; destinationPath: string };
const avatarMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function pathInside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function decodeAvatar(value: unknown, kind: ImportedAvatar['kind'], destinationPath: string): ImportedAvatar {
  if (!isRecord(value) || typeof value.data !== 'string' || typeof value.mediaType !== 'string') invalid(`DSH ${kind} avatar is invalid`);
  if (!avatarMediaTypes.has(value.mediaType)) invalid(`DSH ${kind} avatar has an unsupported media type`);
  const prefix = `data:${value.mediaType};base64,`;
  if (!value.data.startsWith(prefix)) invalid(`DSH ${kind} avatar data does not match its media type`);
  const encoded = value.data.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) invalid(`DSH ${kind} avatar is not valid base64`);
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.byteLength > 5 * 1024 * 1024) invalid(`DSH ${kind} avatar size is invalid`);
  return { kind, data, mediaType: value.mediaType, destinationPath };
}

async function readAvatars(config: Config, settingsPath: string | undefined, destination: string): Promise<ImportedAvatar[]> {
  if (!config.avatars && !settingsPath) return [];
  if (!config.avatars || !settingsPath) invalid('Avatar import requires both [avatars] paths and the DSH settings path');
  if (!pathInside(destination, config.avatars.companion) || !pathInside(destination, config.avatars.user)) {
    invalid('Avatar destinations must be inside the imported workspace');
  }
  let settings: unknown;
  try { settings = parseYaml(await readFile(resolve(settingsPath), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing(`DSH settings do not exist: ${resolve(settingsPath)}`); invalid('DSH settings YAML is invalid', error); }
  if (!isRecord(settings) || !isRecord(settings['dsh-companion'])) missing('DSH settings do not contain dsh-companion configuration');
  const companion = settings['dsh-companion'];
  return [
    decodeAvatar(companion.companionAvatar, 'companion', config.avatars.companion),
    decodeAvatar(companion.userAvatar, 'user', config.avatars.user),
  ];
}

async function resolveMedia(rootValue: string, references: readonly MediaReference[]): Promise<ResolvedMedia[]> {
  const root = resolve(rootValue);
  const result: ResolvedMedia[] = [];
  for (const reference of references) {
    const sha256 = reference.attachmentId.slice('sha256:'.length);
    const sourcePath = join(root, 'objects', sha256.slice(0, 2), sha256);
    let info;
    try { info = await stat(sourcePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing(`Referenced image is missing: ${reference.attachmentId}`); throw error; }
    if (!info.isFile()) missing(`Referenced image is not a regular file: ${reference.attachmentId}`);
    const data = await readFile(sourcePath);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== sha256) invalid(`Referenced image failed content hash verification: ${reference.attachmentId}`);
    const extension = reference.name.includes('.') ? `.${reference.name.split('.').pop()!.replace(/[^a-zA-Z0-9]/gu, '')}` : '';
    result.push({ ...reference, sourcePath, destinationName: `${sha256}${extension}`, bytes: data.byteLength, sha256 });
  }
  return result;
}

type RolloutLine = { timestamp: string; ordinal: number; type: string; payload: Record<string, unknown> };
type ImportedRollout = { lines: RolloutLine[]; boundaries: CompactBoundary[] };

function responseMessage(role: 'user' | 'assistant', value: string): Record<string, unknown> {
  return { type: 'message', id: `msg_${randomUUID().replaceAll('-', '')}`, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }], ...(role === 'assistant' ? { phase: 'final_answer' } : {}) };
}

function buildRollout(extraction: DshImportExtraction, media: readonly ResolvedMedia[], threadId: string, destination: string, persona: string, relationship: CompanionState, modelProvider = 'openai'): ImportedRollout {
  const created = new Date().toISOString();
  const initialWindow = randomUUID();
  const lines: RolloutLine[] = [];
  const boundaries: CompactBoundary[] = [];
  let precedingUserId: string | null = null;
  const mediaById = new Map(media.map((item) => [item.attachmentId, item]));
  const add = (type: string, payload: Record<string, unknown>, timestamp = created) => lines.push({ timestamp, ordinal: lines.length, type, payload });
  add('session_meta', {
    session_id: threadId, id: threadId, timestamp: created, cwd: destination, originator: 'codex_app_server_client_ts', cli_version: '0.154.0', source: 'vscode', model_provider: modelProvider,
    base_instructions: { text: `${companionPrompt}\n\n${persona}`, provenance: { type: 'custom' } }, history_mode: 'paginated', context_window: { window_id: initialWindow },
  });
  let window = initialWindow;
  let windowNumber = 0;
  const firstByTurn = new Map<number, number>();
  const lastByTurn = new Map<number, number>();
  extraction.records.forEach((record, index) => { if (record.type !== 'compact') { if (!firstByTurn.has(record.turn)) firstByTurn.set(record.turn, index); lastByTurn.set(record.turn, index); } });
  for (const [index, record] of extraction.records.entries()) {
    const timestamp = new Date(record.time).toISOString();
    if (record.type === 'compact') {
      const nextWindow = randomUUID();
      windowNumber += 1;
      const replacement = record.replacement.map((item) => responseMessage(item.role, item.text));
      add('compacted', { message: record.replacement[0]!.text, replacement_history: replacement, window_number: windowNumber, first_window_id: initialWindow, previous_window_id: window, window_id: nextWindow, compaction_response_id: null }, timestamp);
      const turnId = `compact-${record.compactionId}`;
      add('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(record.time / 1000), model_context_window: null, collaboration_mode_kind: 'default' }, timestamp);
      add('event_msg', { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'ContextCompaction', id: `compact-${randomUUID()}` }, started_at_ms: record.time, completed_at_ms: record.time }, timestamp);
      add('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null, completed_at: Math.floor(record.time / 1000) }, timestamp);
      boundaries.push({ id: `dsh:${record.compactionId}`, anchorId: precedingUserId, position: 'after', time: record.time });
      window = nextWindow;
      continue;
    }
    const turnId = `turn-${record.turn}`;
    if (firstByTurn.get(record.turn) === index) {
      add('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(record.time / 1000), model_context_window: null, collaboration_mode_kind: 'default' }, timestamp);
    }
    if (record.type === 'user') {
      const clientId = randomUUID();
      precedingUserId = clientId;
      const content: Record<string, unknown>[] = record.text ? [{ type: 'text', text: record.text, text_elements: [] }] : [];
      for (const reference of record.media) {
        const item = mediaById.get(reference.attachmentId);
        if (item) content.push({ type: 'local_image', path: join(destination, '.lamplit', 'historical-media', item.destinationName) });
      }
      add('event_msg', { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'UserMessage', id: `user-${randomUUID()}`, client_id: clientId, content }, started_at_ms: record.time, completed_at_ms: record.time }, timestamp);
      add('response_item', responseMessage('user', record.text), timestamp);
    } else {
      add('response_item', responseMessage('assistant', record.text), timestamp);
      add('event_msg', { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'AgentMessage', id: `agent-${randomUUID()}`, content: [{ type: 'Text', text: record.text }], phase: 'final_answer' }, started_at_ms: record.time, completed_at_ms: record.time }, timestamp);
    }
    if (lastByTurn.get(record.turn) === index) add('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: record.type === 'assistant' ? record.text : null, started_at: null, completed_at: Math.floor(record.time / 1000), duration_ms: null }, timestamp);
  }
  add('response_item', responseMessage('user', formatBootstrapContext(relationship)));
  return { lines, boundaries };
}

function rolloutPathFor(codexHome: string, threadId: string, date = new Date()): string {
  const iso = date.toISOString();
  const directory = join(codexHome, 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
  return join(directory, `rollout-${iso.slice(0, 19).replaceAll(':', '-')}-${threadId}.jsonl`);
}

/** Convert one stable DSH conversation into a fresh official Codex thread candidate. */
export async function convertDshSession(
  config: Config,
  inputPath: string,
  companionStatePath: string,
  attachmentRoot: string,
  destinationPath: string,
  dependencies: SessionImportDependencies = {},
  options: { dryRun?: boolean; dshSettingsPath?: string } = {},
): Promise<DshSessionImportResult> {
  const extraction = await inspectDshLog(inputPath);
  const relationships = await readRelationshipHistory(companionStatePath);
  const media = await resolveMedia(attachmentRoot, extraction.media);
  extraction.report.relationships = relationships.length;
  const destination = resolve(destinationPath);
  const avatars = await readAvatars(config, options.dshSettingsPath, destination);
  extraction.report.avatars = avatars.length;
  const existingDestination = await assertEmptyDestination(destination);
  const persona = await readFile(config.persona, 'utf8');
  if (!persona.trim()) throw new Error('Persona must not be empty');
  const codexHome = resolve(dependencies.appServer?.env?.CODEX_HOME ?? config.codex.home ?? '');
  if (!config.codex.home && !dependencies.appServer?.env?.CODEX_HOME) invalid('Session import requires an explicit test-owned or configured Codex home');
  const threadId = randomUUID();
  const rolloutPath = rolloutPathFor(codexHome, threadId);
  const currentRelationship = relationships.at(-1)?.state;
  if (!currentRelationship) invalid('Companion state history contains no current record');
  const rollout = buildRollout(extraction, media, threadId, destination, persona, currentRelationship);
  if (options.dryRun) {
    return {
      dryRun: true,
      report: extraction.report,
      destination: { path: destination, created: false },
      records: extraction.records,
    };
  }
  if (!existingDestination) await mkdir(destination, { recursive: true, mode: 0o700 });
  const markerPath = join(destination, '.lamplit', 'thread.json');
  const bootstrap = bootstrapPath(destination);
  let client: CodexAppServerClient | undefined;
  try {
    await writeBootstrapFile(bootstrap, {
      ...bootstrapValue(),
      startupPending: false,
      context: formatBootstrapContext(currentRelationship),
      compact: formatBootstrapContext(currentRelationship),
    });
    const paths = partnerPaths(destination);
    await mkdir(paths.managedRoot, { recursive: true, mode: 0o700 });
    for (const avatar of avatars) {
      await mkdir(dirname(avatar.destinationPath), { recursive: true, mode: 0o700 });
      await writeFile(avatar.destinationPath, avatar.data, { mode: 0o600, flag: 'wx' });
    }
    const store = new Store(paths.database);
    try {
      await replaceRelationshipJournal(paths.relationshipJournal, relationships);
      for (const boundary of rollout.boundaries) await store.saveCompactBoundary(boundary);
    } finally { await store.close(); }
    const mediaRoot = join(paths.managedRoot, 'historical-media');
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    for (const item of media) await copyFile(item.sourcePath, join(mediaRoot, item.destinationName));
    await writeFile(join(mediaRoot, 'manifest.json'), `${JSON.stringify(media.map((item) => ({ sourceAttachmentId: item.attachmentId, sourcePath: item.sourcePath, destinationPath: join('.lamplit', 'historical-media', item.destinationName), bytes: item.bytes, sha256: item.sha256 })), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await mkdir(resolve(rolloutPath, '..'), { recursive: true, mode: 0o700 });
    await writeFile(rolloutPath, `${rollout.lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    const injected = dependencies.appServer ?? {};
    const selectedCodexPath = injected.codexPath ?? config.codex.command;
    const environment = {
      ...(config.codex.home ? { CODEX_HOME: config.codex.home } : {}),
      ...(injected.env ?? {}),
    };
    const hook = await ensureHookDeclaration(destination, bootstrap);
    client = new CodexAppServerClient({
      appServerArgs: injected.appServerArgs,
      capabilities: { ...injected.capabilities, experimentalApi: true, requestAttestation: false },
      clientInfo: { ...injected.clientInfo, name: 'codex-for-love', title: 'Codex for Love', version: '0.1.0' },
      codexPath: selectedCodexPath,
      codexExecutableType: 'app-server',
      configOverrides: injected.configOverrides,
      cwd: destination,
      env: environment,
      protocolValidation: 'strict',
      requestTimeoutMs: injected.requestTimeoutMs ?? 60_000,
      stderrBufferLines: injected.stderrBufferLines,
    });
    const initialized = await client.connect();
    const actualVersion = versionFromUserAgent(initialized.userAgent);
    if (actualVersion !== config.codex.version) {
      throw new Error(`Unsupported Codex app-server version: expected ${config.codex.version}, received ${actualVersion ?? 'unknown'}`);
    }
    const capabilities = await client.call('modelProvider/capabilities/read', {});
    if (capabilities.imageGeneration !== true) {
      throw new Error('Official Codex app-server does not advertise native imageGeneration; the imported candidate would not be an ordinary CFL session');
    }
    await trustOwnedHooks(client, destination, hook.configPath, hook.command);
    const shared = {
      model: config.codex.model,
      cwd: destination,
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const,
      baseInstructions: `${companionPrompt}\n\n${persona}`,
      config: {
        'features.hooks': true,
        'features.image_generation': true,
        ...(config.codex.local_compaction
          ? { compact_prompt: compactionPrompt, experimental_local_compaction: true }
          : {}),
      },
    };
    const response = await client.call('thread/resume', {
      ...shared,
      threadId,
      path: rolloutPath,
      excludeTurns: true,
    } satisfies v2.ThreadResumeParams);
    const resumedThreadId = response.thread.id;
    if (!resumedThreadId) throw new Error('Codex app-server did not return an imported thread id');
    if (response.model !== undefined && response.model !== config.codex.model) throw new Error(`Codex selected ${String(response.model)} instead of configured ${config.codex.model}`);
    await writeFile(markerPath, JSON.stringify({ threadId: resumedThreadId, model: config.codex.model }), { mode: 0o600, flag: 'wx' });
    return {
      dryRun: false,
      report: extraction.report,
      destination: { path: destination, workspacePath: destination, rolloutPath, created: true, threadId: resumedThreadId },
    };
  } catch (error) {
    const candidate = { path: destination, workspacePath: destination, rolloutPath, provisionalThreadId: threadId };
    throw new DshSessionImportError(
      'candidate-created',
      `Session import candidate requires inspection: workspace=${destination}; rollout=${rolloutPath}; provisionalThreadId=${threadId}`,
      { cause: error },
      candidate,
    );
  } finally {
    await client?.close().catch(() => undefined);
  }
}
