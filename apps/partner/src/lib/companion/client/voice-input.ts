import {
  MAX_VOICE_DATA_URL_BYTES,
  MAX_VOICE_DURATION_MS,
  isVoiceAudioWithinDataUrlLimit,
  maxVoiceAudioBytesForMediaType,
  normalizeVoiceExpression,
  normalizeVoiceMediaType,
  type VoiceExpression,
} from "../voice-contract.ts";

export {
  MAX_VOICE_DATA_URL_BYTES,
  MAX_VOICE_DURATION_MS,
  VOICE_AUDIO_MEDIA_TYPES,
  isCanonicalBase64,
} from "../voice-contract.ts";
export type {
  VoiceAudioMediaType,
  VoiceExpression,
} from "../voice-contract.ts";

export const VOICE_TRANSCRIPT_MAX_CHARS = 20_000;

export type VoiceRecordingStatus =
  | "idle"
  | "recording"
  | "stopping"
  | "transcribing"
  | "unavailable";

export interface VoiceRecording {
  blob: Blob;
  mediaType: string;
  bytes: number;
  durationMs: number;
}

export interface CompanionVoiceTranscription {
  text: string;
  expression?: VoiceExpression;
}

export class VoiceRecordingError extends Error {
  readonly code:
    | "insecure-context"
    | "unsupported"
    | "permission-denied"
    | "capture-failed"
    | "cancelled"
    | "duration-limit"
    | "size-limit"
    | "empty"
    | "media-type"
    | "transcript-empty"
    | "transcript-invalid";

  constructor(code: VoiceRecordingError["code"], message?: string) {
    super(message ?? code);
    this.name = "VoiceRecordingError";
    this.code = code;
  }
}

interface MediaTrackLike {
  stop?: () => void;
}

interface MediaStreamLike {
  getTracks?: () => readonly MediaTrackLike[];
}

interface MediaRecorderEventLike {
  data?: Blob;
  error?: unknown;
}

interface MediaRecorderLike {
  readonly mimeType?: string;
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: MediaRecorderEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: MediaRecorderEventLike) => void) | null;
}

interface MediaRecorderConstructorLike {
  new (
    stream: MediaStreamLike,
    options?: { mimeType?: string },
  ): MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
}

interface MediaDevicesLike {
  getUserMedia(constraints: { audio: true }): Promise<MediaStreamLike>;
}

export interface VoiceCaptureEnvironment {
  mediaDevices?: MediaDevicesLike;
  mediaRecorder?: MediaRecorderConstructorLike;
  isSecureContext?: boolean;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface VoiceRecordingControllerOptions extends VoiceCaptureEnvironment {
  maxDurationMs?: number;
  maxBytes?: number;
  onStatus?: (status: VoiceRecordingStatus) => void;
  onError?: (error: VoiceRecordingError) => void;
}

function browserEnvironment(): VoiceCaptureEnvironment {
  const scope = globalThis as typeof globalThis & {
    MediaRecorder?: MediaRecorderConstructorLike;
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: MediaDevicesLike };
  };
  return {
    mediaDevices: scope.navigator?.mediaDevices,
    mediaRecorder: scope.MediaRecorder,
    ...(typeof scope.isSecureContext === "boolean"
      ? { isSecureContext: scope.isSecureContext }
      : {}),
  };
}

function activeTimer(
  options: VoiceCaptureEnvironment,
): NonNullable<VoiceCaptureEnvironment["setTimeout"]> {
  return options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
}

function clearActiveTimer(
  options: VoiceCaptureEnvironment,
  timer: ReturnType<typeof setTimeout> | undefined,
): void {
  if (timer !== undefined)
    (options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis))(timer);
}

function stopTracks(stream: MediaStreamLike | undefined): void {
  try {
    for (const track of stream?.getTracks?.() ?? []) track.stop?.();
  } catch {
    // A browser may invalidate a stream while a permission prompt is closing.
  }
}

