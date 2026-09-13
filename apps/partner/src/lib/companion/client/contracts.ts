export type PendingSubmissionRetirement = { reason: "observed" | "failed" };
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export interface ImageAttachmentLimits { mediaTypes: readonly ImageMediaType[]; maxImagesPerMessage: number; maxImageBytes: number; maxMessageImageBytes: number; }
export interface ImageAttachmentRef { attachmentId: string; mediaType: ImageMediaType; name?: string; width?: number; height?: number; }
