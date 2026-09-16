import type { CompanionTranslate } from "./locale.js";
import type { CompanionProjection } from "../projection.js";
import type {
  CompanionContinuitySnapshot,
  ContextPressureProjection,
} from "../continuity.js";
import type { ImageAttachmentLimits } from "./contracts.js";
import type { CompanionImageDraft } from "./image-drafts.js";
import type { PendingSubmissionRetirement } from "./contracts.js";
import type { CompanionReadiness } from "./readiness.js";
import type { CompanionStateRecord } from "../domain.js";
import type {
  CompanionVoiceTranscription,
  VoiceRecording,
} from "./voice-input.js";

export interface CompanionIdentityView {
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
export interface CompanionActions {
  send: (
    text: string,
    images: readonly CompanionImageDraft[],
    onRetire?: (retirement: PendingSubmissionRetirement) => void,
  ) => Promise<void>;
  stop?: () => Promise<void>;
  loadOlder?: () => Promise<void>;
  attachmentUrl?: (attachment: unknown) => Promise<string>;
  /** Authenticated Companion Host transcription; recording bytes never enter Session attachments. */
  transcribeVoice?: (
    recording: VoiceRecording,
    signal?: AbortSignal,
  ) => Promise<CompanionVoiceTranscription>;
  loadEarlierHistory?: () => Promise<void>;
  retryHistory?: () => void;
}
export interface CompanionSessionView {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  selected: boolean;
}

export interface CompanionContinuityView {
  /** Host-projected context pressure; absent means the meter is unavailable. */
  contextPressure?: ContextPressureProjection;
  /** Session-scoped compaction lifecycle facts from the public view registry. */
  lifecycle?: CompanionContinuitySnapshot;
}

/** A retained Keet replay interval that could not be recovered. */
export interface KeetLossRange {
  first: number;
  last: number;
}

export interface CompanionRecoveredDraft {
  key: string;
  sourceIds: readonly string[];
  input: string;
  images: readonly { id: string; name: string; url: string }[];
}

export interface CompanionHistoryView {
  status: "loading" | "ready" | "error";
  sourceWorkspaceId?: string;
  records: readonly CompanionStateRecord[];
  hasEarlier: boolean;
  nextBefore?: number;
  predecessor?: CompanionStateRecord;
  loadingEarlier?: boolean;
}

export interface CompanionBridgeProps {
  t?: CompanionTranslate;
  locale?: string;
  projection: CompanionProjection;
  identity: CompanionIdentityView;
  scheme: "light" | "dark";
  actions: CompanionActions;
  sessions: CompanionSessionView[];
  /** Explicit presentation lifecycle; unknown data remains neutral until settled. */
  workspaceReadiness: CompanionReadiness;
  sessionReadiness: CompanionReadiness;
  relationshipReadiness: CompanionReadiness;
  /** Browser-only draft images must not cross an active Session switch. */
  sessionId?: string;
  /** Host-advertised image capability and intake limits; absent means unavailable. */
  imageLimits?: ImageAttachmentLimits;
  /** Optional DSH Speech capability observed by the Host RPC. */
  voiceCapability?: "loading" | "available" | "unavailable";
  continuity?: CompanionContinuityView;
  /** Persisted Keet replay intervals that require operator recovery awareness. */
  keetLosses?: readonly KeetLossRange[];
  recoveredDraft?: CompanionRecoveredDraft;
  history?: CompanionHistoryView;
  onHistoryOpenChange?: (open: boolean) => void;
  onAdvanced?: () => void;
  onRecovery?: () => void;
}
