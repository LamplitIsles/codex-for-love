<script lang="ts">
  import { visibleViewport, followTimelineResize } from "./viewport.js";
  import { MAX_MESSAGE_LENGTH } from "../../message-input.ts";
  import { normalizeVoiceTranscription } from "./voice-input.js";
  import {
    english,
    type CompanionLocaleKey,
    type CompanionMessage,
    type CompanionTranslate,
  } from "./locale.js";
  export let t: CompanionTranslate = english;
  export let locale = "en";
  export let backgrounds: { landscape: string; portrait: string } | undefined = undefined;
  import { createEventDispatcher, onDestroy, tick } from "svelte";
  import { captureNativePhoto, hasNativeCamera } from "./native-mobile.js";
  import AlarmDrawer from "./AlarmDrawer.svelte";
  import type { Alarm as AlarmView } from "../../../../runtime/alarms.ts";
  import Plus from "lucide-svelte/icons/plus";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import ArrowUp from "lucide-svelte/icons/arrow-up";
  import { f7, f7ready, Preloader, Panel, Popover, Block, List, ListItem, Navbar, Page, PageContent, Messages, Message, Messagebar, MessagebarAttachments, MessagebarAttachment } from "framework7-svelte";
  import { syncSystemBars } from "./native-navigation.ts";
  import Menu from "lucide-svelte/icons/menu";
  import Settings from "lucide-svelte/icons/settings";
  import Search from "lucide-svelte/icons/search";
  import Pause from "lucide-svelte/icons/pause";
  import Play from "lucide-svelte/icons/play";
  import Square from "lucide-svelte/icons/square";
  import Mic from "lucide-svelte/icons/mic";
  import X from "lucide-svelte/icons/x";
  import Images from "lucide-svelte/icons/images";
  import Heart from "lucide-svelte/icons/heart";
  import BookOpen from "lucide-svelte/icons/book-open";
  import AlarmClock from "lucide-svelte/icons/alarm-clock";
  import Gallery from "./Gallery.svelte";
  import { longPress } from "./long-press.ts";
  import { overlayOpened, overlayClosed, overlayOpening } from "./overlay-focus.ts";
  import { captureReadingFocus, dismissComposerOnTimelineTap } from "./reading-focus.ts";
  import { messageMenu, dismissMessageMenu, messageMenuOpen } from "./message-menu.ts";
  import { Capacitor } from "@capacitor/core";
  import { Clipboard } from "@capacitor/clipboard";
  import { App } from "@capacitor/app";
  import { saveImage } from "./save-image.ts";
  type Swiper = ReturnType<typeof f7.swiper.create>;
  import type { PhotoBrowser } from "framework7/components/photo-browser";
  import { galleryRows, type GalleryGrouping, type GalleryImage } from "./gallery.js";
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
  } from "./companion-bridge.js";
  import type { PendingSubmissionRetirement } from "./contracts.js";
  import { CompanionPreControllerError } from "./admission.js";
  import {
    createComposerState,
    findComposerCommand,
    reduceComposer,
    shouldSubmitEnter,
    type ComposerCommand,
  } from "./composer.js";
  import {
    createImageDrafts,
    imageFilesFromClipboard,
    imageIntakeError,
    IMAGE_ACCEPT,
    releaseImageDrafts,
    type CompanionImageDraft,
  } from "./image-drafts.js";
  import type { CompanionReadiness } from "./readiness.js";
  import type { CompanionAppearance, CompanionLanguage } from "./preferences.js";
  import { companionHistoryChanges } from "../relationship-history.js";
  import type { CompanionHistoryChange } from "../domain.js";
  import Markdown from "./Markdown.svelte";
  import ConversationSearch from "./ConversationSearch.svelte";
  import {
    formatMessageTime,
    messageTimeDateTime,
  } from "../message-time.js";
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
  let photoCaptureInput: HTMLInputElement;
  let commandSuggestion: ComposerCommand | undefined;
  let stopping = false;
  let timeline: HTMLDivElement;
  let timelineReady = false;
  let timelineRevealFrame = 0;
  let timelineGeometry = { height: 0, viewport: 0 };
  let detailOpen = false;
  let preferencesOpen = false;
  let preferencesButton: HTMLButtonElement;
  let drawerTab: "history" | "diary" | "images" | "alarms" = "history";
  let alarms: AlarmView[] = [];
  let alarmsLoading = false;
  let alarmsError = false;
  let galleryImages: GalleryImage[] = [];
  let galleryGrouping: GalleryGrouping = "week";
  let galleryCursor: string | undefined;
  let galleryLoading = false;
  let galleryError = false;
  $: galleryRowsValue = galleryRows(galleryImages, locale, galleryGrouping);
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
  let copyToast: CompanionLocaleKey | undefined;
  let copyToastTimer: ReturnType<typeof setTimeout> | undefined;
  let liveAnnouncement: string | CompanionMessage = "";

  let lightboxReturnFocus: HTMLElement | undefined;
  let relationshipDrawer: HTMLElement;
  let photoBrowser: PhotoBrowser.PhotoBrowser | undefined;
  let preferencesPanel: HTMLElement;
  let searchOpen = false;

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
  let messagebarComponent: Messagebar;
  let messagesComponent: Messages;
  let voiceInsertion = { start: 0, end: 0 };
  let voiceOriginDraft = "";
  let voiceStatus: VoiceRecordingStatus = "idle";
  const voiceCaptureAvailable = canCaptureVoice();
  let voiceFailure: CompanionLocaleKey | "" = "";
  let voiceController = new VoiceRecordingController({
    onStatus: (status) => {
      voiceStatus = status;
    },
    onError: (error) => {
      if (error.code !== "cancelled") {
        voiceFailure = voiceErrorKey(error);
        liveAnnouncement = { key: voiceFailure };
      }
    },
  });
  let voiceSessionId: string | undefined;
  let voiceTranscriptionAbort: AbortController | undefined;


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
  $: voiceBusy = voiceStatus === "recording" || voiceStatus === "stopping" || voiceStatus === "transcribing";
  $: if (imageDrafts) void scheduleComposerResize();
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
    await tick();
    if (!composerInput?.isConnected) return;
    f7.input.resizeTextarea(composerInput);
    messagebarComponent?.instance()?.resizePage();
  }

  function connectMessagebar(node: HTMLElement, options: { label: string; suggestions: boolean }) {
    const bar = node.parentElement!;
    const input = bar.querySelector<HTMLTextAreaElement>("textarea")!;
    composerInput = input;
    const update = (value: typeof options) => {
      input.setAttribute("aria-label", value.label);
      if (value.suggestions) {
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", "companion-command-suggestions");
      } else {
        input.removeAttribute("aria-autocomplete");
        input.removeAttribute("aria-controls");
      }
    };
    update(options);
    // Framework7 Svelte 9.2 Messagebar expects Input callbacks wrapped in detail[0].
    // Its Input currently forwards a native event, so adapt that boundary before it runs.
    const wrapInput = (event: Event) => Object.defineProperty(event, "detail", { value: [event], configurable: true });
    input.addEventListener("input", wrapInput, true);
    input.addEventListener("paste", onPaste);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    const observer = new ResizeObserver(() => {
      messagebarComponent?.instance()?.resizePage();
      bar.closest<HTMLElement>(".page")?.style.setProperty("--companion-messagebar-height", `${bar.offsetHeight}px`);
    });
    observer.observe(bar, { box: "border-box" });
    void scheduleComposerResize();
    return { update, destroy() {
      observer.disconnect();
      input.removeEventListener("input", wrapInput, true);
      input.removeEventListener("paste", onPaste);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
    } };
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
        ...images.map(image => ({ kind: "images" as const, items: [image] })),
        ...rest.map((item) => ({ kind: "item" as const, item })),
      ];
    }
    const parts: MessageContentPart[] = [];
    for (const item of content) {
      if (item.kind === "image") {
        parts.push({ kind: "images", items: [item] });
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

  function closePopover(node: HTMLElement | undefined): boolean {
    const popover = node && f7.popover.get(node);
    if (!popover) return false;
    popover.close();
    return true;
  }

  function openContextMeter(): void {
    if (!contextCapacity) return;
    contextMeterOpen = true;
  }

  function closeContextMeter(restoreFocus = true): void {
    if (restoreFocus && closePopover(contextMeterPopover)) return;
    contextMeterOpen = false;
  }

  function toggleContextMeter(): void {
    if (contextMeterOpen) closeContextMeter();
    else openContextMeter();
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
    if (!timelineReady) {
      if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
      timelineRevealFrame = requestAnimationFrame(() => {
        if (!timeline) return;
        wasNearBottom = true;
        timeline.scrollTop = timeline.scrollHeight;
        timelineReady = true;
        timelineRevealFrame = 0;
      });
    }
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
    if (photoBrowser) { photoBrowser.params.photos = [{ url }]; photoBrowser.el?.querySelector(".swiper-slide-active img")?.setAttribute("src", url); }
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
    const geometry = { height: timeline.scrollHeight, viewport: timeline.clientHeight };
    const resized = geometry.height !== timelineGeometry.height || geometry.viewport !== timelineGeometry.viewport;
    timelineGeometry = geometry;
    // Layout-driven scroll events must not turn a follower into a history reader.
    if (!timelineReady || (resized && wasNearBottom)) return;
    wasNearBottom = geometry.height - geometry.viewport - timeline.scrollTop < 96;
  }

  function connectViewport(node: HTMLElement): { destroy(): void } {
    return visibleViewport(node.parentElement!);
  }

  function connectTimeline(node: HTMLElement): { destroy(): void } {
    timeline = node.parentElement as HTMLDivElement;
    const reading = dismissComposerOnTimelineTap(timeline, () => composerInput);
    const follow = followTimelineResize(node, timeline, () => timelineReady && wasNearBottom);
    let disposed = false;
    const foreground = App.addListener("resume", () => {
      if (!disposed && timelineReady) returnToLatest();
    }).catch(error => console.warn("Could not watch application resume", error));
    void reconcileProjection(displayedProjection);
    return { destroy() {
      disposed = true;
      reading.destroy(); follow.destroy();
      void foreground.then(listener => listener?.remove())
        .catch(error => console.warn("Could not release foreground scrolling", error));
    } };
  }

  function returnToLatest(): void {
    wasNearBottom = true;
    messagesComponent?.instance()?.scroll(0, timeline.scrollHeight - timeline.clientHeight);
  }

  async function copyMessage(item: TimelineText): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) await Clipboard.write({ string: item.text });
      else await navigator.clipboard.writeText(item.text);
      copyToast = "messages.copied";
    } catch {
      copyToast = "messages.copyFailed";
    }
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => { copyToast = undefined; copyToastTimer = undefined; }, 2000);
  }

  function submit(): void {
    if (projection.canSubmit === false || voiceBusy) return;
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
    returnToLatest();
    void tick().then(returnToLatest);
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
        // controller that retires its echo and restores a rejected draft. The only
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

  async function cancelVoiceInput(): Promise<void> {
    voiceTranscriptionAbort?.abort();
    voiceTranscriptionAbort = undefined;
    try {
      await voiceController.cancel();
    } catch {
      /* cleanup is best effort; the controller stops every known track */
    }
    voiceFailure = "";
  }

  async function stopVoiceAndTranscribe(): Promise<void> {
    let recording: VoiceRecording | undefined;
    try {
      recording = await voiceController.stopAndGet();
    } catch (error) {
      if (error instanceof VoiceRecordingError && error.code === "cancelled") return;
      voiceFailure = voiceErrorKey(error);
      liveAnnouncement = { key: voiceFailure };
      return;
    }
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
      const text = normalizeVoiceTranscription(transcription).text;
      if (composer.draft !== voiceOriginDraft) return;
      voiceController.finishTranscribing();
      setDraft(voiceOriginDraft.slice(0, voiceInsertion.start) + text + voiceOriginDraft.slice(voiceInsertion.end));
      await tick();
      composerInput?.setSelectionRange(voiceInsertion.start + text.length, voiceInsertion.start + text.length);
      liveAnnouncement = { key: "voice.ready" };
    } catch (error) {
      if (abort.signal.aborted) return;
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
    voiceFailure = "";
    try {
      voiceOriginDraft = composer.draft;
      voiceInsertion = { start: composerInput?.selectionStart ?? composer.draft.length, end: composerInput?.selectionEnd ?? composer.draft.length };
      await voiceController.start();
    } catch (error) {
      if (error instanceof VoiceRecordingError && error.code === "cancelled") return;
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
    if (voiceBusy) return;
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
    setDraft((event.target as HTMLTextAreaElement).value);
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

  async function capturePhoto(): Promise<void> {
    try {
      const file = await captureNativePhoto();
      if (file) addImages([file]);
    } catch {
      liveAnnouncement = { key: "camera.failed" };
    }
  }

  function removeImage(draft: CompanionImageDraft): void {
    releaseSubmissionImages([draft]);
    imageDrafts = imageDrafts.filter((candidate) => candidate !== draft);
  }
  function onImagePickerPointerDown(event: PointerEvent): void {
    if (voiceBusy || event.pointerType !== "touch") return;
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
    if (hasNativeCamera()) void capturePhoto();
    else photoCaptureInput?.click();
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
  function openSearch(): void {
    if (detailOpen) closeDetail();
    closePopover(preferencesPanel);
    searchOpen = true;
  }
  function closeSearch(): void { searchOpen = false; }
  function openDetail(): void {
    detailOpen = true;
    if (drawerTab === 'alarms') void openAlarms();
    onHistoryOpenChange?.(true);
  }
  function finishDetailClose(_restoreFocus = true): void { detailOpen = false; onHistoryOpenChange?.(false); }
  function closeDetail(_restoreFocus = true): void {
    diaryRequest?.abort(); diaryRequest = undefined;
    const panel = relationshipDrawer && f7.panel.get(relationshipDrawer);
    if (panel) panel.close(false);
    else finishDetailClose();
  }
  function openLightbox(item: ImagePreviewTarget): void {
    lightboxReturnFocus = captureReadingFocus(document);
    lightbox = item;
    lightboxUrl = item.previewUrl ?? imageUrls[item.id] ?? '';
    const params = {
      photos: [{ url: lightboxUrl }],
      type: 'popup' as const, theme: 'dark' as const, toolbar: false, navbar: true,
      navbarShowCount: false, popupCloseLinkText: t('close'), exposition: false, swipeToClose: false,
      routableModals: true, url: '/image/', view: f7.views.main,
      swiper: { zoom: { enabled: true, maxRatio: 4 }, spaceBetween: 0 },
      on: {
        open() {
          syncSystemBars(true);
          browser.el.setAttribute('role', 'dialog'); browser.el.setAttribute('aria-modal', 'true'); browser.el.setAttribute('aria-label', item.alt);
          browser.el.addEventListener('keydown', photoKeydown);
          const closeLink = browser.el.querySelector<HTMLElement>('.popup-close');
          if (closeLink) { closeLink.setAttribute('aria-label', t('image.close')); closeLink.tabIndex = 0; closeLink.focus(); }
          const image = browser.el.querySelector<HTMLImageElement>('.swiper-slide-active img');
          if (image) imagePress = longPress(image, { run: node => showImageMenu(lightboxUrl, item.alt, node) });
          (browser.swiper as Swiper).on('click', (_swiper: Swiper, event: MouseEvent | PointerEvent | TouchEvent) => {
            if (messageMenuOpen()) return;
            const image = browser.el.querySelector<HTMLImageElement>('.swiper-slide-active img');
            const rect = image?.getBoundingClientRect();
            const point = "changedTouches" in event ? event.changedTouches[0] : event;
            if (rect && point && (point.clientX < rect.left || point.clientX > rect.right || point.clientY < rect.top || point.clientY > rect.bottom)) browser.close();
          });
        },
        closed() {
          syncSystemBars(document.documentElement.classList.contains("dark"));
          browser.el.removeEventListener('keydown', photoKeydown);
          imagePress?.destroy(); imagePress = undefined;
          photoBrowser = undefined; lightbox = undefined; lightboxUrl = '';
          releaseDeferredPreviewReleases(); lightboxReturnFocus?.focus(); lightboxReturnFocus = undefined;
          queueMicrotask(() => browser.destroy());
        },
      },
    };
    const browser = f7.photoBrowser.create(params);
    const photoKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !messageMenuOpen()) { event.preventDefault(); browser.close(); }
      if (event.key === 'Tab') { event.preventDefault(); browser.el.querySelector<HTMLElement>('.popup-close')?.focus(); }
    };
    photoBrowser = browser;
    browser.open();
  }
  let imagePress: ReturnType<typeof longPress> | undefined;
  function toggleDetail(): void { if (detailOpen) closeDetail(); else openDetail(); }
  function showLightbox(item: TimelineImage): void {
    openLightbox({ id: item.id, alt: item.alt || t('image.preview'), previewUrl: item.previewUrl ?? imageUrls[item.id] });
  }
  function showDraftLightbox(draft: CompanionImageDraft): void {
    openLightbox({ id: `draft:${draft.id}`, alt: draft.file.name || t('image.pending'), previewUrl: draft.previewUrl });
  }
  function showTextMenu(item: TimelineText, target: HTMLElement): void {
    if (item.pending || !item.text.trim()) return;
    messageMenu(target, [{ text: t('messages.copy'), run: () => copyMessage(item) }], t('actions.cancel'));
  }
  function showToast(text: string): void {
    const toast = f7.toast.create({ text, closeTimeout: 2500 });
    toast.on('closed', () => toast.destroy()); toast.open();
  }
  function showImageMenu(url: string, name: string, target: HTMLElement): void {
    if (!url) return;
    messageMenu(target, [{ text: t('image.save'), run: async () => {
      try { await saveImage(url, name); showToast(t('image.saved')); }
      catch { showToast(t('image.saveFailed')); }
    } }], t('actions.cancel'));
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
  async function openAlarms(): Promise<void> {
    drawerTab = 'alarms';
    alarmsLoading = true; alarmsError = false;
    try {
      const response = await fetch('/api/alarms');
      if (!response.ok) throw new Error();
      alarms = (await response.json() as { alarms: AlarmView[] }).alarms;
    } catch { alarmsError = true; }
    finally { alarmsLoading = false; }
  }
  async function openGallery(force = false): Promise<void> {
    drawerTab = "images";
    if (galleryLoading || (!force && galleryImages.length)) return;
    galleryLoading = true; galleryError = false;
    try {
      const response = await fetch(`/api/conversation-images?limit=30${galleryCursor ? `&cursor=${encodeURIComponent(galleryCursor)}` : ""}`);
      if (!response.ok) throw new Error();
      const page = await response.json() as { images: GalleryImage[]; nextCursor?: string };
      galleryImages = [...galleryImages, ...page.images]; galleryCursor = page.nextCursor;
    } catch { galleryError = true; } finally { galleryLoading = false; }
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

  onDestroy(() => {
    dismissMessageMenu(); imagePress?.destroy(); photoBrowser?.destroy();
    if (copyToastTimer) clearTimeout(copyToastTimer);
    if (timelineRevealFrame) cancelAnimationFrame(timelineRevealFrame);
    releaseDeferredPreviewReleases();
    releaseSubmissionImages(imageDrafts);
    clearWaitingTimers();
    clearContinuityStatusTimer();
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



<Page name="companion" pageContent={false} id="dsh-companion" class="companion-shell" data-testid="companion-root">
  {#snippet fixedContent()}
        <Navbar class="companion-header">
          <div>
            <button
              type="button"
              class="button button-tonal button-round companion-history-toggle"
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
            <div class="companion-avatar  companion-avatar">
              <div class="companion-avatar-crop  ">
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
                class="companion-status {projection.status === 'offline'
                  ? 'color-red'
                  : projection.status === 'working'
                  ? 'color-orange'
                  : 'color-green'}"
              ></span>{statusText} · {identity.moodLabel}
            </div>
          </div>
          {#if projection.running && actions.stop}<button class="button button-tonal companion-reply-stop" data-testid="companion-stop" aria-label={t("reply.stop")} on:click={() => void stop()} disabled={stopping}><Square size={16} fill="currentColor" aria-hidden="true" /></button>{/if}
              {#if contextCapacity}
                <div class="companion-context-meter-wrap">
                  <button
                    bind:this={contextMeterButton}
                    class="button button-tonal button-round companion-context-meter"
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
                    aria-haspopup="dialog"
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
                    <Popover
                      opened={contextMeterOpen}
                      targetEl={contextMeterButton}
                      closeOnEscape
                      onPopoverOpen={(instance) => { if (instance) { contextMeterPopover = instance.el; overlayOpening(instance); } }}
                      onPopoverOpened={overlayOpened}
                      onPopoverClosed={(instance) => { contextMeterOpen = false; overlayClosed(instance); }}
                      id="companion-context-popover"
                      class="popover companion-context-popover"
                      role="dialog"
                      aria-labelledby="companion-context-popover-title"
                      tabindex={-1}
                    >
                      <Block>
                      <p id="companion-context-popover-title" class="companion-context-summary" aria-label={t("context.label")}>
                        {formatTokenCount(contextCapacity.usedTokens)} / {formatTokenCount(contextCapacity.contextWindow)} ({contextCapacity.percentage}%)
                      </p>
                      </Block>
                    </Popover>
                </div>
              {/if}
          <button type="button" class="button button-tonal button-round companion-search-trigger" aria-label={t('search.open')} aria-haspopup="dialog" on:click={openSearch}><Search size={19} strokeWidth={1.8} aria-hidden="true" /></button>
          <div class="companion-preferences">
            <button bind:this={preferencesButton} type="button" class="button button-tonal button-round companion-preferences-trigger" aria-label={t("preferences.open")} aria-controls="companion-preferences-panel" aria-haspopup="dialog" aria-expanded={preferencesOpen} on:click={() => { if (preferencesOpen) closePopover(preferencesPanel); else preferencesOpen = true; }}><Settings size={18} strokeWidth={1.8} aria-hidden="true" /></button>
              <Popover opened={preferencesOpen} targetEl={preferencesButton} closeOnEscape
                onPopoverOpen={(instance) => { if (instance) { preferencesPanel = instance.el; overlayOpening(instance); } }}
                onPopoverOpened={overlayOpened}
                onPopoverClosed={(instance) => { preferencesOpen = false; overlayClosed(instance); }}
                id="companion-preferences-panel" class="companion-preferences-panel" role="dialog" aria-label={t("preferences.open")}>
                <List>
                  <ListItem groupTitle title={t("preferences.theme")} />
                  {#each [["light", "preferences.light"], ["dark", "preferences.dark"], ["system", "preferences.system"]] as option}
                    <ListItem radio radioIcon="end" name="companion-appearance" value={option[0]} title={t(option[1] as CompanionLocaleKey)} checked={appearance === option[0]} onChange={() => onAppearanceChange(option[0] as CompanionAppearance)} />
                  {/each}
                  <ListItem groupTitle title={t("preferences.language")} />
                  {#each [["zh", "中文"], ["en", "English"]] as option}
                    <ListItem radio radioIcon="end" name="companion-language" value={option[0]} title={option[1]} checked={locale === option[0]} onChange={() => onLanguageChange(option[0] as CompanionLanguage)} />
                  {/each}
                </List>
              </Popover>
          </div>

        </Navbar>
    {#if effectiveWorkspaceReadiness === "ready" && effectiveRelationshipReadiness === "ready" && effectiveSessionReadiness === "ready" && projection.openState !== "error"}
          <Messagebar textareaId="companion-textarea" bind:this={messagebarComponent} class="companion-composer companion-compose-row" value={composer.draft} readonly={voiceBusy} maxHeight={144} attachmentsVisible={imageDrafts.length > 0}
            placeholder={t("composer.placeholder", {name: identity.companionName})}
            onInput={(event) => onInput(event.detail[0])}>
            {#snippet beforeInner()}
            {#if copyToast}
              <div class="companion-copy-toast" role="status">
                <div class="companion-copy-toast-message">{t(copyToast)}</div>
              </div>
            {/if}
            {#if commandSuggestion}
              <div
                id="companion-command-suggestions"
                class="companion-command-suggestions"
                role="listbox"
                aria-label={t("command.label")}
              >
                <button
                  id="companion-command-compact"
                  class="button button-tonal companion-command-suggestion"
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

            {/snippet}
            {#snippet innerStart()}
              <button
                class="button button-tonal button-round companion-attach"
                type="button"
                aria-label={t(voiceBusy ? "voice.cancel" : "image.choose")}
                title={t(voiceBusy ? "voice.cancel" : "image.choose")}
                disabled={!voiceBusy && !imageLimits}
                on:pointerdown={onImagePickerPointerDown}
                on:pointerup={onImagePickerPointerUp}
                on:pointercancel={clearImagePickerPointer}
                on:contextmenu|preventDefault
                on:click={() => voiceBusy ? void cancelVoiceInput() : choosePhoto()}
                >{#if voiceBusy}<X size={20} aria-hidden="true" />{:else}<Plus
                  size={19}
                  strokeWidth={2}
                  aria-hidden="true"
                />{/if}</button
              >

            {/snippet}
            {#snippet beforeArea()}
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
              <input
                bind:this={photoCaptureInput}
                id="companion-image-capture"
                class="companion-image-input"
                type="file"
                accept={IMAGE_ACCEPT}
                capture="environment"
                tabindex="-1"
                aria-hidden="true"
                on:change={onImageInput}
              />

              <MessagebarAttachments class="companion-image-drafts" role="group" aria-label={t("image.pending")}>
                {#each imageDrafts as draft (draft.id)}
                  <MessagebarAttachment class="companion-image-draft" deletable={false}>
                    {#snippet image()}
                      <button type="button" class="companion-image-draft-preview" aria-label={t("image.view", {name:draft.file.name || t("image.pending")})} on:click={() => showDraftLightbox(draft)}><img src={draft.previewUrl} alt={draft.file.name || t("image.pending")} /></button>
                    {/snippet}
                    <button type="button" class="button button-tonal button-round companion-image-draft-remove" aria-label={t("image.remove")} on:click={() => removeImage(draft)}><X size={16} aria-hidden="true" /></button>
                  </MessagebarAttachment>
                {/each}
              </MessagebarAttachments>
            {/snippet}
            {#snippet innerEnd()}
              <button
                class="button button-tonal button-round companion-microphone"
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
                {#if voiceStatus === "transcribing" || voiceStatus === "stopping"}<Preloader
                    class="preloader  "
                    aria-hidden="true"
                   />{:else if voiceStatus === "recording"}<Square size={16} fill="currentColor" aria-hidden="true" />{:else}<Mic
                    size={19}
                    strokeWidth={2}
                    aria-hidden="true"
                  />{/if}
              </button>
              <button
                class="button button-fill button-round companion-send"
                aria-label={t("message.send")}
                on:click={submit}
                disabled={voiceBusy || projection.canSubmit === false || composer.draft.trim().length > MAX_MESSAGE_LENGTH || (!composer.draft.trim() && imageDrafts.length === 0)}
              ><ArrowUp size={20} aria-hidden="true" /></button>

            {/snippet}
            {#snippet afterInner()}
              <div use:connectMessagebar={{ label: t("composer.label"), suggestions: !!commandSuggestion }}></div>
            {#if composer.draft.trim().length > MAX_MESSAGE_LENGTH}
              <div class="companion-voice-input-status companion-voice-input-error" role="alert">
                {t("message.tooLong", { limit: MAX_MESSAGE_LENGTH, count: composer.draft.trim().length })}
              </div>
            {/if}
            {#if voiceCapability === "unavailable" || !voiceCaptureAvailable}
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

            {/snippet}
          </Messagebar>
    {/if}
  {/snippet}
  <div class="companion-app" use:connectViewport>
    <div class="companion-content">
      <main class="companion-main" aria-label={t("chat.label")}>


        {#if effectiveWorkspaceReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <Preloader
              class="preloader  "
              aria-hidden="true"
             /><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveWorkspaceReadiness === "missing"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb  "
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.empty")}</h1>
            <p>{t("workspace.chooseHint")}</p>
            <a
              class="button button-fill"
              href="/"
              aria-label={t("workspace.settingsLabel")}
              on:click={() => dispatch("recovery")}>{t("settings.open")}</a
            >
          </section>
        {:else if effectiveWorkspaceReadiness === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb  "
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.failed")}</h1>
            <p>{t("workspace.reconnectHint")}</p>
            <button
              class="button button-fill"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else if effectiveRelationshipReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <Preloader
              class="preloader  "
              aria-hidden="true"
             /><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveRelationshipReadiness === "missing"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb  "
              aria-hidden="true"
            ></div>
            <h1>{t("workspace.empty")}</h1>
            <p>{t("workspace.chooseHint")}</p>
            <a
              class="button button-fill"
              href="/"
              aria-label={t("workspace.settingsLabel")}
              on:click={() => dispatch("recovery")}>{t("settings.open")}</a
            >
          </section>
        {:else if effectiveRelationshipReadiness === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb  "
              aria-hidden="true"
            ></div>
            <h1>{t("relationship.failed")}</h1>
            <p>{t("relationship.reconnectHint")}</p>
            <button
              class="button button-fill"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else if effectiveSessionReadiness === "loading"}
          <section
            class="companion-loading-shell"
            role="status"
            aria-label={t("loading.label")}
          >
            <Preloader
              class="preloader  "
              aria-hidden="true"
             /><span>{t("loading.progress")}</span>
          </section>
        {:else if effectiveSessionReadiness === "error" || projection.openState === "error"}
          <section class="companion-recovery" role="alert">
            <div
              class="companion-mood-orb  "
              aria-hidden="true"
            ></div>
            <h1>{t("session.failed")}</h1>
            <p>
              {t("session.reconnectHint")}
            </p>
            <button
              class="button button-fill"
              on:click={() => dispatch("recovery")}>{t("reconnect")}</button
            >
          </section>
        {:else}
          <div class="companion-timeline-region">
          {#if backgrounds}
            <div class="companion-chat-background" aria-hidden="true">
              <img class="companion-background-landscape" src={backgrounds.landscape} alt="" />
              <img class="companion-background-portrait" src={backgrounds.portrait} alt="" />
            </div>
          {/if}
          <PageContent messagesContent class={`companion-timeline ${timelineReady ? "timeline-ready" : ""}`} role="log" aria-live="polite" aria-relevant="additions text" onscroll={onScroll}>
            <div class="companion-timeline-content" use:connectTimeline>
            <Messages bind:this={messagesComponent} scrollMessages={false}>
              {#if displayedProjection.hasMore}
                <button
                  class="button button-tonal button-small"
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
                    class="companion-mood-orb  "
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
                  {#each parts as part, partIndex (part.kind === "images" ? part.items[0].id : part.item.id)}
                    {#snippet imageContent()}{#if part.kind === "images"}
                          <div class="companion-image-bubble companion-image-group" data-testid={`image-group-${unit.id}`}>
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
                                      class="skeleton-block companion-media-loading"
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
                                      use:longPress={{ run: node => showImageMenu(imageUrls[image.id] || image.previewUrl || "", image.alt || t("image.preview"), node) }}
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
                                        class="button button-tonal button-small"
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
                                    <Preloader
                                      class="preloader  companion-media-spinner"
                                      role="status"
                                      aria-label={t("loading.progress")}
                                     />
                                  {/if}
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}{/snippet}
                    {#snippet textContent()}{#if part.kind !== "images"}
                          {#if part.item.kind === "text"}
                            <div class="companion-text-bubble" use:longPress={{ run: node => showTextMenu(part.item as TimelineText, node) }}><Markdown text={part.item.text} /></div>
                          {:else if part.item.kind === "voice"}
                            {@const item = part.item}
                            {@const playback = voicePlayback[item.id] ?? EMPTY_VOICE_PLAYBACK}
                            <div class="companion-voice" role="region" aria-label={t("voice.player")}>
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
                                class="button button-tonal button-round companion-voice-control"
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
                        {/if}{/snippet}
                    {#snippet messageMetadata()}
                      {#if unit.time !== undefined}<time class="companion-message-time" datetime={messageTimeDateTime(unit.time)} data-testid={`message-time-${unit.id}`}>{formatMessageTime(unit.time)}</time>{/if}
                      {#if unit.pendingLabel}<div class="companion-meta" role="status">{unit.pendingLabel}</div>{/if}
                    {/snippet}
                    {#snippet messageSource()}
                        {#if partIndex === 0}
                          {#if unit.keet}<div class="companion-keet-source" data-testid={`keet-source-${unit.id}`}><span class="badge">Keet {unit.keet.kind === 'dm' ? 'DM' : 'Group'}</span><span>{unit.keet.senderLabel} · {unit.keet.destination}</span></div>
                          {:else if unit.alarm}<span class="badge companion-alarm-source">{t('alarm.source')}</span>{/if}
                        {/if}
                      {/snippet}
                    <Message header={partIndex === 0 && (unit.keet || unit.alarm) ? messageSource : undefined} footer={partIndex === parts.length - 1 && (unit.time !== undefined || unit.pendingLabel) ? messageMetadata : undefined} first={partIndex === 0} last={partIndex === parts.length - 1} tail={partIndex === parts.length - 1} type={unit.side === "incoming" ? "received" : "sent"} image={part.kind === "images" ? imageContent : undefined} text={part.kind !== "images" ? textContent : undefined}
                      class={`companion-row ${unit.side === "incoming" ? "incoming" : "outgoing"} ${unit.keet ? "companion-row-keet" : ""} ${unit.alarm ? "companion-row-alarm" : ""} ${unit.pending ? "companion-row-pending" : ""} ${part.kind === "images" ? "companion-image-message" : ""}`}
                      data-pending={unit.pending || undefined}
                      data-testid={partIndex === 0 ? unitTestId(unit) : undefined}>
                      {#snippet avatar()}
                      <div
                        class="companion-avatar-crop  "
                      >
                        {#if unit.keet}<span aria-hidden="true">K</span>{:else if unit.alarm}<AlarmClock size={16} aria-hidden="true" />{:else if unit.side === "incoming" && identity.companionAvatar}<img
                            src={identity.companionAvatar}
                            alt=""
                          />{:else if unit.side === "outgoing" && identity.userAvatar}<img
                            src={identity.userAvatar}
                            alt=""
                          />{:else}<span aria-hidden="true"
                            >{unit.side === "incoming" ? "✦" : t("you")}</span
                          >{/if}
                      </div>

                      {/snippet}


                    </Message>
                  {/each}
                {/if}
              {/each}
              {#if typingVisible}
                <Message type="received" first last tail typing class="companion-row incoming" data-testid="companion-typing-indicator" role="status" aria-label={t("status.namedTyping", {name: identity.companionName})} textFooter={waitingCopy ? t(waitingCopy) : undefined}>
                  {#snippet avatar()}
                    <div class="companion-avatar-crop">
                      {#if identity.companionAvatar}<img src={identity.companionAvatar} alt="" />{:else}<span aria-hidden="true">✦</span>{/if}
                    </div>
                  {/snippet}
                </Message>
              {/if}
            </Messages>
            </div>
          </PageContent>
          {#if !wasNearBottom && displayedProjection.items.length > 0}
            <button
              type="button"
              class="button button-tonal button-round companion-return-latest"
              aria-label={t("messages.latest")}
              title={t("messages.latest")}
              on:click={() => { composerInput?.blur(); returnToLatest(); }}
            ><ChevronDown size={22} aria-hidden="true" /></button>
          {/if}
          </div>

        {/if}
      </main>
    </div>

  </div>
    <Panel left cover swipe swipeOnlyClose opened={detailOpen} closeByBackdropClick={false}
      onPanelOpen={(args) => { relationshipDrawer = args[0].el; overlayOpening(args[0]); }}
      onPanelOpened={(args) => overlayOpened(args[0])}
      onPanelClosed={(args) => { finishDetailClose(); overlayClosed(args[0]); }}
      onPanelBackdropClick={() => closeDetail()}
      onkeydown={(event) => { if (event.key === "Escape") closeDetail(); }}
      id="companion-relationship-drawer"
      class="companion-history-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={t("relationship.named", { name: identity.companionName })}
      data-testid="companion-relationship-drawer"
    >
      <div class="companion-history-controls">
        <h2>{identity.companionName}</h2>
        <button
          type="button"
          class="button button-tonal button-round button-small"
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
          class="button"
          class:button-tonal={drawerTab === "history"}
          aria-label={t("drawer.history")}
          on:click={() => drawerTab = "history"}><Heart size={20} aria-hidden="true" /><span>{t("drawer.history")}</span></button
        >
        <button
          type="button"
          role="tab"
          id="companion-diary-tab"
          aria-controls="companion-drawer-panel"
          aria-selected={drawerTab === "diary"}
          class="button"
          class:button-tonal={drawerTab === "diary"}
          aria-label={t("drawer.diary")}
          on:click={() => void openDiary()}><BookOpen size={20} aria-hidden="true" /><span>{t("drawer.diary")}</span></button
        >
        <button type="button" role="tab" id="companion-images-tab" aria-controls="companion-drawer-panel" aria-selected={drawerTab === "images"} aria-label={t("drawer.images")} class="button" class:button-tonal={drawerTab === "images"} on:click={() => void openGallery()}><Images size={20} aria-hidden="true" /><span>{t("drawer.images")}</span></button>
        <button type="button" role="tab" id="companion-alarms-tab" aria-controls="companion-drawer-panel" aria-selected={drawerTab === "alarms"} aria-label={t('drawer.alarms')} class="button" class:button-tonal={drawerTab === "alarms"} on:click={() => void openAlarms()}><AlarmClock size={20} aria-hidden="true" /><span>{t("drawer.alarms")}</span></button>
      </div>
      <div
        id="companion-drawer-panel"
        class="companion-history-scroll"
        role="tabpanel"
        aria-labelledby={drawerTab === "history" ? "companion-history-tab" : drawerTab === "diary" ? "companion-diary-tab" : drawerTab === "images" ? "companion-images-tab" : "companion-alarms-tab"}
      >
        {#if drawerTab === 'alarms'}
          <AlarmDrawer {t} {locale} {alarms} loading={alarmsLoading} error={alarmsError} refresh={() => void openAlarms()} />
        {:else if drawerTab === "images"}
          <section class="companion-gallery" aria-label={t("drawer.images")}>
            {#if galleryError}<div class="companion-history-state" role="alert"><p>{t("gallery.failed")}</p><button type="button" class="button button-tonal button-small" on:click={() => void openGallery(true)}>{t("retry")}</button></div>
            {:else if galleryLoading && !galleryImages.length}<p class="companion-history-state" role="status">{t("loading")}</p>
            {:else if !galleryImages.length}<p class="companion-history-state">{t("gallery.empty")}</p>
            {:else}<div class="companion-gallery-toolbar"><span>{t("gallery.grouping")}</span><div class="segmented companion-gallery-grouping" role="group" aria-label={t("gallery.grouping")}><button type="button" class="button button-tonal button-small" class:button-active={galleryGrouping === "day"} aria-pressed={galleryGrouping === "day"} on:click={() => galleryGrouping = "day"}>{t("gallery.group.day")}</button><button type="button" class="button button-tonal button-small" class:button-active={galleryGrouping === "week"} aria-pressed={galleryGrouping === "week"} on:click={() => galleryGrouping = "week"}>{t("gallery.group.week")}</button></div></div><Gallery rows={galleryRowsValue} hasMore={!!galleryCursor} loading={galleryLoading} loadMore={() => openGallery(true)} pick={(image) => openLightbox({ id: image.id, alt: image.filename, previewUrl: image.url })} />{#if galleryLoading}<p class="companion-history-state" role="status">{t("loading")}</p>{/if}{/if}
          </section>
        {:else if drawerTab === "diary"}
          <section class="companion-diary">
            {#if diaryEntry}
              <button
                type="button"
                class="button button-tonal button-small companion-diary-back"
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
                <button type="button" class="button button-tonal button-small" on:click={() => void openDiary()}>{t("retry")}</button>
              </div>
            {:else if !diaryEntries.length}
              <p class="companion-history-state">{t("diary.empty")}</p>
            {:else}
              <div class="list companion-diary-list">
                {#each diaryEntries as entry}
                  <button type="button" class="button button-tonal companion-diary-list-entry" on:click={() => void openDiaryEntry(entry)}>
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
              <Preloader
                class="preloader  "
                aria-hidden="true"
               />
              <span>{t("history.loading")}</span>
            </div>
          {:else if history.status === "error"}
            <div class="companion-history-state" role="alert">
              <p>{t("history.failed")}</p>
              <button
                type="button"
                class="button button-tonal button-small"
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
                class="button button-tonal button-small companion-history-earlier"
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
    </Panel>
  {#if searchOpen}<ConversationSearch {t} {locale} companionName={identity.companionName} onClose={closeSearch} />{/if}
</Page>
<div class="companion-sr-only" aria-live="assertive">
  {typeof liveAnnouncement === "string"
    ? liveAnnouncement
    : t(liveAnnouncement.key, liveAnnouncement.params)}
</div>
