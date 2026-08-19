/**
 * Deterministic identity derivation for fenced code blocks.
 *
 * Task 10.4 (enhanced-chat-ui) — a fenced code block's canonical
 * identity is a pure function of three source-of-truth values:
 *
 *   - `responseId`               — the assistant response group the fence
 *                                  belongs to. Stable across replays of
 *                                  the same response.
 *   - `narrativeBlockStableKey`  — the stable key of the narrative block
 *                                  that contains the fence. Derived
 *                                  upstream from the projection layer and
 *                                  itself deterministic.
 *   - `fenceIndex`               — the 0-based ordinal position of the
 *                                  fence inside its narrative block.
 *
 * The identity **never** uses a monotonic counter, wall-clock time, a
 * random source, or content hashes. Same inputs always produce the same
 * output. Different inputs produce different outputs.
 *
 * The output format is a URL-safe concatenation. `encodeURIComponent` is
 * used to escape delimiter and reserved characters so no combination of
 * inputs can collide by injecting a `/`, `:`, or similar into a component.
 *
 * The identity is short enough for DOM `id`/`data-*` use, human-readable
 * for debugging, and stable enough to serve as the reconciliation key
 * across streaming and finalized renders (task 10.3 / 10.4 / 15.6).
 *
 * Requirements: 10.7, 10.9, 15.6, 15.7
 *
 * @module src/renderer/structured-response/code-identity
 */

/**
 * Inputs to {@link deriveCodeIdentity}.
 *
 * All three fields are required and must be non-empty. Callers should
 * pass the response-group identifier, the narrative block's stable key,
 * and the 0-based fence ordinal.
 */
export interface CodeIdentityInputs {
  /** Assistant response group identifier. Non-empty string. */
  readonly responseId: string;
  /** Stable key of the containing narrative block. Non-empty string. */
  readonly narrativeBlockStableKey: string;
  /** 0-based fence ordinal within the narrative block. Non-negative integer. */
  readonly fenceIndex: number;
}

/**
 * Derive a deterministic, human-readable identity for a fenced code block.
 *
 * The output has the form
 *
 *   `code/${encodedResponseId}/${encodedNarrativeKey}/${fenceIndex}`
 *
 * where each string component is URL-encoded so no combination of inputs
 * can collide via delimiter injection. The `code/` prefix distinguishes
 * this identity from other stable-key namespaces used elsewhere in the
 * renderer (`narrative/`, `tool/`, etc.).
 *
 * The function is a pure computation — no timers, no counters, no
 * randomness. Rendering the same fence twice always produces the same
 * identity, which is what the reconciliation and diagnostics layers
 * require to update a block in place instead of remounting it.
 *
 * @throws {TypeError} if any input is missing or the wrong type.
 * @throws {RangeError} if `fenceIndex` is negative or not an integer.
 */
export function deriveCodeIdentity(inputs: CodeIdentityInputs): string {
  if (inputs === null || typeof inputs !== 'object') {
    throw new TypeError('deriveCodeIdentity: inputs must be an object');
  }

  const { responseId, narrativeBlockStableKey, fenceIndex } = inputs;

  if (typeof responseId !== 'string' || responseId.length === 0) {
    throw new TypeError('deriveCodeIdentity: responseId must be a non-empty string');
  }
  if (typeof narrativeBlockStableKey !== 'string' || narrativeBlockStableKey.length === 0) {
    throw new TypeError(
      'deriveCodeIdentity: narrativeBlockStableKey must be a non-empty string',
    );
  }
  if (typeof fenceIndex !== 'number' || !Number.isFinite(fenceIndex)) {
    throw new TypeError('deriveCodeIdentity: fenceIndex must be a finite number');
  }
  if (!Number.isInteger(fenceIndex) || fenceIndex < 0) {
    throw new RangeError('deriveCodeIdentity: fenceIndex must be a non-negative integer');
  }

  const encodedResponseId = encodeURIComponent(responseId);
  const encodedNarrativeKey = encodeURIComponent(narrativeBlockStableKey);
  return `code/${encodedResponseId}/${encodedNarrativeKey}/${fenceIndex}`;
}
