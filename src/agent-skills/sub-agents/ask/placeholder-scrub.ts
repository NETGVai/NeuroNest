//
// Pure post-processor for the AskSubAgent's final tool-result string.
// Detects banned placeholder tokens (e.g. "<TODO>", "<your-value-here>",
// "{{ todo }}", "...placeholder...", "<INSERT …>") and rejects the
// response with a structured error so the chat command dispatcher can
// retry once with a placeholder-explicit reminder before surfacing an
// inline error message.
//
// Implementation contract (design § Item 2):
//   - BANNED_PLACEHOLDERS: frozen ReadonlyArray<RegExp>, case-insensitive,
//     matching the five patterns enumerated in the design.
//   - PlaceholderScrub.check(text) is a pure function — no I/O, no
//     logging, no module-level side effects. The only "side effect"
//     is the offending substring returned inside the result object.
//
// Validates: Requirements 2.6

/**
 * Frozen list of regular expressions identifying banned placeholder
 * tokens. The order is fixed and matches the design ordering — the
 * first pattern that matches wins for the purposes of `offendingMatch`,
 * which keeps the function deterministic across runs and inputs.
 *
 * Patterns:
 *   1. `<TODO ...>`            — generic TODO tag, optional attributes.
 *   2. `<your-...-here>`       — "fill-me-in" placeholder convention.
 *   3. `{{ todo }}`            — Mustache/Handlebars-style placeholder.
 *   4. `...placeholder...`     — bare ellipsis-wrapped placeholder.
 *   5. `<INSERT ...>`          — INSERT-style scaffold tag, with the
 *                                separator restricted to whitespace,
 *                                hyphen, or underscore.
 */
export const BANNED_PLACEHOLDERS: ReadonlyArray<RegExp> = Object.freeze([
  /<TODO[^>]*>/i,
  /<your-[^>]+-here>/i,
  /\{\{\s*todo\s*\}\}/i,
  /\.\.\.placeholder\.\.\./i,
  /<INSERT[\s_-][^>]+>/i,
]);

/**
 * Result of a placeholder check. Either `{ ok: true }` when the input
 * is clean, or `{ ok: false; offendingMatch }` carrying the exact
 * substring that triggered the rejection. The offending substring is
 * the matched text from the first (lowest-index) banned pattern.
 */
export type PlaceholderScrubResult =
  | { ok: true }
  | { ok: false; offendingMatch: string };

/**
 * Pure namespace exposing `check`. Declared as an `interface` in the
 * design so that the runtime export below can satisfy a structural
 * contract; consumers may import either the namespace value
 * (`PlaceholderScrub.check(...)`) or the type (for stub/mocking).
 */
export interface PlaceholderScrub {
  check(text: string): PlaceholderScrubResult;
}

/**
 * Pure check: returns `{ ok: true }` if `text` contains no banned
 * placeholder token, or `{ ok: false; offendingMatch }` with the
 * exact matched substring from the first triggering pattern.
 *
 * Pure — no I/O, no logging, no global state mutation. Two calls with
 * the same input return structurally-equal results.
 */
function check(text: string): PlaceholderScrubResult {
  // Iterating the frozen array directly (rather than using
  // .find/.some) keeps the hot path allocation-free and preserves
  // first-match-wins ordering across the five patterns.
  for (let i = 0; i < BANNED_PLACEHOLDERS.length; i++) {
    const pattern = BANNED_PLACEHOLDERS[i];
    // Defensive guard: the array is frozen, but `noUncheckedIndexedAccess`
    // forces us to widen the type. The loop bound makes this safe.
    if (pattern === undefined) continue;
    const match = pattern.exec(text);
    if (match !== null) {
      return { ok: false, offendingMatch: match[0] };
    }
  }
  return { ok: true };
}

/**
 * Frozen runtime export. `PlaceholderScrub.check(text)` is the
 * supported call site referenced by the design and the
 * AskSlashCommand dispatcher (Item 2, Task 3.3).
 */
export const PlaceholderScrub: PlaceholderScrub = Object.freeze({ check });