function secureCaptureAvailable(options: VoiceCaptureEnvironment): boolean {
  return (
    options.isSecureContext !== false &&
    typeof options.mediaDevices?.getUserMedia === "function" &&
    Boolean(options.mediaRecorder)
  );
}

/** Whether this browser can request and record a microphone stream. */
export function canCaptureVoice(
  options: VoiceCaptureEnvironment = browserEnvironment(),
): boolean {
  return secureCaptureAvailable(options);
}

/** Pick the first provider-compatible MIME type advertised by MediaRecorder. */
export function selectVoiceMimeType(
  recorder: MediaRecorderConstructorLike | undefined = browserEnvironment()
    .mediaRecorder,
): string | undefined {
  if (!recorder) return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
  ];
  for (const candidate of candidates) {
    try {
      if (!recorder.isTypeSupported || recorder.isTypeSupported(candidate)) {
        if (normalizeVoiceMediaType(candidate)) return candidate;
      }
    } catch {
      // Treat a throwing browser capability probe as unsupported.
    }
  }
  return undefined;
}

/** Validate the emitted Blob's actual media type and complete Data URL bound. */
export function validateVoiceRecording(
  blob: Blob,
  declaredMediaType?: string,
  maxBytes?: number,
): VoiceRecording {
  if (!(blob instanceof Blob))
    throw new VoiceRecordingError("empty", "录音内容无效。");
  const mediaType = normalizeVoiceMediaType(blob.type || declaredMediaType);
  if (!mediaType)
    throw new VoiceRecordingError(
      "media-type",
      "浏览器生成了不支持的录音格式。",
    );
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0)
    throw new VoiceRecordingError("empty", "没有录到声音，请再试一次。");
  const dataUrlMaxBytes = maxVoiceAudioBytesForMediaType(mediaType);
  const effectiveMaxBytes =
    dataUrlMaxBytes === undefined
      ? 0
      : maxBytes === undefined
        ? dataUrlMaxBytes
        : Math.min(dataUrlMaxBytes, maxBytes);
  if (
    blob.size > effectiveMaxBytes ||
    !isVoiceAudioWithinDataUrlLimit(mediaType, blob.size)
  ) {
    throw new VoiceRecordingError("size-limit", "录音超过语音大小限制。");
  }
  return { blob, mediaType, bytes: blob.size, durationMs: 0 };
}

/** Convert an admitted Blob to canonical Base64 without persisting it. */
export async function voiceBlobToBase64(
  blob: Blob,
  declaredMediaType?: string,
): Promise<string> {
  const mediaType = normalizeVoiceMediaType(blob.type || declaredMediaType);
  if (!mediaType)
    throw new VoiceRecordingError(
      "media-type",
      "浏览器生成了不支持的录音格式。",
    );
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0)
    throw new VoiceRecordingError("empty", "没有录到声音，请再试一次。");
  if (!isVoiceAudioWithinDataUrlLimit(mediaType, blob.size))
    throw new VoiceRecordingError("size-limit", "录音超过语音大小限制。");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0)
    throw new VoiceRecordingError("empty", "没有录到声音，请再试一次。");
  if (!isVoiceAudioWithinDataUrlLimit(mediaType, bytes.byteLength))
    throw new VoiceRecordingError("size-limit", "录音超过语音大小限制。");
  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(value: Uint8Array): { toString(encoding: string): string };
      };
    }
  ).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");
  let output = "";
  // Keep chunks divisible by three so concatenated Base64 remains canonical.
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(bytes.length, offset + chunkSize),
    );
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    output += btoa(binary);
  }
  return output;
}

function expressionFromRaw(value: unknown): VoiceExpression | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const expression = expressionFromRaw(item);
      if (expression) return expression;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return normalizeVoiceExpression(
      record.expression ??
        record.speechExpression ??
        record.speech_expression ??
        record.emotion,
    );
  }
  return normalizeVoiceExpression(value);
}

