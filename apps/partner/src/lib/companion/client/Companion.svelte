<script lang="ts">
  import { MAX_MESSAGE_LENGTH } from "../../message-input.ts";
  import { formatVoiceTurn } from "./voice-input.js";
  import {
    english,
    type CompanionLocaleKey,
    type CompanionMessage,
    type CompanionTranslate,
  } from "./locale.js";
  export let t: CompanionTranslate = english;
  export let locale = "en";
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { Camera, CameraErrorCode } from "@capacitor/camera";
  import ImagePlus from "lucide-svelte/icons/image-plus";
  import Menu from "lucide-svelte/icons/menu";
  import Settings from "lucide-svelte/icons/settings";
  import Pause from "lucide-svelte/icons/pause";
  import Play from "lucide-svelte/icons/play";
  import Square from "lucide-svelte/icons/square";
  import Mic from "lucide-svelte/icons/mic";
  import X from "lucide-svelte/icons/x";
  import {
    COMPACTION_STATUS_DURATION_MS,
    formatTokenCount,
    resolveContextCapacity,
    type CompactionLifecycleState,
  } from "../continuity.js";
  import type {
    CompanionProjection,
    TimelineImage,
    TimelineItem,
    TimelineMessageUnit,
    TimelineNotice,
    TimelineText,
    TimelineVoice,
  } from "../projection.js";
  import type {
    CompanionContinuityView,
    CompanionRecoveredDraft,
    CompanionHistoryView,
    KeetLossRange,
  } from "./companion-bridge.js";
  import type { PendingSubmissionRetirement } from "./contracts.js";
  import { CompanionPreControllerError } from "./admission.js";
  import {
    COMPOSER_MAX_HEIGHT,
    COMPOSER_MIN_HEIGHT,
    createComposerState,
    findComposerCommand,
    reduceComposer,
    resolveComposerHeight,
    shouldSubmitEnter,
    type ComposerCommand,
  } from "./composer.js";
  import {
    createImageDrafts,
    imageFileFromCapturedMedia,
    imageFilesFromClipboard,
    imageIntakeError,
    IMAGE_ACCEPT,
    releaseImageDrafts,
    type CompanionImageDraft,
  } from "./image-drafts.js";
  import type { CompanionReadiness } from "./readiness.js";
  import type { CompanionAppearance, CompanionLanguage } from "./preferences.js";
  import { keetRecoveryNotice } from "./keet-recovery.js";
  import { companionHistoryChanges } from "../relationship-history.js";
  import type { CompanionHistoryChange } from "../domain.js";
  import Markdown from "./Markdown.svelte";
  import { resolveImageDisplaySize } from "../media.js";
  import {
    canCaptureVoice,
    VoiceRecordingController,
    VoiceRecordingError,
    type CompanionVoiceTranscription,
    type VoiceRecording,
    type VoiceRecordingStatus,
  } from "./voice-input.js";

  interface CompanionIdentityView {
    companionName: string;
    companionAvatar?: string;
    userName: string;
    userAvatar?: string;
    preferredAddress: string;
    signature: string;
    moodLabel: string;
    mood: string;
    moodNote?: string;
    affinity?: number;
    affinityStage?: string;
  }
  interface CompanionActions {
    send: (
      text: string,
      images: readonly CompanionImageDraft[],
      onRetire?: (retirement: PendingSubmissionRetirement) => void,
    ) => Promise<void>;
    stop?: () => Promise<void>;
    loadOlder?: () => Promise<void>;
    attachmentUrl?: (attachment: unknown) => Promise<string>;
    transcribeVoice?: (
      recording: VoiceRecording,
      signal?: AbortSignal,
    ) => Promise<CompanionVoiceTranscription>;
    loadEarlierHistory?: () => Promise<void>;
    retryHistory?: () => void;
  }


  export let projection: CompanionProjection = {
    items: [],
    messageUnits: [],
    pendingCount: 0,
    running: false,
    status: "ready",
    openState: "open",
    hasMore: false,
    loadingOlder: false,
  };
  export let identity: CompanionIdentityView = {
    companionName: "Companion",
    userName: t("you"),
    preferredAddress: t("you"),
    signature: "",
    moodLabel: t("mood.neutral"),
    mood: "neutral",
    affinity: 50,
    affinityStage: t("affinity.familiar"),
  };
  export let actions: CompanionActions = { send: async () => undefined };
  export let workspaceReadiness: CompanionReadiness = "loading";
  export let sessionReadiness: CompanionReadiness = "loading";
  export let relationshipReadiness: CompanionReadiness = "loading";
  export let sessionId: string | undefined;
  export let imageLimits:
    | import("./contracts.js").ImageAttachmentLimits
    | undefined;
  export let voiceCapability: "loading" | "available" | "unavailable" =
    "unavailable";
  export let continuity: CompanionContinuityView = {};
  export let keetLosses: readonly KeetLossRange[] = [];
  export let recoveredDraft: CompanionRecoveredDraft | undefined;
  export let history: CompanionHistoryView = {
    status: "loading",
    records: [],
    hasEarlier: false,
  };
  export let onHistoryOpenChange: ((open: boolean) => void) | undefined;
  export let appearance: CompanionAppearance = "system";
  export let onAppearanceChange: (appearance: CompanionAppearance) => void = () => undefined;
  export let onLanguageChange: (language: CompanionLanguage) => void = () => undefined;

  const dispatch = createEventDispatcher<{ advanced: void; recovery: void }>();
  const LONG_WAIT_DELAY_MS = 12_000;
  const LONG_WAIT_ROTATION_MS = 9_000;
  const PHOTO_LONG_PRESS_MS = 450;
  const VOICE_WAVEFORM_BAR_COUNT = 28;
  const EMPTY_VOICE_PLAYBACK = { current: 0, duration: 0, playing: false };
  const IMAGE_TILE_SIZE = 64;
  const IMAGE_MAX_LONG_EDGE = 240;
  const LONG_WAIT_MESSAGES = [
    "wait.thinking",
    "wait.words",
    "wait.soon",
    "wait.care",
    "wait.here",
  ] as const;
  let composer = createComposerState();
  let composerInput: HTMLTextAreaElement;
  let photoLibraryInput: HTMLInputElement;
  let commandSuggestion: ComposerCommand | undefined;
  let stopping = false;
  let timeline: HTMLDivElement;
  let timelineReady = false;
  let timelineRevealFrame = 0;
  let detailOpen = false;
  let preferencesOpen = false;
  let preferencesButton: HTMLButtonElement;
  let drawerTab: "history" | "diary" = "history";
  let diaryEntries: string[] = [];
  let diaryEntry: { name: string; text: string } | undefined;
  let diaryLoading = false;
  let diaryError = false;
  let diaryTooLarge = false;
  let diaryRequest: AbortController | undefined;
  interface ImagePreviewTarget {
    id: string;
    alt: string;
    previewUrl?: string;
  }
  interface ImagePart {
    kind: "images";
    items: TimelineImage[];
  }
  interface ContentPart {
    kind: "item";
    item: TimelineText | TimelineImage | TimelineVoice;
  }
  type MessageContentPart = ImagePart | ContentPart;
  let lightbox: ImagePreviewTarget | undefined;
  let lightboxUrl = "";
  let voiceUrls: Record<string, string> = {};
  let voiceErrors: Record<string, boolean> = {};
  let voicePlayback: Record<
    string,
    { current: number; duration: number; playing: boolean }
  > = {};
  let imageUrls: Record<string, string> = {};
  let imageErrors: Record<string, boolean> = {};
  let imageSources: Record<string, string> = {};
  let imageLoads: Record<string, string> = {};
  let imageDimensions: Record<string, { width: number; height: number }> = {};
  let wasNearBottom = true;
  let liveAnnouncement: string | CompanionMessage = "";
  let detailReturnFocus: HTMLElement | undefined;
  let lightboxReturnFocus: HTMLElement | undefined;
  let relationshipDrawer: HTMLElement;
  let lightboxDialog: HTMLDialogElement;
  let overlayHistory = false;
  let lightboxCloseFromHistory = false;
  let statusText = "";
  let imageGenerationRunning = false;
  let typingVisible = false;
  let waitingCopy: CompanionLocaleKey | "" = "";
  let waitingCycle = "";
  let waitingDelayTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingRotationTimer: ReturnType<typeof setInterval> | undefined;
  let contextMeterOpen = false;
  let contextMeterButton: HTMLButtonElement;
  let contextMeterPopover: HTMLElement;
  let contextMeterReturnFocus: HTMLElement | undefined;
  let continuityStatus: CompactionLifecycleState | undefined;
  let continuityStatusKey = "";
  let continuityStatusTimer: ReturnType<typeof setTimeout> | undefined;
  let imageDrafts: CompanionImageDraft[] = [];
  let imageDraftSessionId: string | undefined;
  let recoveredDraftKey = "";
  let recoveredDraftToken = 0;
  let deferredPreviewReleases: CompanionImageDraft[] = [];
  let deferredImageUrls = new Set<string>();
  let displayedProjection: CompanionProjection = projection;
  let submissionToken = 0;
  let imagePickerPointer: { id: number; startedAt: number } | undefined;
  let suppressImagePickerClick = false;
  let composerResizeToken = 0;
  let voiceStatus: VoiceRecordingStatus = "idle";
  const voiceCaptureAvailable = canCaptureVoice();
  let voiceElapsedMs = 0;
  let voiceClock: ReturnType<typeof setInterval> | undefined;
  let voiceFailure: CompanionLocaleKey | "" = "";
  let voiceController = new VoiceRecordingController({
    onStatus: (status) => {
      voiceStatus = status;
    },
    onError: (error) => {
      clearVoiceClock();
      voiceElapsedMs = 0;
      if (error.code !== "cancelled") {
        voiceFailure = voiceErrorKey(error);
        liveAnnouncement = { key: voiceFailure };
      }
    },
  });
  let voiceSessionId: string | undefined;
  let voiceTranscriptionAbort: AbortController | undefined;

  $: keetRecovery = keetRecoveryNotice(keetLosses, t);

  $: effectiveWorkspaceReadiness = workspaceReadiness;
  $: effectiveSessionReadiness = sessionReadiness;
  $: effectiveRelationshipReadiness = relationshipReadiness;
  $: if (
    detailOpen &&
    (effectiveWorkspaceReadiness !== "ready" ||
      effectiveRelationshipReadiness !== "ready")
  )
    finishDetailClose(false);
  $: statusText = projection.status === "offline"
    ? t("status.offline")
    : projection.status === "working" ? t("status.typing") : t("status.online");
  $: imageGenerationRunning = projection.items.some(
    (item) =>
      item.kind === "image" &&
      (item.state === "running" || item.state === "loading"),
  );
  $: typingVisible = projection.running && !imageGenerationRunning;
  $: commandSuggestion = imageDrafts.length
    ? undefined
    : findComposerCommand(composer.draft, t);
  $: contextCapacity = resolveContextCapacity(continuity?.contextPressure);
  $: latestContinuityLifecycle = latestLifecycle(continuity?.lifecycle);
  $: syncContinuityStatus(latestContinuityLifecycle);
  $: if (!contextCapacity && contextMeterOpen) closeContextMeter(false);
  $: syncWaitingState(
    typingVisible,
    `${sessionId ?? "none"}:${latestSettledReplyKey(projection)}`,
  );
  $: displayedProjection = projection;
  $: if (displayedProjection) void reconcileProjection(displayedProjection);
  $: if (sessionId !== imageDraftSessionId) {
    releaseSubmissionImages(imageDrafts);
    imageDrafts = [];
    imageDraftSessionId = sessionId;
    recoveredDraftKey = "";
    recoveredDraftToken += 1;
    composer = createComposerState();
    submissionToken += 1;
    void scheduleComposerResize();
  }
  $: if (sessionId !== voiceSessionId) {
    voiceSessionId = sessionId;
    void cancelVoiceInput();
  }
  $: if (
    recoveredDraft &&
    recoveredDraft.key !== recoveredDraftKey &&
    sessionId === imageDraftSessionId
  )
    void restoreRecoveredDraft(recoveredDraft);

  async function scheduleComposerResize(): Promise<void> {
    const token = ++composerResizeToken;
    await tick();
    if (token !== composerResizeToken || !composerInput) return;
    // Reset before measuring so deletion and rejected-send restoration shrink
    // just as reliably as typing grows the draft.
    composerInput.style.height = "auto";
    const resolved = resolveComposerHeight(
      composerInput.scrollHeight,
      COMPOSER_MIN_HEIGHT,
      COMPOSER_MAX_HEIGHT,
    );
    composerInput.style.height = `${resolved.height}px`;
    composerInput.style.overflowY = resolved.scrollable ? "auto" : "hidden";
  }

  async function restoreRecoveredDraft(draft: CompanionRecoveredDraft): Promise<void> {
    const token = ++recoveredDraftToken;
    recoveredDraftKey = draft.key;
    if (sessionId !== imageDraftSessionId) return;
    const existingText = composer.draft.trim();
    composer = {
      ...composer,
      draft: existingText ? `${draft.input}\n${composer.draft}` : draft.input,
      composing: false,
    };
    const files: File[] = [];
    for (const image of draft.images) {
      try {
        const response = await fetch(image.url);
        if (!response.ok) continue;
        const blob = await response.blob();
        files.push(new File([blob], image.name, { type: blob.type || "image/png" }));
      } catch {
        // The text remains editable even if an attachment cannot be restored.
      }
    }
    if (token !== recoveredDraftToken || sessionId !== imageDraftSessionId) return;
    if (files.length) imageDrafts = [...imageDrafts, ...createImageDrafts(files)];
    void scheduleComposerResize();
    liveAnnouncement = { key: "error.restored" };
  }

  function messageContentParts(
    unit: TimelineMessageUnit,
  ): MessageContentPart[] {
    const content = unit.items.filter(
      (item): item is TimelineText | TimelineImage | TimelineVoice =>
        item.kind === "text" || item.kind === "image" || item.kind === "voice",
    );
    if (unit.side === "outgoing") {
      const images = content.filter(
        (item): item is TimelineImage => item.kind === "image",
      );
      const rest = content.filter((item) => item.kind !== "image");
      return [
        ...(images.length ? [{ kind: "images" as const, items: images }] : []),
        ...rest.map((item) => ({ kind: "item" as const, item })),
      ];
    }
    const parts: MessageContentPart[] = [];
    for (const item of content) {
      if (item.kind === "image") {
        const previous = parts.at(-1);
        if (previous?.kind === "images") previous.items.push(item);
        else parts.push({ kind: "images", items: [item] });
      } else parts.push({ kind: "item", item });
    }
    return parts;
  }

  function imageHasKnownDimensions(item: TimelineImage): boolean {
    const width = item.attachment?.width;
    const height = item.attachment?.height;
    return (
      typeof width === "number" &&
      width > 0 &&
      typeof height === "number" &&
      height > 0
    );
  }

  function imageStyle(item: TimelineImage, tiled: boolean): string {
    if (tiled) return `width:${IMAGE_TILE_SIZE}px;height:${IMAGE_TILE_SIZE}px`;
    const dimensions = imageDimensions[item.id];
    const width = dimensions?.width ?? item.attachment?.width;
    const height = dimensions?.height ?? item.attachment?.height;
    if (!imageHasKnownDimensions(item) && !dimensions)
      return "max-width:100%;max-height:240px;width:auto;height:auto";
    const size = resolveImageDisplaySize(width, height, IMAGE_MAX_LONG_EDGE);
    return `width:${size.width}px;height:${size.height}px;object-fit:${size.cropped ? "cover" : "contain"}`;
  }

  function onImageLoaded(item: TimelineImage, event: Event): void {
    if (imageHasKnownDimensions(item)) return;
    const image = event.currentTarget as HTMLImageElement;
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const current = imageDimensions[item.id];
    if (
      current?.width === image.naturalWidth &&
      current.height === image.naturalHeight
    )
      return;
    imageDimensions = {
      ...imageDimensions,
      [item.id]: { width: image.naturalWidth, height: image.naturalHeight },
    };
  }

  function unitTestId(unit: TimelineMessageUnit): string {
    const voice = unit.items.find(
      (item): item is TimelineVoice => item.kind === "voice",
    );
    return voice ? `voice-${voice.id}` : `message-${unit.id}`;
  }

  function messengerRecoveryMessage(
    value: string,
    operation?: string,
  ): string | CompanionMessage {
    if (operation === "stop") return { key: "error.stop" };
    if (operation === "send") return { key: "error.send" };
    return value;
  }

  function noticeText(item: TimelineNotice, t: CompanionTranslate): string {
    if (item.id === "prompt-error")
      return t(
        projection.promptErrorOp === "stop" ? "error.stop" : "error.send",
      );
    return item.text;
  }

  function releaseDeferredPreviewReleases(): void {
    const drafts = deferredPreviewReleases;
    deferredPreviewReleases = [];
    if (drafts.length) releaseImageDrafts(drafts);
    if (deferredImageUrls.size) {
      for (const url of deferredImageUrls)
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      deferredImageUrls.clear();
    }
  }

  function releaseSubmissionImages(
    images: readonly CompanionImageDraft[],
  ): void {
    const protectedPreview =
      lightboxUrl && lightbox?.previewUrl === lightboxUrl
        ? lightboxUrl
        : undefined;
    const deferred = protectedPreview
      ? images.filter((draft) => draft.previewUrl === protectedPreview)
      : [];
    const releasable = deferred.length
      ? images.filter((draft) => draft.previewUrl !== protectedPreview)
      : images;
    if (deferred.length) {
      const known = new Set(
        deferredPreviewReleases.map((draft) => draft.previewUrl),
      );
      deferredPreviewReleases = [
        ...deferredPreviewReleases,
        ...deferred.filter((draft) => !known.has(draft.previewUrl)),
      ];
    }
    if (releasable.length)
      void tick().then(() => releaseImageDrafts(releasable));
  }

  function latestSettledReplyKey(value: CompanionProjection): string {
    for (let index = value.items.length - 1; index >= 0; index -= 1) {
      const item = value.items[index]!;
      if (
        item.side === "incoming" &&
        (item.kind !== "image" ||
          item.state === "ready" ||
          item.state === "failed")
      )
        return ("projectionKey" in item ? item.projectionKey : undefined) ?? item.id;
    }
    return "empty";
  }

  function retireSubmission(
    images: readonly CompanionImageDraft[],
    retirement: PendingSubmissionRetirement,
    restoreText: string,
    originSessionId: string | undefined,
  ): void {
    if (retirement.reason === "observed") {
      releaseSubmissionImages(images);
      return;
    }
    if (sessionId === originSessionId && sessionId === imageDraftSessionId) {
      composer = {
        ...composer,
        draft: composer.draft
          ? `${restoreText}\n${composer.draft}`
          : restoreText,
        composing: false,
      };
      imageDrafts = [...imageDrafts, ...images];
      void scheduleComposerResize();
      liveAnnouncement = { key: "error.restored" };
      return;
    }
    // A rejection from a Session that is no longer selected cannot be
    // restored into the current composer; release its page-owned previews.
    releaseSubmissionImages(images);
  }

  function clearWaitingTimers(): void {
    if (waitingDelayTimer !== undefined) clearTimeout(waitingDelayTimer);
    if (waitingRotationTimer !== undefined) clearInterval(waitingRotationTimer);
    waitingDelayTimer = undefined;
    waitingRotationTimer = undefined;
  }

  function latestLifecycle(
    value: CompanionContinuityView["lifecycle"],
  ): CompactionLifecycleState | undefined {
    const rows = value?.lifecycles ?? (value?.latest ? [value.latest] : []);
    return [...rows]
      .sort(
        (left, right) =>
          (left.endSeq ?? left.startSeq) - (right.endSeq ?? right.startSeq) ||
          left.startSeq - right.startSeq,
      )
      .at(-1);
  }

  function clearContinuityStatusTimer(): void {
    if (continuityStatusTimer !== undefined)
      clearTimeout(continuityStatusTimer);
    continuityStatusTimer = undefined;
  }

  function syncContinuityStatus(
    lifecycle: CompactionLifecycleState | undefined,
  ): void {
    const key = lifecycle
      ? `${lifecycle.compactionId}:${lifecycle.status}:${lifecycle.endSeq ?? ""}:${lifecycle.endedAt ?? ""}`
      : "";
    if (key === continuityStatusKey) return;
    clearContinuityStatusTimer();
    continuityStatusKey = key;
    continuityStatus = undefined;
    if (!lifecycle) return;
    if (lifecycle.status === "running") {
      continuityStatus = lifecycle;
      return;
    }
    const endedAt =
      typeof lifecycle.endedAt === "number" &&
      Number.isFinite(lifecycle.endedAt)
        ? lifecycle.endedAt
        : Date.now();
    const remaining = endedAt + COMPACTION_STATUS_DURATION_MS - Date.now();
    if (remaining <= 0) return;
    continuityStatus = lifecycle;
    continuityStatusTimer = setTimeout(() => {
      continuityStatus = undefined;
      continuityStatusKey = key;
      continuityStatusTimer = undefined;
    }, remaining);
  }

  function openContextMeter(): void {
    if (!contextCapacity) return;
    contextMeterReturnFocus = document.activeElement as HTMLElement;
    contextMeterOpen = true;
    void tick().then(() => contextMeterPopover?.focus());
  }

  function closeContextMeter(restoreFocus = true): void {
    contextMeterOpen = false;
    const target = contextMeterReturnFocus;
    contextMeterReturnFocus = undefined;
    if (restoreFocus) target?.focus();
  }

  function toggleContextMeter(): void {
    if (contextMeterOpen) closeContextMeter();
    else openContextMeter();
  }

  function onWindowPointerDown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (contextMeterOpen && (!target || !(target as Element).closest?.(".companion-context-meter-wrap"))) closeContextMeter(false);
    if (preferencesOpen && (!target || !(target as Element).closest?.(".companion-preferences"))) preferencesOpen = false;
  }

  function rotateWaitingCopy(): void {
    const choices = LONG_WAIT_MESSAGES.filter(
      (message) => message !== waitingCopy,
    );
    waitingCopy =
      choices[Math.floor(Math.random() * choices.length)] ??
      LONG_WAIT_MESSAGES[0];
  }

  function syncWaitingState(running: boolean, replyKey: string): void {
    const nextCycle = running ? replyKey : "";
    if (nextCycle === waitingCycle) return;
    waitingCycle = nextCycle;
    clearWaitingTimers();
    waitingCopy = "";
    if (!running) return;
    waitingDelayTimer = setTimeout(() => {
      rotateWaitingCopy();
      waitingRotationTimer = setInterval(
        rotateWaitingCopy,
        LONG_WAIT_ROTATION_MS,
      );
    }, LONG_WAIT_DELAY_MS);
  }

  async function reconcileProjection(
    value: CompanionProjection,
  ): Promise<void> {
    await tick();
    if (!timeline) return;
    if (value.openState !== "open") {
      if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
      timelineRevealFrame = 0;
      timelineReady = false;
      return;
    }
    const distance =
      timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
    const nearBottom = wasNearBottom || distance < 96;
    if (nearBottom && !value.loadingOlder)
      timeline.scrollTop = timeline.scrollHeight;
    if (!timelineReady) {
      if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
      timelineRevealFrame = requestAnimationFrame(() => {
        if (!timeline) return;
        timeline.scrollTop = timeline.scrollHeight;
        timelineReady = true;
        timelineRevealFrame = 0;
      });
    }
    wasNearBottom = nearBottom;
    liveAnnouncement = value.promptError
      ? messengerRecoveryMessage(value.promptError, value.promptErrorOp)
      : (value.lastAgentError ?? "");
    const wantedImages = new Map<string, TimelineImage>();
    for (const item of value.items)
      if (item.kind === "image" && item.state === "ready" && item.attachment)
        wantedImages.set(item.id, item);
    for (const [id, url] of Object.entries(imageUrls)) {
      const item = wantedImages.get(id);
      if (!item || imageSources[id] !== imageSource(item)) revokeImage(id, url);
    }
    for (const item of wantedImages.values()) {
      const source = imageSource(item);
      if (
        !imageUrls[item.id] &&
        imageLoads[item.id] !== source &&
        actions.attachmentUrl
      )
        void loadImage(item, source);
    }
    for (const item of value.items)
      if (item.kind === "voice" && voiceUrls[item.id] !== item.url)
        voiceUrls = { ...voiceUrls, [item.id]: item.url };
  }

  function imageSource(item: TimelineImage): string {
    return `${item.attachment?.attachmentId ?? ""}:${item.attachment?.mediaType ?? ""}`;
  }
  function releaseImageUrl(url: string | undefined): void {
    if (!url?.startsWith("blob:")) return;
    if (url === lightboxUrl) {
      deferredImageUrls.add(url);
      return;
    }
    URL.revokeObjectURL(url);
  }
  function revokeImage(id: string, url = imageUrls[id]): void {
    releaseImageUrl(url);
    const urls = { ...imageUrls };
    const sources = { ...imageSources };
    const errors = { ...imageErrors };
    delete urls[id];
    delete sources[id];
    delete errors[id];
    imageUrls = urls;
    imageSources = sources;
    imageErrors = errors;
    const dimensions = { ...imageDimensions };
    delete dimensions[id];
    imageDimensions = dimensions;
  }
  async function loadImage(item: TimelineImage, source: string): Promise<void> {
    if (!actions.attachmentUrl || imageLoads[item.id] === source) return;
    imageLoads = { ...imageLoads, [item.id]: source };
    try {
      const url = await actions.attachmentUrl(item.attachment);
      const live = displayedProjection.items.find(
        (candidate) => candidate.kind === "image" && candidate.id === item.id,
      ) as TimelineImage | undefined;
      if (live && imageSource(live) === source) {
        if (imageUrls[item.id] && imageUrls[item.id] !== url)
          revokeImage(item.id);
        imageUrls = { ...imageUrls, [item.id]: url };
        imageSources = { ...imageSources, [item.id]: source };
        if (lightbox?.id === item.id) {
          const previous = lightboxUrl;
          lightboxUrl = url;
          if (previous && previous !== url) {
            deferredImageUrls.delete(previous);
            releaseImageUrl(previous);
          }
        }
      } else if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    } catch {
      const live = displayedProjection.items.find(
        (candidate) => candidate.kind === "image" && candidate.id === item.id,
      ) as TimelineImage | undefined;
      if (live && imageSource(live) === source)
        imageErrors = { ...imageErrors, [item.id]: true };
    } finally {
      const loads = { ...imageLoads };
      delete loads[item.id];
      imageLoads = loads;
    }
  }

  function retryImage(item: TimelineImage): void {
    if (!actions.attachmentUrl || !item.attachment) return;
    const errors = { ...imageErrors };
    delete errors[item.id];
    imageErrors = errors;
    const loads = { ...imageLoads };
    delete loads[item.id];
    imageLoads = loads;
    void loadImage(item, imageSource(item));
  }

  function updateVoicePlayback(
    id: string,
    patch: Partial<{ current: number; duration: number; playing: boolean }>,
  ): void {
    voicePlayback = {
      ...voicePlayback,
      [id]: {
        ...(voicePlayback[id] ?? EMPTY_VOICE_PLAYBACK),
        ...patch,
      },
    };
  }

  function voiceState(id: string): {
    current: number;
    duration: number;
    playing: boolean;
  } {
    return voicePlayback[id] ?? EMPTY_VOICE_PLAYBACK;
  }

  function formatVoiceSeconds(
    value: number,
    rounding: "floor" | "ceil" = "floor",
  ): string {
    if (!Number.isFinite(value) || value <= 0) return "0:00";
    const seconds = rounding === "ceil" ? Math.ceil(value) : Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function hasVoiceDuration(state: { duration: number }): boolean {
    return state.duration > 0;
  }
  function voiceTimestamp(state: {
    current: number;
    duration: number;
  }): string | undefined {
    if (state.duration <= 0) return undefined;
    return state.current > 0 && state.current < state.duration
      ? formatVoiceSeconds(state.current)
      : formatVoiceSeconds(state.duration, "ceil");
  }

  function voiceProgress(state: { current: number; duration: number }): number {
    return state.duration > 0
      ? Math.min(1, Math.max(0, state.current / state.duration))
      : 0;
  }

  function voiceWaveform(id: string): number[] {
    let seed = 2166136261;
    for (const character of id)
      seed = Math.imul(seed ^ character.codePointAt(0)!, 16777619);
    return Array.from({ length: VOICE_WAVEFORM_BAR_COUNT }, (_, index) => {
      seed = Math.imul(seed ^ index, 2246822519);
      return 28 + (Math.abs(seed) % 69);
    });
  }

  function audioFor(control: Element): HTMLAudioElement | undefined {
    return (
      control
        .closest(".companion-voice")
        ?.querySelector<HTMLAudioElement>("audio") ?? undefined
    );
  }

  function trackVoiceAudio(
    node: HTMLAudioElement,
    id: string,
  ): { destroy(): void } {
    const loaded = (event: Event) => onVoiceLoaded(id, event);
    const time = (event: Event) => onVoiceTime(id, event);
    const play = () => onVoicePlay(id);
    const pause = () => onVoicePause(id);
    const ended = (event: Event) => onVoiceEnded(id, event);
    const error = () => failVoice(id);
    node.addEventListener("loadedmetadata", loaded);
    node.addEventListener("timeupdate", time);
    node.addEventListener("play", play);
    node.addEventListener("pause", pause);
    node.addEventListener("ended", ended);
    node.addEventListener("error", error);
    return {
      destroy() {
        node.removeEventListener("loadedmetadata", loaded);
        node.removeEventListener("timeupdate", time);
        node.removeEventListener("play", play);
        node.removeEventListener("pause", pause);
        node.removeEventListener("ended", ended);
        node.removeEventListener("error", error);
      },
    };
  }

  function failVoice(id: string): void {
    const nextUrls = { ...voiceUrls };
    delete nextUrls[id];
    voiceUrls = nextUrls;
    voiceErrors = {
      ...voiceErrors,
      [id]: true,
    };
  }

  async function toggleVoice(
    item: TimelineVoice,
    control: Element,
  ): Promise<void> {
    if (!voiceUrls[item.id]) {
      voiceUrls = { ...voiceUrls, [item.id]: item.url };
      await tick();
    }
    const audio = audioFor(control);
    if (!audio) return;
    for (const other of document.querySelectorAll<HTMLAudioElement>(
      "#dsh-companion .companion-voice audio",
    ))
      if (other !== audio && !other.paused) other.pause();
    try {
      if (audio.ended) audio.currentTime = 0;
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch {
      failVoice(item.id);
    }
  }

  function seekVoice(event: Event, id: string): void {
    const audio = audioFor(event.currentTarget as Element);
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!audio || !Number.isFinite(value)) return;
    audio.currentTime = value;
    updateVoicePlayback(id, { current: value });
  }

  function onVoicePlay(id: string): void {
    updateVoicePlayback(id, { playing: true });
  }
  function onVoicePause(id: string): void {
    updateVoicePlayback(id, { playing: false });
  }
  function onVoiceEnded(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : voiceState(id).duration;
    updateVoicePlayback(id, { current: duration, duration, playing: false });
  }
  function onVoiceLoaded(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      failVoice(id);
      return;
    }
    updateVoicePlayback(id, {
      duration: audio.duration,
      current: audio.currentTime,
    });
  }
  function onVoiceTime(id: string, event: Event): void {
    const audio = event.target as HTMLAudioElement;
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : voiceState(id).duration;
    updateVoicePlayback(id, { current: audio.currentTime, duration });
  }

  function onScroll(): void {
    if (!timeline) return;
    wasNearBottom =
      timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 96;
  }

  function keepBottomOnResize(node: HTMLElement): { destroy(): void } {
    const observer = new ResizeObserver(() => {
      if (timelineReady && wasNearBottom && timeline)
        timeline.scrollTop = timeline.scrollHeight;
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  function submit(): void {
    if (projection.canSubmit === false) return;
    const restoreText = composer.draft;
    const text = restoreText.trim();
    if (text.length > MAX_MESSAGE_LENGTH) return;
    if ((!text && imageDrafts.length === 0) || composer.composing) return;
    const submittedDrafts = [...imageDrafts];
    const originSessionId = sessionId;
    composer = {
      ...reduceComposer(composer, { type: "submit" }),
      draft: "",
      composing: false,
    };
    imageDrafts = [];
    void scheduleComposerResize();
    const token = ++submissionToken;
    const onRetire = (retirement: PendingSubmissionRetirement): void => {
      retireSubmission(
        submittedDrafts,
        retirement,
        restoreText,
        originSessionId,
      );
    };
    void Promise.resolve()
      .then(() => actions.send(text, submittedDrafts, onRetire))
      .catch((error: unknown) => {
        // Once beginSubmission() succeeds, the Session controller is the only
        // owner that retires its echo and restores a rejected draft. The only
        // local restoration path is an explicitly marked caller failure before
        // that controller boundary (for example no bound Session or /compact).
        if (
          error instanceof CompanionPreControllerError &&
          token === submissionToken &&
          sessionId === originSessionId
        ) {
          composer = {
            ...composer,
            draft: composer.draft
              ? `${restoreText}\n${composer.draft}`
              : restoreText,
            composing: false,
          };
          imageDrafts = [...imageDrafts, ...submittedDrafts];
          void scheduleComposerResize();
        }
        liveAnnouncement =
          error instanceof Error && error.message === "compact-with-images"
            ? { key: "error.compactImages" }
            : { key: "error.restored" };
      });
  }

  function formatVoiceElapsed(value: number): string {
    const seconds = Math.max(0, Math.floor(value / 1000));
    const minutes = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
  }

  function voiceErrorKey(error: unknown): CompanionLocaleKey {
    if (error instanceof VoiceRecordingError) {
      if (error.code === "insecure-context") return "voice.secure";
      if (error.code === "unsupported" || error.code === "media-type")
        return "voice.unsupported";
      if (error.code === "permission-denied") return "voice.permission";
      if (error.code === "duration-limit") return "voice.duration";
      if (error.code === "size-limit") return "voice.size";
      if (error.code === "empty") return "voice.empty";
      if (error.code === "transcript-empty") return "voice.unclear";
    }
    return "voice.failed";
  }

  function voiceUnavailableText(t: CompanionTranslate): string {
    return voiceCaptureAvailable ? t("voice.install") : t("voice.unavailable");
  }

  function clearVoiceClock(): void {
    if (voiceClock !== undefined) clearInterval(voiceClock);
    voiceClock = undefined;
  }

  async function cancelVoiceInput(): Promise<void> {
    clearVoiceClock();
    voiceTranscriptionAbort?.abort();
    voiceTranscriptionAbort = undefined;
    try {
      await voiceController.cancel();
    } catch {
      /* cleanup is best effort; the controller stops every known track */
    }
    voiceElapsedMs = 0;
    voiceFailure = "";
  }

  async function stopVoiceAndTranscribe(): Promise<void> {
    clearVoiceClock();
    let recording: VoiceRecording | undefined;
    try {
      recording = await voiceController.stopAndGet();
    } catch (error) {
      voiceFailure = voiceErrorKey(error);
      liveAnnouncement = { key: voiceFailure };
      voiceElapsedMs = 0;
      return;
    }
    voiceElapsedMs = 0;
    voiceFailure = "";
    if (
      !recording ||
      !actions.transcribeVoice ||
      !voiceController.markTranscribing()
    )
      return;
    const abort = new AbortController();
    const originSessionId = sessionId;
    voiceTranscriptionAbort = abort;
    try {
      const transcription = await actions.transcribeVoice(
        recording,
        abort.signal,
      );
      if (abort.signal.aborted || sessionId !== originSessionId) return;
      const text = formatVoiceTurn(transcription);
      await actions.send(text, []);
      liveAnnouncement = { key: "voice.sent" };
    } catch (error) {
      voiceFailure = voiceErrorKey(error);
      liveAnnouncement = { key: voiceFailure };
    } finally {
      if (voiceTranscriptionAbort === abort)
        voiceTranscriptionAbort = undefined;
      voiceController.finishTranscribing();
    }
  }

  async function toggleVoiceInput(): Promise<void> {
    if (projection.canSubmit === false && voiceStatus !== "recording" && voiceStatus !== "stopping") return;
    if (voiceStatus === "recording" || voiceStatus === "stopping") {
      if (voiceStatus === "recording") await stopVoiceAndTranscribe();
      return;
    }
    if (voiceStatus === "transcribing") return;
    if (voiceCapability === "loading") {
      liveAnnouncement = { key: "voice.wait" };
      return;
    }
    if (
      voiceCapability !== "available" ||
      !actions.transcribeVoice ||
      !voiceCaptureAvailable
    ) {
      liveAnnouncement = {
        key: voiceCaptureAvailable ? "voice.install" : "voice.unavailable",
      };
      return;
    }
    voiceElapsedMs = 0;
    voiceFailure = "";
    clearVoiceClock();
    try {
      await voiceController.start();
      voiceClock = setInterval(() => {
        voiceElapsedMs = voiceController.elapsedMs;
      }, 250);
    } catch (error) {
      clearVoiceClock();
      voiceFailure = voiceErrorKey(error);
      liveAnnouncement = { key: voiceFailure };
    }
  }

  async function stop(): Promise<void> {
    if (!actions.stop || stopping) return;
    stopping = true;
    try {
      await actions.stop();
    } catch {
      liveAnnouncement = { key: "error.stop" };
    } finally {
      stopping = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (
      commandSuggestion &&
      (event.key === "Tab" || event.key === "Enter") &&
      !event.shiftKey &&
      !event.isComposing &&
      !composer.composing
    ) {
      event.preventDefault();
      acceptCommandSuggestion();
      return;
    }
    if (shouldSubmitEnter(event, composer.composing)) {
      event.preventDefault();
      submit();
    }
  }

  function setDraft(value: string): void {
    composer = reduceComposer(composer, { type: "input", value });
    void scheduleComposerResize();
  }
  function acceptCommandSuggestion(): void {
    if (!commandSuggestion) return;
    setDraft(commandSuggestion.command);
    void tick().then(() => composerInput?.focus());
  }
  function onInput(event: Event): void {
    setDraft((event.currentTarget as HTMLTextAreaElement).value);
  }
  function onCompositionEnd(event: CompositionEvent): void {
    composer = reduceComposer(composer, {
      type: "compositionend",
      value: (event.currentTarget as HTMLTextAreaElement).value,
    });
    void scheduleComposerResize();
  }
  function onCompositionStart(): void {
    composer = reduceComposer(composer, { type: "compositionstart" });
  }
  function addImages(files: readonly File[]): void {
    const error = imageIntakeError(imageDrafts, files, imageLimits);
    if (error) {
      liveAnnouncement = error;
      return;
    }
    imageDrafts = [...imageDrafts, ...createImageDrafts(files)];
  }
  function onImageInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    addImages(Array.from(input.files ?? []));
    input.value = "";
  }
  function onPaste(event: ClipboardEvent): void {
    const images = imageFilesFromClipboard(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    addImages(images);
  }

  function isCameraCancellation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code =
      "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== undefined) return code === CameraErrorCode.TakePhotoCancelled;
    const message =
      "message" in error ? (error as { message?: unknown }).message : undefined;
    return (
      typeof message === "string" &&
      /(?:user\s+)?cancel(?:led|ed)\s+photos\s+app|取消(?:了)?拍照/iu.test(
        message,
      )
    );
  }

  async function capturePhoto(): Promise<void> {
    try {
      const result = await Camera.takePhoto({
        saveToGallery: false,
        includeMetadata: true,
      });
      addImages([await imageFileFromCapturedMedia(result)]);
    } catch (error) {
      if (!isCameraCancellation(error))
        liveAnnouncement = { key: "camera.failed" };
    }
  }

  function removeImage(draft: CompanionImageDraft): void {
    releaseSubmissionImages([draft]);
    imageDrafts = imageDrafts.filter((candidate) => candidate !== draft);
  }
  function onImagePickerPointerDown(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;
    imagePickerPointer = { id: event.pointerId, startedAt: Date.now() };
  }
  function onImagePickerPointerUp(event: PointerEvent): void {
    if (!imagePickerPointer || imagePickerPointer.id !== event.pointerId)
      return;
    const held =
      Date.now() - imagePickerPointer.startedAt >= PHOTO_LONG_PRESS_MS;
    imagePickerPointer = undefined;
    if (!held) return;
    suppressImagePickerClick = true;
    event.preventDefault();
    void capturePhoto();
  }
  function clearImagePickerPointer(): void {
    imagePickerPointer = undefined;
  }
  function choosePhoto(): void {
    if (suppressImagePickerClick) {
      suppressImagePickerClick = false;
      return;
    }
    photoLibraryInput?.click();
  }
  function formatHistoryDate(value: string, locale: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return date.toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  function historyDimensionLabel(
    dimension: CompanionHistoryChange["dimension"],
  ): string {
    switch (dimension) {
      case "mood":
        return t("history.mood");
      case "affinity":
        return t("history.affinity");
      case "signature":
        return t("history.signature");
    }
  }
  function historyValueLabel(
    dimension: CompanionHistoryChange["dimension"],
    value: CompanionHistoryChange["after"],
  ): string {
    if (dimension === "mood") {
      const label = t(
        `mood.${value.value as CompanionLocaleKey}` as CompanionLocaleKey,
      );
      return "note" in value && value.note ? `${label} · ${value.note}` : label;
    }
    if (dimension === "affinity") return String(value.value);
    return value.value ? String(value.value) : t("signature.empty");
  }
  function changesForHistoryRecord(index: number): CompanionHistoryChange[] {
    const record = history.records[index];
    if (!record) return [];
    const predecessor =
      history.records[index + 1] ??
      (index === history.records.length - 1 ? history.predecessor : undefined);
    return companionHistoryChanges(record, predecessor);
  }
  async function loadEarlierHistory(): Promise<void> {
    if (!actions.loadEarlierHistory) return;
    try {
      await actions.loadEarlierHistory();
    } catch {
      // The bridge keeps the error state; avoid an unhandled event-handler
      // rejection while leaving the retry action available in the drawer.
    }
  }
  function focusFirst(dialog: () => HTMLElement | undefined): void {
    void tick().then(() => {
      const target = dialog();
      (
        target?.querySelector<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ) ?? target
      )?.focus();
    });
  }
  function trapFocus(event: KeyboardEvent, dialog: HTMLElement): void {
    if (event.key !== "Tab") return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((node) => !node.hasAttribute("hidden"));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  function closeHistory(): void {
    if (overlayHistory) {
      overlayHistory = false;
      globalThis.history.back();
    }
  }
  function openDetail(): void {
    detailReturnFocus = document.activeElement as HTMLElement;
    detailOpen = true;
    onHistoryOpenChange?.(true);
    void tick().then(() => {
      focusFirst(() => relationshipDrawer);
    });
  }
  function finishDetailClose(restoreFocus = true): void {
    detailOpen = false;
    onHistoryOpenChange?.(false);
    const target = detailReturnFocus;
    detailReturnFocus = undefined;
    if (restoreFocus) target?.focus();
  }
  function closeDetail(restoreFocus = true): void {
    diaryRequest?.abort();
    diaryRequest = undefined;
    finishDetailClose(restoreFocus);
  }
  function openLightbox(item: ImagePreviewTarget): void {
    lightboxReturnFocus = document.activeElement as HTMLElement;
    lightbox = item;
    lightboxUrl = item.previewUrl ?? imageUrls[item.id] ?? "";
    void tick().then(() => {
      if (lightboxDialog && !lightboxDialog.open) lightboxDialog.showModal();
      focusFirst(() => lightboxDialog);
    });
  }
  function finishLightboxClose(fromHistory: boolean): void {
    const target = lightboxReturnFocus;
    const hadHistory = overlayHistory;
    lightbox = undefined;
    lightboxUrl = "";
    lightboxReturnFocus = undefined;
    releaseDeferredPreviewReleases();
    if (target) target.focus();
    if (!fromHistory && hadHistory) closeHistory();
  }
  function closeLightbox(fromHistory = false): void {
    if (!lightbox) return;
    lightboxCloseFromHistory = fromHistory;
    if (lightboxDialog?.open) {
      lightboxDialog.close();
      return;
    }
    finishLightboxClose(fromHistory);
  }
  function onLightboxClose(): void {
    const fromHistory = lightboxCloseFromHistory;
    lightboxCloseFromHistory = false;
    finishLightboxClose(fromHistory);
  }
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (preferencesOpen) { event.preventDefault(); preferencesOpen = false; preferencesButton?.focus(); return; }
      if (contextMeterOpen) {
        event.preventDefault();
        closeContextMeter();
        return;
      }
      if (detailOpen) {
        event.preventDefault();
        closeDetail();
        return;
      }
      return;
    }
    if (detailOpen && relationshipDrawer) {
      trapFocus(event, relationshipDrawer);
      return;
    }
    if (lightbox && lightboxDialog) trapFocus(event, lightboxDialog);
  }
  function onPopState(): void {
    overlayHistory = false;
    if (lightbox) closeLightbox(true);
  }
  function pushOverlayHistory(): void {
    if (!overlayHistory) {
      globalThis.history.pushState({ companionOverlay: true }, "");
      overlayHistory = true;
    }
  }
  function toggleDetail(): void {
    if (detailOpen) closeDetail();
    else openDetail();
  }
  function showLightbox(item: TimelineImage): void {
    pushOverlayHistory();
    openLightbox({
      id: item.id,
      alt: item.alt || t("image.preview"),
      previewUrl: item.previewUrl ?? imageUrls[item.id],
    });
  }
  function showDraftLightbox(draft: CompanionImageDraft): void {
    pushOverlayHistory();
    openLightbox({
      id: `draft:${draft.id}`,
      alt: draft.file.name || t("image.pending"),
      previewUrl: draft.previewUrl,
    });
  }
  async function loadOlder(): Promise<void> {
    if (!actions.loadOlder || projection.loadingOlder) return;
    const previousHeight = timeline?.scrollHeight ?? 0;
    await actions.loadOlder();
    await tick();
    if (timeline) timeline.scrollTop += timeline.scrollHeight - previousHeight;
  }
  function beginDiaryRequest(): AbortController {
    diaryRequest?.abort();
    const request = new AbortController();
    diaryRequest = request;
    diaryLoading = true;
    diaryError = false;
    diaryTooLarge = false;
    return request;
  }
  async function openDiary(): Promise<void> {
    drawerTab = "diary";
    diaryEntry = undefined;
    const request = beginDiaryRequest();
    try {
      const response = await fetch("/api/diary", { signal: request.signal });
      if (!response.ok) throw new Error();
      if (diaryRequest === request)
        diaryEntries = (await response.json() as { entries: string[] }).entries;
    } catch (error) {
      if (diaryRequest === request && (error as Error).name !== "AbortError")
        diaryError = true;
    } finally {
      if (diaryRequest === request) diaryLoading = false;
    }
  }
  async function openDiaryEntry(name: string): Promise<void> {
    const request = beginDiaryRequest();
    try {
      const response = await fetch(`/api/diary/${encodeURIComponent(name)}`, {
        signal: request.signal,
      });
      if (response.status === 413) {
        if (diaryRequest === request) diaryTooLarge = true;
        return;
      }
      if (!response.ok) throw new Error();
      if (diaryRequest === request) diaryEntry = await response.json();
    } catch (error) {
      if (diaryRequest === request && (error as Error).name !== "AbortError")
        diaryError = true;
    } finally {
      if (diaryRequest === request) diaryLoading = false;
    }
  }

  onMount(() => {
    void scheduleComposerResize();

  });

  onDestroy(() => {
    if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
    releaseDeferredPreviewReleases();
    releaseSubmissionImages(imageDrafts);
    clearWaitingTimers();
    clearContinuityStatusTimer();
    clearVoiceClock();
    voiceTranscriptionAbort?.abort();
    diaryRequest?.abort();
    voiceTranscriptionAbort = undefined;
    voiceController.dispose();
    for (const audio of document.querySelectorAll<HTMLAudioElement>(
      "#dsh-companion .companion-voice audio",
    ))
      audio.pause();
    for (const url of Object.values(imageUrls)) releaseImageUrl(url);
    releaseDeferredPreviewReleases();
  });
</script>

<svelte:window
  on:keydown={onWindowKeydown}
  on:pointerdown={onWindowPointerDown}
  on:popstate={onPopState}
/>

<div
  id="dsh-companion"
  class="companion-shell"
  data-testid="companion-root"
>
  <div class="companion-app">
    <div class="companion-content">
      <main class="companion-main" aria-label={t("chat.label")}>
        <header class="companion-header">
          <div>
            <button
              type="button"
              class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-history-toggle"
              aria-label={t("relationship.view")}
              aria-controls="companion-relationship-drawer"
              aria-expanded={detailOpen}
              on:click={toggleDetail}
              ><Menu
                size={18}
                strokeWidth={1.8}
                aria-hidden="true"
              /></button
            >
          </div>
          <div class="companion-avatar-anchor" aria-hidden="true">
            <div class="cmp-avatar cmp-avatar-placeholder companion-avatar">
              <div class="companion-avatar-crop cmp-mask cmp-mask-circle">
                {#if identity.companionAvatar}<img
                    src={identity.companionAvatar}
                    alt=""
                  />{:else}<span aria-hidden="true">✦</span>{/if}
              </div>
            </div>
          </div>
          <div class="companion-header-copy">
            <div class="companion-name">{identity.companionName}</div>
            <div class="companion-presence" aria-live="polite">
              <span
                class="cmp-status {projection.status === 'offline'
                  ? 'cmp-status-error'
                  : projection.status === 'working'
                  ? 'cmp-status-warning'
                  : 'cmp-status-success'}"
              ></span>{statusText} · {identity.moodLabel}
            </div>
          </div>
          <div class="companion-preferences">
            <button bind:this={preferencesButton} type="button" class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-preferences-trigger" aria-label={t("preferences.open")} aria-controls="companion-preferences-panel" aria-expanded={preferencesOpen} on:click={() => preferencesOpen = !preferencesOpen}><Settings size={18} strokeWidth={1.8} aria-hidden="true" /></button>
            {#if preferencesOpen}
              <section id="companion-preferences-panel" class="companion-preferences-panel" aria-label={t("preferences.open")}>
                <fieldset><legend>{t("preferences.theme")}</legend>
                  {#each [["light", "preferences.light"], ["dark", "preferences.dark"], ["system", "preferences.system"]] as option}
                    <label><input class="cmp-radio cmp-radio-primary" type="radio" name="companion-appearance" checked={appearance === option[0]} on:change={() => onAppearanceChange(option[0] as CompanionAppearance)} /><span>{t(option[1] as CompanionLocaleKey)}</span></label>
                  {/each}
                </fieldset>
                <fieldset><legend>{t("preferences.language")}</legend>
                  {#each [["zh", "中文"], ["en", "English"]] as option}
                    <label><input class="cmp-radio cmp-radio-primary" type="radio" name="companion-language" checked={locale === option[0]} on:change={() => onLanguageChange(option[0] as CompanionLanguage)} /><span>{option[1]}</span></label>
                  {/each}
                </fieldset>
              </section>
            {/if}
          </div>

        </header>

        {#if effectiveWorkspaceReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <span
              class="cmp-loading cmp-loading-spinner cmp-loading-sm"
              aria-hidden="true"
            ></span><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveWorkspaceReadiness === "missing"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb cmp-mask cmp-mask-circle"
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.empty")}</h1>
            <p>{t("workspace.chooseHint")}</p>
            <a
              class="cmp-btn cmp-btn-primary"
              href="/"
              aria-label={t("workspace.settingsLabel")}
              on:click={() => dispatch("recovery")}>{t("settings.open")}</a
            >
          </section>
        {:else if effectiveWorkspaceReadiness === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb cmp-mask cmp-mask-circle"
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.failed")}</h1>
            <p>{t("workspace.reconnectHint")}</p>
            <button
              class="cmp-btn cmp-btn-primary"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else if effectiveRelationshipReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <span
              class="cmp-loading cmp-loading-spinner cmp-loading-sm"
              aria-hidden="true"
            ></span><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveRelationshipReadiness === "missing"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb cmp-mask cmp-mask-circle"
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.empty")}</h1>
            <p>{t("workspace.chooseHint")}</p>
            <a
              class="cmp-btn cmp-btn-primary"
              href="/"
              aria-label={t("workspace.settingsLabel")}
              on:click={() => dispatch("recovery")}>{t("settings.open")}</a
            >
          </section>
        {:else if effectiveRelationshipReadiness === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb cmp-mask cmp-mask-circle"
              aria-hidden="true"
            ></div>
            <h1>{t("relationship.failed")}</h1>
            <p>{t("relationship.reconnectHint")}</p>
            <button
              class="cmp-btn cmp-btn-primary"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else if effectiveSessionReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <span
              class="cmp-loading cmp-loading-spinner cmp-loading-sm"
              aria-hidden="true"
            ></span><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveSessionReadiness === "error" || projection.openState === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb cmp-mask cmp-mask-circle"
              aria-hidden="true"
            ></div>
            <h1>{t("session.failed")}</h1>
            <p>
              {t("session.reconnectHint")}
            </p>
            <button
              class="cmp-btn cmp-btn-primary"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else}
          <div
            bind:this={timeline}
            class="companion-timeline"
            class:timeline-ready={timelineReady}
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            on:scroll={onScroll}
          >
            <div class="companion-timeline-content" use:keepBottomOnResize>
              {#if keetRecovery}
                <div data-testid="keet-recovery-notice" role="status" class="cmp-alert cmp-alert-warning">
                  <span>{keetRecovery}</span>
                </div>
              {/if}
              {#if displayedProjection.hasMore}
                <button
                  class="cmp-btn cmp-btn-ghost cmp-btn-sm"
                  style="display:block;margin:0 auto 18px"
                  on:click={loadOlder}
                  disabled={displayedProjection.loadingOlder}
                  >{displayedProjection.loadingOlder
                    ? t("loading.progress")
                    : t("history.older")}</button
                >
              {/if}
              {#if displayedProjection.items.length === 0}
                <div class="companion-recovery">
                  <div
                    class="companion-mood-orb cmp-mask cmp-mask-circle"
                    aria-hidden="true"
                  ></div>
                  <h1>
                    {t("welcome.greeting", { name: identity.preferredAddress })}
                  </h1>
                  <p>{t("welcome.prompt")}</p>
                </div>
              {/if}
              {#each displayedProjection.messageUnits as unit (unit.id)}
                {@const first = unit.items[0]}
                {#if first?.kind === "continuity"}
                  <div
                    class="companion-continuity-record"
                    data-testid={`continuity-record-${first.compactionId}`}
                    aria-live="off"
                  >
                    {t("compact.record")}
                  </div>
                {:else if first?.kind === "notice"}
                  <div
                    class="companion-recovery"
                    role={first.tone === "error" ? "alert" : "status"}
                  >
                    <p>{noticeText(first, t)}</p>
                  </div>
                {:else}
                  {@const parts = messageContentParts(unit)}
                  <article
                    class="cmp-chat companion-row"
                    class:cmp-chat-start={unit.side === "incoming"}
                    class:cmp-chat-end={unit.side === "outgoing"}
                    class:outgoing={unit.side === "outgoing"}
                    class:incoming={unit.side === "incoming"}
                    class:companion-row-pending={unit.pending}
                    data-pending={unit.pending || undefined}
                    data-testid={unitTestId(unit)}
                  >
                    <div
                      class="cmp-chat-image cmp-avatar cmp-avatar-placeholder message-avatar"
                    >
                      <div
                        class="companion-avatar-crop cmp-mask cmp-mask-circle"
                      >
                        {#if unit.side === "incoming" && identity.companionAvatar}<img
                            src={identity.companionAvatar}
                            alt=""
                          />{:else if unit.side === "outgoing" && identity.userAvatar}<img
                            src={identity.userAvatar}
                            alt=""
                          />{:else}<span aria-hidden="true"
                            >{unit.side === "incoming" ? "✦" : t("you")}</span
                          >{/if}
                      </div>
                    </div>
                    <div class="companion-message-stack">
                      {#each parts as part}
                        {#if part.kind === "images"}
                          <div
                            class="companion-image-group"
                            class:companion-image-group-many={part.items
                              .length > 1}
                            data-testid={`image-group-${unit.id}`}
                          >
                            {#each part.items as image (image.id)}
                              <div
                                class="companion-image-entry"
                                class:companion-image-entry-tile={part.items
                                  .length > 1}
                                data-testid={`image-${image.id}`}
                              >
                                <div
                                  class="companion-media"
                                  class:companion-media-tile={part.items
                                    .length > 1}
                                  class:companion-media-single={part.items
                                    .length === 1}
                                >
                                  {#if image.state === "running" || image.state === "loading"}
                                    <div
                                      class="cmp-skeleton companion-media-loading"
                                      aria-hidden="true"
                                    ></div>
                                    <div
                                      class="companion-media-status"
                                      role="status"
                                    >
                                      {t("image.generating")}
                                    </div>
                                  {:else if image.previewUrl || imageUrls[image.id]}
                                    <button
                                      class="companion-media-button"
                                      aria-label={t("image.view", {
                                        name: image.alt || t("image.preview"),
                                      })}
                                      on:click={() => showLightbox(image)}
                                      ><img
                                        src={image.previewUrl ??
                                          imageUrls[image.id]}
                                        alt={image.alt || t("image.preview")}
                                        style={imageStyle(
                                          image,
                                          part.items.length > 1,
                                        )}
                                        on:load={(event) =>
                                          onImageLoaded(image, event)}
                                      /></button
                                    >
                                  {:else if imageErrors[image.id]}
                                    <div
                                      class="companion-media-failure"
                                      role="alert"
                                      style={imageStyle(
                                        image,
                                        part.items.length > 1,
                                      )}
                                    >
                                      <span>{t("error.image")}</span><button
                                        class="cmp-btn cmp-btn-ghost cmp-btn-sm"
                                        type="button"
                                        on:click={() => retryImage(image)}
                                        >{t("retry")}</button
                                      >
                                    </div>
                                  {:else if image.state === "failed"}
                                    <div
                                      class="companion-media-failure"
                                      role="alert"
                                      style={imageStyle(
                                        image,
                                        part.items.length > 1,
                                      )}
                                    >
                                      <span>{t("image.failed")}</span>
                                    </div>
                                  {:else}
                                    <div
                                      class="cmp-loading cmp-loading-spinner companion-media-spinner"
                                      role="status"
                                      aria-label={t("loading.progress")}
                                    ></div>
                                  {/if}
                                </div>
                              </div>
                            {/each}
                          </div>
                        {:else if part.item.kind === "text"}
                          <div
                            class="cmp-chat-bubble companion-bubble"
                            class:cmp-skeleton={part.item.pending &&
                              !part.item.text}
                          >
                            <Markdown text={part.item.text} />
                          </div>

                        {:else if part.item.kind === "voice"}
                          {@const item = part.item}
                          {@const playback =
                            voicePlayback[item.id] ?? EMPTY_VOICE_PLAYBACK}
                          <div
                            class="cmp-chat-bubble companion-bubble companion-voice"
                            role="region"
                            aria-label={t("voice.player")}
                          >
                            {#if voiceUrls[item.id]}
                              <audio
                                class="companion-audio"
                                preload="metadata"
                                src={voiceUrls[item.id]}
                                aria-hidden="true"
                                tabindex="-1"
                                use:trackVoiceAudio={item.id}
                              ></audio>
                              <button
                                class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-voice-control"
                                aria-label={playback.playing
                                  ? t("voice.pause")
                                  : t("voice.play")}
                                on:click={(event) =>
                                  void toggleVoice(item, event.currentTarget)}
                              >
                                {#if playback.playing}<Pause
                                    size={18}
                                    fill="currentColor"
                                    aria-hidden="true"
                                  />{:else}<Play
                                    size={18}
                                    fill="currentColor"
                                    aria-hidden="true"
                                  />{/if}
                              </button>
                              <div class="companion-voice-player">
                                <div class="companion-voice-waveform">
                                  {#each voiceWaveform(item.id) as height, index}<span
                                      class:played={(index + 1) /
                                        VOICE_WAVEFORM_BAR_COUNT <=
                                        voiceProgress(playback)}
                                      style={`--voice-bar:${height}%`}
                                      aria-hidden="true"
                                    ></span>{/each}
                                  <input
                                    class="companion-voice-seek"
                                    type="range"
                                    min="0"
                                    max={playback.duration || 0}
                                    step="0.1"
                                    value={playback.current}
                                    disabled={!hasVoiceDuration(playback)}
                                    aria-label={t("voice.progress")}
                                    aria-valuetext={hasVoiceDuration(playback)
                                      ? `${formatVoiceSeconds(playback.current)} / ${formatVoiceSeconds(playback.duration, "ceil")}`
                                      : t("loading.progress")}
                                    on:input={(event) =>
                                      seekVoice(event, item.id)}
                                  />
                                </div>
                                <div class="companion-voice-meta">
                                  {#if voiceTimestamp(playback)}<span
                                      role="timer"
                                      aria-live="off"
                                      >{voiceTimestamp(playback)}</span
                                    >{:else}<span role="status"
                                      >{t("loading.progress")}</span
                                    >{/if}{#if voiceErrors[item.id]}<span
                                      role="alert">{t("voice.playFailed")}</span
                                    >{/if}
                                </div>
                              </div>
                            {/if}
                          </div>
                        {/if}
                      {/each}
                      {#if unit.pendingLabel}<div class="companion-meta" role="status">{unit.pendingLabel}</div>{/if}
                    </div>
                  </article>
                {/if}
              {/each}
              {#if typingVisible}
                <article
                  class="cmp-chat cmp-chat-start companion-row incoming"
                  data-testid="companion-typing-indicator"
                  role="status"
                  aria-label={t("status.namedTyping", {
                    name: identity.companionName,
                  })}
                >
                  <div
                    class="cmp-chat-image cmp-avatar cmp-avatar-placeholder message-avatar"
                  >
                    <div class="companion-avatar-crop cmp-mask cmp-mask-circle">
                      {#if identity.companionAvatar}<img
                          src={identity.companionAvatar}
                          alt=""
                        />{:else}<span aria-hidden="true">✦</span>{/if}
                    </div>
                  </div>
                  <div
                    class="cmp-chat-bubble companion-bubble companion-typing-bubble"
                  >
                    <span
                      class="cmp-loading cmp-loading-dots cmp-loading-sm"
                      aria-hidden="true"
                    ></span>{#if waitingCopy}<span
                        class="companion-waiting-copy"
                        >{waitingCopy ? t(waitingCopy) : ""}</span
                      >{/if}
                  </div>
                </article>
              {/if}
              {#if !wasNearBottom && displayedProjection.items.length > 0}<button
                  class="cmp-btn cmp-btn-primary cmp-btn-sm companion-new-message"
                  style="position:sticky;bottom:10px;left:50%;transform:translateX(-50%)"
                  on:click={() => (timeline.scrollTop = timeline.scrollHeight)}
                  >{t("messages.new")}</button
                >{/if}
            </div>
          </div>
          <div class="companion-composer">
            {#if commandSuggestion}
              <div
                id="companion-command-suggestions"
                class="companion-command-suggestions"
                role="listbox"
                aria-label={t("command.label")}
              >
                <button
                  id="companion-command-compact"
                  class="cmp-btn cmp-btn-ghost companion-command-suggestion"
                  type="button"
                  role="option"
                  aria-selected="true"
                  on:click={acceptCommandSuggestion}
                >
                  <span class="companion-command-name"
                    >{commandSuggestion.command}</span
                  >
                  <span class="companion-command-description"
                    >{commandSuggestion.description}</span
                  >
                  <span class="companion-command-tab" aria-hidden="true"
                    >Tab</span
                  >
                </button>
              </div>
            {/if}
            {#if continuityStatus}
              <div
                class="companion-continuity-status"
                data-testid="companion-continuity-status"
                data-state={continuityStatus.status}
                role={continuityStatus.status === "failed" ? "alert" : "status"}
                aria-live="polite"
              >
                {#if continuityStatus.status === "running"}{t(
                    "compact.running",
                  )}{:else if continuityStatus.status === "failed"}{t(
                    "compact.failed",
                  )}{:else}{t("compact.done")}{/if}
              </div>
            {/if}
            {#if imageDrafts.length > 0}
              <div
                class="companion-image-drafts"
                role="group"
                aria-label={t("image.pending")}
              >
                {#each imageDrafts as draft (draft.id)}
                  <div class="companion-image-draft">
                    <button
                      class="companion-image-draft-preview"
                      type="button"
                      aria-label={t("image.view", {
                        name: draft.file.name || t("image.pending"),
                      })}
                      on:click={() => showDraftLightbox(draft)}
                      ><img
                        src={draft.previewUrl}
                        alt={draft.file.name || t("image.pending")}
                      /></button
                    >
                    <button
                      class="cmp-btn cmp-btn-neutral cmp-btn-circle cmp-btn-xs companion-image-draft-remove"
                      type="button"
                      aria-label={t("image.remove")}
                      on:click={() => removeImage(draft)}
                      ><X
                        size={13}
                        strokeWidth={2.5}
                        aria-hidden="true"
                      /></button
                    >
                  </div>
                {/each}
              </div>
            {/if}
            <div class="companion-compose-row">
              <input
                bind:this={photoLibraryInput}
                id="companion-image-library"
                class="companion-image-input"
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                tabindex="-1"
                aria-hidden="true"
                on:change={onImageInput}
              />
              <button
                class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-attach"
                type="button"
                aria-label={t("image.choose")}
                title={t("image.choose")}
                disabled={!imageLimits}
                on:pointerdown={onImagePickerPointerDown}
                on:pointerup={onImagePickerPointerUp}
                on:pointercancel={clearImagePickerPointer}
                on:contextmenu|preventDefault
                on:click={choosePhoto}
                ><ImagePlus
                  size={19}
                  strokeWidth={2}
                  aria-hidden="true"
                /></button
              >
              <textarea
                bind:this={composerInput}
                class="companion-textarea"
                aria-label={t("composer.label")}
                aria-autocomplete={commandSuggestion ? "list" : undefined}
                aria-controls={commandSuggestion
                  ? "companion-command-suggestions"
                  : undefined}
                placeholder={t("composer.placeholder", {
                  name: identity.companionName,
                })}
                rows="1"
                value={composer.draft}
                on:input={onInput}
                on:paste={onPaste}
                on:compositionstart={onCompositionStart}
                on:compositionend={onCompositionEnd}
                on:keydown={onKeydown}></textarea>
              <button
                class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-microphone"
                class:companion-microphone-recording={voiceStatus ===
                  "recording"}
                class:companion-microphone-stopping={voiceStatus === "stopping"}
                type="button"
                data-state={voiceStatus}
                aria-label={voiceStatus === "recording"
                  ? t("voice.stop")
                  : voiceStatus === "transcribing"
                    ? t("voice.transcribing")
                    : voiceCapability === "loading"
                      ? t("voice.preparing")
                      : voiceCapability === "available" && voiceCaptureAvailable
                        ? t("voice.start")
                        : t("voice.micUnavailable")}
                title={voiceStatus === "recording"
                  ? t("voice.stop")
                  : voiceCapability === "available" && voiceCaptureAvailable
                    ? t("voice.start")
                    : voiceUnavailableText(t)}
                disabled={voiceStatus === "stopping" ||
                  voiceStatus === "transcribing" ||
                  projection.canSubmit === false ||
                  voiceCapability !== "available" ||
                  !actions.transcribeVoice ||
                  !voiceCaptureAvailable}
                on:click={() => void toggleVoiceInput()}
              >
                {#if voiceStatus === "transcribing" || voiceStatus === "stopping"}<span
                    class="cmp-loading cmp-loading-spinner cmp-loading-sm"
                    aria-hidden="true"
                  ></span>{:else}<Mic
                    size={19}
                    strokeWidth={voiceStatus === "recording" ? 2.6 : 2}
                    aria-hidden="true"
                  />{/if}
              </button>
              {#if contextCapacity}
                <div class="companion-context-meter-wrap">
                  <button
                    bind:this={contextMeterButton}
                    class="cmp-btn cmp-btn-ghost cmp-btn-circle companion-context-meter"
                    class:companion-context-meter-open={contextMeterOpen}
                    data-state={continuityStatus?.status === "running"
                      ? "active"
                      : continuityStatus?.status === "complete"
                        ? "complete"
                        : continuityStatus?.status === "failed"
                          ? "failed"
                          : contextCapacity.percentage >= 80
                            ? "warning"
                            : "idle"}
                    type="button"
                    aria-label={t("context.percentage", {
                      percentage: contextCapacity.percentage,
                    })}
                    aria-expanded={contextMeterOpen}
                    aria-controls="companion-context-popover"
                    on:click={toggleContextMeter}
                  >
                    <svg viewBox="0 0 28 28" aria-hidden="true"
                      ><circle
                        class="companion-context-meter-track"
                        cx="14"
                        cy="14"
                        r="11"
                      ></circle><circle
                        class="companion-context-meter-value"
                        cx="14"
                        cy="14"
                        r="11"
                        pathLength="100"
                        style={`stroke-dashoffset:${100 - contextCapacity.percentage}`}
                      ></circle></svg
                    >
                  </button>
                  {#if contextMeterOpen}
                    <div
                      bind:this={contextMeterPopover}
                      id="companion-context-popover"
                      class="cmp-card companion-context-popover"
                      role="dialog"
                      aria-labelledby="companion-context-popover-title"
                      tabindex="-1"
                    >
                      <h2 id="companion-context-popover-title">
                        {t("context.label")}
                      </h2>
                      <p class="companion-context-percent">
                        {contextCapacity.percentage}%
                      </p>
                      <p>
                        {formatTokenCount(contextCapacity.usedTokens)} / {formatTokenCount(
                          contextCapacity.contextWindow,
                        )}
                      </p>
                    </div>
                  {/if}
                </div>
              {/if}
              {#if projection.running && !composer.draft.trim() && imageDrafts.length === 0}
                <button
                  class="cmp-btn cmp-btn-primary cmp-btn-circle companion-send"
                  aria-label={t("reply.stop")}
                  on:click={() => void stop()}
                  disabled={!actions.stop || stopping}
                  ><Square
                    size={15}
                    fill="currentColor"
                    aria-hidden="true"
                  /></button
                >
              {:else}
                <button
                  class="cmp-btn cmp-btn-primary cmp-btn-circle companion-send"
                  aria-label={t("message.send")}
                  on:click={submit}
                  disabled={projection.canSubmit === false || composer.draft.trim().length > MAX_MESSAGE_LENGTH || (!composer.draft.trim() && imageDrafts.length === 0)}
                  ><span aria-hidden="true">↑</span></button
                >
              {/if}
              {#if projection.running && (composer.draft.trim() || imageDrafts.length > 0) && actions.stop}
                <button
                  class="cmp-btn cmp-btn-neutral cmp-btn-circle companion-stop-inline"
                  data-testid="companion-stop"
                  aria-label={t("reply.stop")}
                  on:click={() => void stop()}
                  disabled={stopping}
                  ><Square size={13} fill="currentColor" aria-hidden="true" /></button
                >
              {/if}
            </div>
            {#if composer.draft.trim().length > MAX_MESSAGE_LENGTH}
              <div class="companion-voice-input-status companion-voice-input-error" role="alert">
                {t("message.tooLong", { limit: MAX_MESSAGE_LENGTH, count: composer.draft.trim().length })}
              </div>
            {/if}
            {#if voiceStatus === "recording" || voiceStatus === "stopping"}
              <div
                class="companion-voice-input-status"
                data-testid="companion-voice-recording-status"
                role="status"
                aria-live="polite"
              >
                {voiceStatus === "stopping"
                  ? t("voice.stopping")
                  : t("voice.recording", {
                      elapsed: formatVoiceElapsed(voiceElapsedMs),
                    })}
              </div>
            {:else if voiceStatus === "transcribing"}
              <div
                class="companion-voice-input-status"
                data-testid="companion-voice-transcribing-status"
                role="status"
                aria-live="polite"
              >
                {t("voice.transcribingProgress")}
              </div>
            {:else if voiceCapability === "unavailable" || !voiceCaptureAvailable}
              <div
                class="companion-voice-input-status companion-voice-input-unavailable"
                data-testid="companion-voice-unavailable-status"
                role="status"
              >
                {voiceUnavailableText(t)}
              </div>
            {:else if voiceFailure || voiceStatus === "unavailable"}
              <div
                class="companion-voice-input-status companion-voice-input-error"
                data-testid="companion-voice-error-status"
                role="status"
              >
                {t(voiceFailure || "voice.failed")}
              </div>
            {/if}
            <div class="companion-compose-hint">
              {t("composer.shortcut")}
            </div>
          </div>
        {/if}
      </main>
    </div>

  </div>
  {#if detailOpen}
    <div class="companion-history-backdrop">
      <button
        type="button"
        tabindex="-1"
        aria-label={t("relationship.close")}
        on:click={() => closeDetail()}
      ></button>
    </div>
    <div
      bind:this={relationshipDrawer}
      id="companion-relationship-drawer"
      class="companion-history-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={t("relationship.named", { name: identity.companionName })}
      data-testid="companion-relationship-drawer"
    >
      <div class="companion-history-controls">
        <button
          type="button"
          class="cmp-btn cmp-btn-ghost cmp-btn-circle cmp-btn-sm"
          aria-label={t("relationship.close")}
          on:click={() => closeDetail()}
          ><X size={16} strokeWidth={2} aria-hidden="true" /></button
        >
      </div>
      <div class="companion-diary-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          id="companion-history-tab"
          aria-controls="companion-drawer-panel"
          aria-selected={drawerTab === "history"}
          class="cmp-btn cmp-btn-ghost cmp-btn-sm"
          class:cmp-btn-active={drawerTab === "history"}
          on:click={() => drawerTab = "history"}>{t("drawer.history")}</button
        >
        <button
          type="button"
          role="tab"
          id="companion-diary-tab"
          aria-controls="companion-drawer-panel"
          aria-selected={drawerTab === "diary"}
          class="cmp-btn cmp-btn-ghost cmp-btn-sm"
          class:cmp-btn-active={drawerTab === "diary"}
          on:click={() => void openDiary()}>{t("drawer.diary")}</button
        >
      </div>
      <div
        id="companion-drawer-panel"
        class="companion-history-scroll"
        role="tabpanel"
        aria-labelledby={drawerTab === "history"
          ? "companion-history-tab"
          : "companion-diary-tab"}
      >
        {#if drawerTab === "diary"}
          <section class="companion-diary">
            {#if diaryEntry}
              <button
                type="button"
                class="cmp-btn cmp-btn-ghost cmp-btn-sm companion-diary-back"
                on:click={() => diaryEntry = undefined}>← {t("diary.back")}</button
              >
              <article class="companion-diary-page">
                <time datetime={diaryEntry.name.slice(0, -3)}
                  >{diaryEntry.name.slice(0, -3)}</time
                >
                <Markdown text={diaryEntry.text} />
              </article>
            {:else if diaryLoading}
              <p class="companion-history-state" role="status">{t("loading")}</p>
            {:else if diaryTooLarge}
              <p class="companion-history-state" role="alert">{t("diary.tooLarge")}</p>
            {:else if diaryError}
              <div class="companion-history-state" role="alert">
                <p>{t("diary.failed")}</p>
                <button type="button" class="cmp-btn cmp-btn-ghost cmp-btn-sm" on:click={() => void openDiary()}>{t("retry")}</button>
              </div>
            {:else if !diaryEntries.length}
              <p class="companion-history-state">{t("diary.empty")}</p>
            {:else}
              <div class="companion-diary-list">
                {#each diaryEntries as entry}
                  <button type="button" class="companion-diary-list-entry" on:click={() => void openDiaryEntry(entry)}>
                    <time datetime={entry.slice(0, -3)}>{entry.slice(0, -3)}</time>
                    <span aria-hidden="true">›</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {:else}
        <section
          class="companion-history-current"
          aria-labelledby="companion-history-current-title"
        >
          <h3 id="companion-history-current-title">{t("history.current")}</h3>
          <dl class="companion-history-current-list">
            <dt>{t("mood.label")}</dt>
            <dd>
              {identity.moodLabel}{identity.moodNote
                ? ` · ${identity.moodNote}`
                : ""}
            </dd>
            <dt>{t("affinity.label")}</dt>
            <dd>
              {identity.affinity === undefined
                ? t("loading")
                : `${identity.affinity} · ${identity.affinityStage}`}
            </dd>
            <dt>{t("history.signature")}</dt>
            <dd>{identity.signature || t("signature.empty")}</dd>
          </dl>
        </section>

        <section
          class="companion-history-list"
          aria-labelledby="companion-history-list-title"
        >
          <h3 id="companion-history-list-title">{t("history.list")}</h3>
          {#if history.status === "loading"}
            <div class="companion-history-state" role="status">
              <span
                class="cmp-loading cmp-loading-spinner cmp-loading-sm"
                aria-hidden="true"
              ></span>
              <span>{t("history.loading")}</span>
            </div>
          {:else if history.status === "error"}
            <div class="companion-history-state" role="alert">
              <p>{t("history.failed")}</p>
              <button
                type="button"
                class="cmp-btn cmp-btn-ghost cmp-btn-sm"
                on:click={() => actions.retryHistory?.()}
                >{t("history.retry")}</button
              >
            </div>
          {:else if history.records.length === 0}
            <p class="companion-history-state">{t("history.empty")}</p>
          {:else}
            {#if history.hasEarlier}
              <button
                type="button"
                class="cmp-btn cmp-btn-ghost cmp-btn-sm companion-history-earlier"
                disabled={history.loadingEarlier}
                on:click={() => void loadEarlierHistory()}
                >{history.loadingEarlier
                  ? t("history.loadingEarlier")
                  : t("history.earlier")}</button
              >
            {/if}
            <div class="companion-history-entries">
              {#each history.records as record, index (`${record.at}:${index}`)}
                {@const changes = changesForHistoryRecord(index)}
                <article class="companion-history-entry">
                  <time datetime={record.at}
                    >{formatHistoryDate(record.at, locale)}</time
                  >
                  {#if record.changes.seed}
                    <p class="companion-history-initial">
                      {t("history.initial")}
                    </p>
                  {:else if changes.length === 0}
                    <p class="companion-history-initial">
                      {t("history.initial")}
                    </p>
                  {:else}
                    <ul>
                      {#each changes as change}
                        <li>
                          <strong
                            >{historyDimensionLabel(change.dimension)}</strong
                          >
                          <div class="companion-history-values"><span>{historyValueLabel(change.dimension, change.after)}</span>{#if change.dimension === "affinity" && change.delta}<strong class="companion-history-growth">+{change.delta}</strong>{/if}</div>
                          {#if change.reason}<p
                              class="companion-history-reason"
                            >
                              {t("history.reason")}: {change.reason}
                            </p>{/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </section>
        {/if}
      </div>
    </div>
  {/if}
  {#if lightbox}
    <dialog
      bind:this={lightboxDialog}
      id="companion-image-lightbox"
      class="cmp-modal companion-lightbox"
      aria-label={t("image.preview")}
      on:close={onLightboxClose}
    >
      <div class="cmp-modal-box companion-lightbox-dialog">
        {#if lightboxUrl}<img
            src={lightboxUrl}
            alt={t("image.previewAlt")}
          />{:else}<div class="cmp-loading cmp-loading-spinner"></div>{/if}
      </div>
      <button
        class="cmp-btn cmp-btn-circle companion-lightbox-close"
        aria-label={t("image.close")}
        on:click={() => closeLightbox()}
        ><X size={16} strokeWidth={2} aria-hidden="true" /></button
      >
      <form
        method="dialog"
        class="cmp-modal-backdrop companion-lightbox-backdrop"
      >
        <button type="submit" aria-label={t("image.closeBackdrop")}
          >{t("close")}</button
        >
      </form>
    </dialog>
  {/if}
</div>
<div class="companion-sr-only" aria-live="assertive">
  {typeof liveAnnouncement === "string"
    ? liveAnnouncement
    : t(liveAnnouncement.key, liveAnnouncement.params)}
</div>
