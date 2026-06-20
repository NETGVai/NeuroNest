/**
 * Visual Diff — Pixel-level image comparison for detecting visual differences.
 *
 * Computes similarity percentage, identifies differing regions with bounding boxes,
 * and classifies whether images are "visually different" based on a threshold.
 *
 * Key properties:
 * - Comparing image A with itself yields 100% similarity and zero diff regions
 * - Similarity is symmetric: compare(A, B) === compare(B, A)
 * - isVisuallyDifferent = true iff (100 - similarityPercent) > threshold
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import type { VisualDiffResult } from '../shared/feature-integration-types.js';

export const DEFAULT_THRESHOLD = 5;

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

/**
 * Compare two images at the pixel level.
 *
 * @param imageA - Raw RGBA pixel buffer for image A
 * @param widthA - Width of image A
 * @param heightA - Height of image A
 * @param imageB - Raw RGBA pixel buffer for image B
 * @param widthB - Width of image B
 * @param heightB - Height of image B
 * @param threshold - Percentage threshold for classifying as "visually different" (default 5%)
 * @returns Visual diff result with similarity percentage and diff regions
 */
export function comparePixelData(
  imageA: Buffer,
  widthA: number,
  heightA: number,
  imageB: Buffer,
  widthB: number,
  heightB: number,
  threshold: number = DEFAULT_THRESHOLD,
): VisualDiffResult {
  // If dimensions differ, compare over the common area and count
  // non-overlapping pixels as different
  const maxWidth = Math.max(widthA, widthB);
  const maxHeight = Math.max(heightA, heightB);
  const totalPixels = maxWidth * maxHeight;

  if (totalPixels === 0) {
    return {
      similarityPercent: 100,
      diffRegions: [],
      isVisuallyDifferent: false,
    };
  }

  // Build a boolean diff map over the max dimensions
  const diffMap = new Uint8Array(maxWidth * maxHeight);
  let differentPixelCount = 0;

  for (let y = 0; y < maxHeight; y++) {
    for (let x = 0; x < maxWidth; x++) {
      const inA = x < widthA && y < heightA;
      const inB = x < widthB && y < heightB;

      if (!inA || !inB) {
        // Pixel exists in one image but not the other
        diffMap[y * maxWidth + x] = 1;
        differentPixelCount++;
        continue;
      }

      const idxA = (y * widthA + x) * 4;
      const idxB = (y * widthB + x) * 4;

      // Compare RGB channels (ignore alpha for visual comparison)
      const dr = Math.abs((imageA[idxA] ?? 0) - (imageB[idxB] ?? 0));
      const dg = Math.abs((imageA[idxA + 1] ?? 0) - (imageB[idxB + 1] ?? 0));
      const db = Math.abs((imageA[idxA + 2] ?? 0) - (imageB[idxB + 2] ?? 0));

      // A pixel is considered different if any channel differs by more than a small tolerance
      const pixelDiffThreshold = 2;
      if (dr > pixelDiffThreshold || dg > pixelDiffThreshold || db > pixelDiffThreshold) {
        diffMap[y * maxWidth + x] = 1;
        differentPixelCount++;
      }
    }
  }

  const similarityPercent = ((totalPixels - differentPixelCount) / totalPixels) * 100;

  // Extract connected regions of difference using flood-fill
  const diffRegions = extractDiffRegions(diffMap, maxWidth, maxHeight);

  // Threshold classification: isVisuallyDifferent iff (100 - similarity) > threshold
  const isVisuallyDifferent = (100 - similarityPercent) > threshold;

  return {
    similarityPercent,
    diffRegions,
    isVisuallyDifferent,
  };
}

/**
 * Extract bounding boxes around connected regions of difference.
 * Uses a simple scan-line approach to find contiguous diff regions.
 */
function extractDiffRegions(
  diffMap: Uint8Array,
  width: number,
  height: number,
): DiffRegion[] {
  const visited = new Uint8Array(width * height);
  const regions: DiffRegion[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (diffMap[idx] === 1 && visited[idx] === 0) {
        // Found an unvisited diff pixel — flood fill to find region bounds
        const bounds = floodFillBounds(diffMap, visited, width, height, x, y);
        regions.push(bounds);
      }
    }
  }

  return regions;
}

/**
 * Flood-fill from a starting diff pixel to compute the bounding box of the region.
 */
function floodFillBounds(
  diffMap: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
): DiffRegion {
  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  // BFS flood fill
  const queue: Array<[number, number]> = [[startX, startY]];
  visited[startY * width + startX] = 1;

  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;

    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);

    // Check 4-connected neighbors
    const neighbors: Array<[number, number]> = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];

    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (diffMap[nIdx] === 1 && visited[nIdx] === 0) {
        visited[nIdx] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  const regionWidth = maxX - minX + 1;
  const regionHeight = maxY - minY + 1;

  return {
    x: minX,
    y: minY,
    width: regionWidth,
    height: regionHeight,
    area: regionWidth * regionHeight,
  };
}

/**
 * Determine if images are visually different based on similarity and threshold.
 * This is a pure function that implements the threshold classification logic.
 *
 * isVisuallyDifferent = true iff (100 - similarityPercent) > threshold
 */
export function classifyVisualDifference(
  similarityPercent: number,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  return (100 - similarityPercent) > threshold;
}