/** Keep only the provider-neutral text and first recognized expression label. */
export function normalizeVoiceTranscription(
  raw: unknown,
): CompanionVoiceTranscription {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new VoiceRecordingError("transcript-invalid", "语音转写结果无效。");
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text)
    throw new VoiceRecordingError(
      "transcript-empty",
      "没有听清内容，请再试一次。",
    );
  if (Array.from(text).length > VOICE_TRANSCRIPT_MAX_CHARS)
    throw new VoiceRecordingError("transcript-invalid", "语音转写内容过长。");
  let expression: VoiceExpression | undefined;
  for (const candidate of [
    record.expression,
    record.speechExpression,
    record.speech_expression,
    record.sentences,
    record.expressions,
  ]) {
    expression = expressionFromRaw(candidate);
    if (expression) break;
  }
  return expression ? { text, expression } : { text };
}

/** The one ordinary text turn emitted for a successful voice transcription. */
export function formatVoiceTurn(
  transcription: CompanionVoiceTranscription,
): string {
  const normalized = normalizeVoiceTranscription(transcription);
  return normalized.expression
    ? `🎙️ ${normalized.text} [${normalized.expression}]`
    : `🎙️ ${normalized.text}`;
}

interface ActiveRecording {
  generation: number;
  mediaType: string;
  maxBytes: number;
  stream?: MediaStreamLike;
  recorder?: MediaRecorderLike;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  stopReason?: "user" | "duration-limit" | "size-limit" | "cancelled";
  completion: Promise<VoiceRecording>;
  resolve: (recording: VoiceRecording) => void;
  reject: (error: unknown) => void;
}

/**
 * Browser recording state machine. It owns the stream, recorder, timer, and
 * all cleanup; transcription remains an injected caller concern.
 */
export class VoiceRecordingController {
  private readonly options: VoiceRecordingControllerOptions;
  private readonly maxDurationMs: number;
  private readonly configuredMaxBytes: number;
  private statusValue: VoiceRecordingStatus = "idle";
  private operation?: ActiveRecording;
  private generation = 0;
  private disposed = false;

  constructor(options: VoiceRecordingControllerOptions = {}) {
    this.options = { ...browserEnvironment(), ...options };
    this.maxDurationMs =
      Number.isFinite(options.maxDurationMs) && (options.maxDurationMs ?? 0) > 0
        ? options.maxDurationMs!
        : MAX_VOICE_DURATION_MS;
    this.configuredMaxBytes =
      Number.isSafeInteger(options.maxBytes) && (options.maxBytes ?? 0) > 0
        ? options.maxBytes!
        : MAX_VOICE_DATA_URL_BYTES;
  }

  get status(): VoiceRecordingStatus {
    return this.statusValue;
  }
  get busy(): boolean {
    return (
      this.statusValue === "recording" ||
      this.statusValue === "stopping" ||
      this.statusValue === "transcribing"
    );
  }
  get elapsedMs(): number {
    const active = this.operation;
    if (!active) return 0;
    return Math.max(0, (this.options.now ?? Date.now)() - active.startedAt);
  }

  private setStatus(next: VoiceRecordingStatus): void {
    this.statusValue = next;
    try {
      this.options.onStatus?.(next);
    } catch {
      /* UI observers must not break recorder cleanup. */
    }
  }

