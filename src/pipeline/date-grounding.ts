/**
 * Date_Grounding_Preamble (Feature 5)
 *
 * Provides a small helper that grounds the LLM in the real current date so
 * that query-generation prompts stop emitting queries with a year inferred
 * from the model's training cutoff.
 */

/**
 * Returns a preamble grounding the LLM in the current date.
 *
 * The function is pure given a frozen clock: callers may inject a fixed
 * `Date` (e.g. in tests) to obtain byte-identical output for the same input.
 * When `now` is omitted it defaults to the current system time.
 *
 * @param now - The reference date. Defaults to `new Date()`.
 * @returns A preamble string containing the current date (`YYYY-MM-DD`), the
 *   4-digit year, and instructions to ground "latest"/"current"/"this year"
 *   references in that year. Terminated with a blank line so it can be
 *   prepended directly to an existing prompt.
 *
 * Validates: Requirement 32
 */
export function currentDateContext(now: Date = new Date()): string {
  const year = now.getFullYear().toString();
  const date = now.toISOString().split('T')[0];
  return (
    `Today's date is ${date}. The current year is ${year}. ` +
    `When a search query needs a year or refers to "latest"/"current"/` +
    `"this year", use ${year} or relative wording — never a year inferred ` +
    `from training data.\n\n`
  );
}
