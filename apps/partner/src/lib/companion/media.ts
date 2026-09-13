export interface ImageDisplaySize {
  /** CSS-pixel width of the ordinary in-conversation image box. */
  width: number;
  /** CSS-pixel height of the ordinary in-conversation image box. */
  height: number;
  /** The source aspect ratio before the ordinary-display clamp. */
  sourceAspectRatio?: number;
  /** True when an extreme source ratio requires intentional cover cropping. */
  cropped: boolean;
}

/**
 * Translate an intrinsic image size into the official ordinary-display shape.
 * The long edge is bounded, small images are never upscaled, and only extreme
 * aspect ratios are widened/narrowed into the scan-friendly [0.25, 4] range.
 */
export function resolveImageDisplaySize(
  width: number | undefined,
  height: number | undefined,
  maxLongEdge = 240,
): ImageDisplaySize {
  const validWidth =
    typeof width === "number" && Number.isFinite(width) && width > 0;
  const validHeight =
    typeof height === "number" && Number.isFinite(height) && height > 0;
  const cap =
    Number.isFinite(maxLongEdge) && maxLongEdge > 0 ? maxLongEdge : 240;
  if (!validWidth || !validHeight)
    return { width: cap, height: Math.round(cap * 0.75), cropped: false };

  const sourceWidth = width!;
  const sourceHeight = height!;
  const sourceAspectRatio = sourceWidth / sourceHeight;
  const scale = Math.min(1, cap / Math.max(sourceWidth, sourceHeight));
  let displayWidth = Math.max(1, Math.round(sourceWidth * scale));
  let displayHeight = Math.max(1, Math.round(sourceHeight * scale));
  let cropped = false;
  const ratio = displayWidth / displayHeight;
  if (ratio < 0.25) {
    displayWidth = Math.max(1, Math.round(displayHeight * 0.25));
    cropped = true;
  } else if (ratio > 4) {
    displayHeight = Math.max(1, Math.round(displayWidth / 4));
    cropped = true;
  }
  return {
    width: displayWidth,
    height: displayHeight,
    sourceAspectRatio,
    cropped,
  };
}