  async start(): Promise<boolean> {
    if (this.disposed || this.busy) return false;
    if (!secureCaptureAvailable(this.options)) {
      this.setStatus("unavailable");
      throw new VoiceRecordingError(
        this.options.isSecureContext === false
          ? "insecure-context"
          : "unsupported",
        "当前环境不支持麦克风录音。",
      );
    }
    const mimeType = selectVoiceMimeType(this.options.mediaRecorder);
    if (!mimeType) {
      this.setStatus("unavailable");
      throw new VoiceRecordingError(
        "unsupported",
        "当前浏览器没有可用的录音格式。",
      );
    }
    const declaredMediaType = normalizeVoiceMediaType(mimeType);
    const dataUrlMaxBytes =
      declaredMediaType === undefined
        ? undefined
        : maxVoiceAudioBytesForMediaType(declaredMediaType);
    const maxBytes =
      dataUrlMaxBytes === undefined
        ? 0
        : Math.min(this.configuredMaxBytes, dataUrlMaxBytes);
    if (maxBytes <= 0) {
      this.setStatus("unavailable");
      throw new VoiceRecordingError(
        "unsupported",
        "当前浏览器没有可用的录音格式。",
      );
    }
    const generation = ++this.generation;
    let resolve!: (recording: VoiceRecording) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<VoiceRecording>(
      (resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
      },
    );
    // `start()` resolves when the recorder is ready; a caller may never ask
    // for the stop result, so prevent an expected capture failure from being
    // reported as an unhandled rejection.
    void completion.catch(() => undefined);
    const active: ActiveRecording = {
      generation,
      mediaType: declaredMediaType!,
      maxBytes,
      chunks: [],
      bytes: 0,
      startedAt: 0,
      completion,
      resolve,
      reject,
    };
    this.operation = active;
    this.setStatus("recording");
    try {
      active.stream = await this.options.mediaDevices!.getUserMedia({
        audio: true,
      });
      if (
        this.disposed ||
        this.operation !== active ||
        generation !== this.generation
      ) {
        stopTracks(active.stream);
        throw new VoiceRecordingError("cancelled", "录音已取消。");
      }
      const Recorder = this.options.mediaRecorder!;
      active.recorder = new Recorder(active.stream, { mimeType });
      active.recorder.ondataavailable = (event) =>
        this.onData(active, event.data);
      active.recorder.onerror = (event) =>
        this.fail(
          active,
          new VoiceRecordingError(
            "capture-failed",
            event.error instanceof Error
              ? event.error.message
              : "录音失败，请重试。",
          ),
        );
      active.recorder.onstop = () => this.finish(active);
      active.recorder.start(1000);
      active.startedAt = (this.options.now ?? Date.now)();
      active.timer = activeTimer(this.options)(
        () => this.requestStop(active, "duration-limit"),
        this.maxDurationMs,
      );
      return true;
    } catch (error) {
      const errorName =
        error instanceof Error
          ? error.name
          : typeof error === "object" &&
              error !== null &&
              "name" in error &&
              typeof (error as { name?: unknown }).name === "string"
            ? (error as { name: string }).name
            : "";
      const failure =
        error instanceof VoiceRecordingError
          ? error
          : errorName === "NotAllowedError" ||
              errorName === "PermissionDeniedError"
            ? new VoiceRecordingError(
                "permission-denied",
                "麦克风权限被拒绝，请允许后重试。",
              )
            : new VoiceRecordingError(
                "capture-failed",
                "无法开始录音，请重试。",
              );
      this.fail(active, failure);
      throw failure;
    }
  }

  async stop(): Promise<VoiceRecording | undefined> {
    return this.stopAndGet();
  }

  /** Stop and return the completed recording, if any. */
  async stopAndGet(): Promise<VoiceRecording | undefined> {
    const active = this.operation;
    if (!active) return undefined;
    if (this.statusValue === "stopping") return active.completion;
    if (this.statusValue === "recording") this.setStatus("stopping");
    active.stopReason ??= "user";
    if (!active.recorder) {
      this.fail(active, new VoiceRecordingError("cancelled", "录音已取消。"));
    } else {
      try {
        active.recorder.stop();
      } catch {
        this.fail(
          active,
          new VoiceRecordingError("capture-failed", "录音失败，请重试。"),
        );
      }
    }
    return active.completion;
  }

  markTranscribing(): boolean {
    if (
      this.disposed ||
      this.operation ||
      this.statusValue === "recording" ||
      this.statusValue === "stopping"
    )
      return false;
    this.setStatus("transcribing");
    return true;
  }

