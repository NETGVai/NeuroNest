/**
 * Image Preprocessor — Downscales images to fit within the Vision Analyzer's
 * maximum dimension constraints while preserving aspect ratio.
 *
 * The Vision Analyzer processes images up to 4096x4096 pixels. Images exceeding
 * this limit in either dimension are proportionally downscaled.
 *
 * Requirements: 6.5
 */

export const MAX_DIMENSION = 4096;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Compute the target dimensions for an image such that:
 * - Neither width nor height exceeds MAX_DIMENSION (4096px)
 * - Aspect ratio is preserved (within 1px rounding tolerance)
 * - If already within bounds, dimensions are returned unchanged
 */
export function computeDownscaledDimensions(
  width: number,
  height: number,
  maxDimension: number = MAX_DIMENSION,
): ImageDimensions {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width}x${height}`);
  }

  // Already within bounds
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }

  // Scale factor: use the larger dimension to determine the ratio
  const scaleFactor = maxDimension / Math.max(width, height);

  const newWidth = Math.round(width * scaleFactor);
  const newHeight = Math.round(height * scaleFactor);

  return {
    width: Math.max(1, newWidth),
    height: Math.max(1, newHeight),
  };
}

/**
 * Preprocess an image buffer by downscaling if dimensions exceed maxDimension.
 * 
 * This performs a simple nearest-neighbor downscale on raw RGBA pixel data.
 * In production with a full image library, this would use bilinear/bicubic
 * interpolation. For the ONNX model pipeline, we work with raw pixel buffers.
 *
 * @param pixelData - Raw RGBA pixel buffer (4 bytes per pixel)
 * @param width - Current image width
 * @param height - Current image height
 * @param maxDimension - Maximum allowed dimension (default 4096)
 * @returns Preprocessed image data with new dimensions
 */
export function preprocessImage(
  pixelData: Buffer,
  width: number,
  height: number,
  maxDimension: number = MAX_DIMENSION,
): { data: Buffer; width: number; height: number } {
  const expectedSize = width * height * 4;
  if (pixelData.length < expectedSize) {
    throw new Error(
      `Pixel data buffer too small: expected ${expectedSize} bytes for ${width}x${height} RGBA, got ${pixelData.length}`,
    );
  }

  const target = computeDownscaledDimensions(width, height, maxDimension);

  // No resize needed
  if (target.width === width && target.height === height) {
    return { data: pixelData, width, height };
  }

  // Nearest-neighbor downscale
  const outputBuffer = Buffer.alloc(target.width * target.height * 4);

  for (let y = 0; y < target.height; y++) {
    const srcY = Math.min(Math.floor((y * height) / target.height), height - 1);
    for (let x = 0; x < target.width; x++) {
      const srcX = Math.min(Math.floor((x * width) / target.width), width - 1);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * target.width + x) * 4;

      outputBuffer[dstIdx] = pixelData[srcIdx]!;
      outputBuffer[dstIdx + 1] = pixelData[srcIdx + 1]!;
      outputBuffer[dstIdx + 2] = pixelData[srcIdx + 2]!;
      outputBuffer[dstIdx + 3] = pixelData[srcIdx + 3]!;
    }
  }

  return { data: outputBuffer, width: target.width, height: target.height };
}
