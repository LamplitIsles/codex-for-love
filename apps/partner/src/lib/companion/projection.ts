import type { ImageAttachmentRef } from "./client/contracts.js";
import type { ContinuityRecord } from "./continuity.js";
export type MessageSide = "incoming" | "outgoing";

export interface TimelineText {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "text";
  side: MessageSide;
  /** Durable source kind used by the Chat target. */
  origin?: "user" | "steering";
  text: string;
  pending?: boolean;
  /** Whether this submission was admitted while an earlier reply was active. */
  waitsForCurrentReply?: boolean;
  time?: number;
  replyTo?: string;
}

export interface TimelineImage {
  id: string;
  /** Stable source key used when a durable ImageGen call settles into its attachment. */
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "image";
  side: MessageSide;
  /** Durable source kind used by the Chat target. */
  origin?: "user" | "steering";
  state: "loading" | "ready" | "failed" | "running";
  attachment?: ImageAttachmentRef;
  /** Page-local preview owned by the Session submission controller. */
  previewUrl?: string;
  alt: string;
  error?: string;
  time?: number;
}

export interface TimelineVoice {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "voice";
  side: "incoming";
  text: string;
  status: "preparing";
  time?: number;
}

export interface TimelineNotice {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key; notices normally remain standalone. */
  messageKey: string;
  kind: "notice";
  side: "incoming";
  tone: "info" | "error";
  text: string;
  time?: number;
}

/** A quiet, durable completion marker for automatic conversation organization. */
export interface TimelineContinuityRecord extends ContinuityRecord {}

export type TimelineItem =
  | TimelineText
  | TimelineImage
  | TimelineVoice
  | TimelineNotice
  | TimelineContinuityRecord;

/** One speaker contribution as presented in the Companion transcript. */
export interface TimelineMessageUnit {
  /** Stable render identity. */
  id: string;
  side: MessageSide;
  /** Source-order content; consecutive images are collapsed by the view. */
  items: readonly TimelineItem[];
  pending?: boolean;
  pendingLabel?: string;
  origin?: "user" | "steering";
  time?: number;
}

export interface CompanionProjection {
  items: readonly TimelineItem[];
  /** Canonical grouped presentation projection for the Companion transcript. */
  messageUnits: readonly TimelineMessageUnit[];
  pendingCount: number;
  running: boolean;
  status: "ready" | "working" | "reconnecting";
  openState: "cold" | "loading" | "open" | "error";
  hasMore: boolean;
  loadingOlder: boolean;
  promptError?: string;
  /** Stable identity for a prompt result, used to distinguish a new rejection. */
  promptErrorKey?: string;
  /** Original prompt operation, when the runtime provides it. */
  promptErrorOp?: string;
  /** Public prompt error code, retained so admission failures can be distinguished from carrier internals. */
  promptErrorCode?: string;
  lastAgentError?: string;
}