  finishTranscribing(): void {
    if (this.statusValue === "transcribing") this.setStatus("idle");
  }

  async cancel(): Promise<void> {
    const active = this.operation;
    if (!active) {
      if (this.statusValue === "transcribing") this.setStatus("idle");
      return;
    }
    active.stopReason = "cancelled";
    if (this.statusValue === "recording") this.setStatus("stopping");
    if (active.recorder) {
      try {
        active.recorder.stop();
      } catch {
        this.fail(active, new VoiceRecordingError("cancelled", "录音已取消。"));
      }
    } else {
      this.fail(active, new VoiceRecordingError("cancelled", "录音已取消。"));
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.cancel();
    this.setStatus("idle");
  }

  private requestStop(
    active: ActiveRecording,
    reason: "duration-limit" | "size-limit",
  ): void {
    if (this.operation !== active || active.stopReason) return;
    active.stopReason = reason;
    if (this.statusValue === "recording") this.setStatus("stopping");
    try {
      active.recorder?.stop();
    } catch {
      this.fail(
        active,
        new VoiceRecordingError("capture-failed", "录音失败，请重试。"),
      );
    }
  }

  private onData(active: ActiveRecording, chunk: Blob | undefined): void {
    if (this.operation !== active || !chunk || chunk.size <= 0) return;
    const emittedMediaType = normalizeVoiceMediaType(chunk.type);
    const emittedMaxBytes =
      emittedMediaType === undefined
        ? undefined
        : maxVoiceAudioBytesForMediaType(emittedMediaType);
    if (emittedMaxBytes !== undefined)
      active.maxBytes = Math.min(active.maxBytes, emittedMaxBytes);
    active.bytes += chunk.size;
    active.chunks.push(chunk);
    if (active.bytes > active.maxBytes) this.requestStop(active, "size-limit");
  }

  private finish(active: ActiveRecording): void {
    if (this.operation !== active) return;
    const reason = active.stopReason;
    if (reason === "cancelled") {
      this.fail(active, new VoiceRecordingError("cancelled", "录音已取消。"));
      return;
    }
    if (reason === "duration-limit") {
      this.fail(
        active,
        new VoiceRecordingError("duration-limit", "录音最长 5 分钟，已停止。"),
      );
      return;
    }
    if (reason === "size-limit" || active.bytes > active.maxBytes) {
      this.fail(
        active,
        new VoiceRecordingError("size-limit", "录音超过语音大小限制，已停止。"),
      );
      return;
    }
    try {
      const emittedMediaType =
        active.chunks.find((chunk) => chunk.type)?.type ||
        active.recorder?.mimeType ||
        active.mediaType;
      const blob = new Blob(active.chunks, { type: emittedMediaType ?? "" });
      const admitted = validateVoiceRecording(
        blob,
        emittedMediaType,
        active.maxBytes,
      );
      this.complete(active, {
        ...admitted,
        durationMs: Math.max(
          0,
          (this.options.now ?? Date.now)() - active.startedAt,
        ),
      });
    } catch (error) {
      this.fail(active, error);
    }
  }

  private complete(active: ActiveRecording, recording: VoiceRecording): void {
    if (this.operation !== active) return;
    clearActiveTimer(this.options, active.timer);
    stopTracks(active.stream);
    this.operation = undefined;
    this.setStatus("idle");
    active.resolve(recording);
  }

  private fail(active: ActiveRecording, error: unknown): void {
    if (this.operation !== active) return;
    const failure =
      error instanceof VoiceRecordingError
        ? error
        : new VoiceRecordingError("capture-failed", "录音失败，请重试。");
    clearActiveTimer(this.options, active.timer);
    stopTracks(active.stream);
    this.operation = undefined;
    this.setStatus("idle");
    try {
      this.options.onError?.(failure);
    } catch {
      /* UI observers must not break the rejected capture promise. */
    }
    active.reject(failure);
  }
}
