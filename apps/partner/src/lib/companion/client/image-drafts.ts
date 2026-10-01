import type { CompanionMessage } from "./locale.js";
import type {
  ImageAttachmentLimits,
  ImageMediaType,
} from "./contracts.js";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface CompanionImageDraft {
  id: string;
  file: File;
  previewUrl: string;
}

export interface ImagePromptPart {
  type: "image";
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

export interface CapturedImageMedia {
  webPath?: string;
  metadata?: { format?: string };
}

/** Validate a complete image addition before allocating any preview URLs. */
export function imageIntakeError(
  current: readonly CompanionImageDraft[],
  incoming: readonly File[],
  limits: ImageAttachmentLimits | undefined,
): CompanionMessage | undefined {
  if (incoming.length === 0) return undefined;
  if (!limits) return { key: "image.unavailable" };
  if (
    incoming.some(
      (file) =>
        !IMAGE_MEDIA_TYPES.has(file.type as ImageMediaType) ||
        !limits.mediaTypes.includes(file.type as ImageMediaType),
    )
  ) {
    return { key: "image.types" };
  }
  if (current.length + incoming.length > limits.maxImagesPerMessage)
    return {
      key: "image.countLimit",
      params: { count: limits.maxImagesPerMessage },
    };
  if (incoming.some((file) => file.size > limits.maxImageBytes))
    return { key: "image.tooLarge" };
  const total =
    current.reduce((sum, image) => sum + image.file.size, 0) +
    incoming.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.maxMessageImageBytes)
    return { key: "image.totalTooLarge" };
  return undefined;
}

export function createImageDrafts(
  files: readonly File[],
): CompanionImageDraft[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    previewUrl: URL.createObjectURL(file),
  }));
}

export function releaseImageDrafts(
  drafts: readonly CompanionImageDraft[],
): void {
  for (const draft of drafts)
    if (draft.previewUrl.startsWith("blob:"))
      URL.revokeObjectURL(draft.previewUrl);
}

/** Preserve the clipboard's image order while leaving ordinary text paste alone. */
export function imageFilesFromClipboard(
  clipboard: Pick<DataTransfer, "items" | "files"> | null,
): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  for (let index = 0; index < clipboard.items.length; index += 1) {
    const item = clipboard.items[index]!;
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length > 0) return files;
  return Array.from(clipboard.files).filter((file) =>
    file.type.startsWith("image/"),
  );
}

/** Fetch a Capacitor camera result into the same File shape used by every image intake path. */
export async function imageFileFromCapturedMedia(
  media: CapturedImageMedia,
  fetchMedia: typeof fetch = fetch,
): Promise<File> {
  const url = media.webPath;
  if (!url) throw new Error("camera-media-missing-url");
  try {
    const response = await fetchMedia(url);
    if (!response.ok) throw new Error("camera-media-fetch-failed");
    const blob = await response.blob();
    const type =
      imageMediaType(blob.type) ??
      imageMediaType(media.metadata?.format) ??
      imageMediaType(url);
    if (!type) throw new Error("camera-media-unsupported-type");
    const extension = type.slice("image/".length);
    return new File([blob], `camera-photo.${extension}`, { type });
  } finally {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

export async function serializeImageDrafts(
  drafts: readonly CompanionImageDraft[],
): Promise<ImagePromptPart[]> {
  return Promise.all(
    drafts.map(async (draft) => ({
      type: "image" as const,
      mediaType: draft.file.type as ImageMediaType,
      data: await base64Of(draft.file),
      ...(draft.file.name ? { name: draft.file.name } : {}),
    })),
  );
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      if (separator < 0) {
        reject(new Error("image-read-failed"));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("image-read-failed"));
    reader.readAsDataURL(file);
  });
}

function imageMediaType(value: string | undefined): ImageMediaType | undefined {
  const normalized = value?.trim().toLowerCase().replace(/^\./u, "");
  if (!normalized) return undefined;
  if (
    normalized === "jpg" ||
    normalized === "jpeg" ||
    normalized === "image/jpg" ||
    normalized === "image/jpeg"
  )
    return "image/jpeg";
  if (normalized === "png" || normalized === "image/png") return "image/png";
  if (normalized === "webp" || normalized === "image/webp") return "image/webp";
  if (normalized === "gif" || normalized === "image/gif") return "image/gif";
  return undefined;
}
