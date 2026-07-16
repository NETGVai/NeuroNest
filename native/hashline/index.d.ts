/**
 * @neuronest/native-hashline TypeScript declarations.
 *
 * Provides content-addressed line hashing using xxhash and anchor lookup
 * for the anchored_edit tool.
 */

/**
 * Result of an anchor lookup operation.
 */
export interface AnchorResult {
  /**
   * The offset (line index) in the file hashes where the best match starts.
   * -1 if no match with sufficient confidence was found.
   */
  offset: number;
  /**
   * Confidence score: ratio of matching hashes to total target hashes.
   * Range: 0.0 to 1.0
   */
  confidence: number;
}

/**
 * Compute per-line xxhash32 hashes for the given source buffer.
 *
 * Splits the source by newline characters and hashes each line (without
 * the trailing newline). Returns a Uint32Array with one hash per line.
 *
 * Performance target: ≤2ms for a 10k-line file.
 *
 * @param source - The file content as a Buffer
 * @returns Uint32Array of xxh32 hashes, one per line
 */
export function computeLineHashes(source: Buffer): Uint32Array;

/**
 * Find the best position of a target hash sequence within the file hashes.
 *
 * Uses a sliding window approach:
 * 1. Slides the target window over all positions in the file hashes
 * 2. At each position, counts how many hashes match
 * 3. Returns the position with the highest match count and confidence score
 * 4. If no position achieves confidence > 0.5, returns offset -1 (not found)
 *
 * @param hashes - The full file's per-line hashes (from computeLineHashes)
 * @param target - The target line hashes to locate within the file
 * @returns AnchorResult with offset and confidence
 */
export function anchorLookup(hashes: Uint32Array, target: Uint32Array): AnchorResult;

/** Whether the native hashline module loaded successfully */
export const __notSupported: boolean | undefined;

/** Load error message if the module failed to load */
export const loadError: string | undefined;
