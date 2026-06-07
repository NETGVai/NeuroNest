// File: packages/neuronest-cli/src/sync/cache-serializer.ts
//
// Byte-stable serializer for the Skill_Type_Bundle cache artifact
// (`.neuronest-types.json`). The output is the canonical UTF-8 string
// the SyncCli writes to disk (Item 1, task 1.6).
//
// Stability contract (Req 1.5):
//   1. Top-level keys are emitted in fixed order: schemaVersion, skills.
//   2. `skills[]` is sorted ascending by `id` using a pure lexicographic
//      (code-point) comparator — no `localeCompare`, so collation does
//      not depend on the host's ICU data.
//   3. Every nested object's keys are sorted alphabetically (also pure
//      code-point order). This applies recursively through skill
//      entries, `metadata`, `inputSchema`, `outputSchema`, and
//      `paramDocs`, so arbitrary JSON-Schema shapes serialize
//      deterministically.
//   4. Indentation is exactly 2 spaces; line endings are LF regardless
//      of host (Windows JSON.stringify already emits `\n`, but we
//      defensively normalize any stray `\r\n` / `\r`).
//   5. Exactly one trailing LF.
//
// No-metadata-leak contract (Req 1.2):
//   The function consumes only `SkillTypeBundle['cache']` — a structural
//   type containing `schemaVersion` and `skills`. No timestamps,
//   machine identifiers, host paths, or generation dates can be
//   introduced here; pre-normalization of `relPath` to `~/…` form (for
//   user skills) or workspace-relative form (for workspace skills) is
//   the scanner's responsibility (task 1.5).
//
// Validates: Requirements 1.2, 1.5.

import type { SkillTypeBundle } from './types.js';

/**
 * Serialize a Skill_Type_Bundle cache to its canonical, byte-stable
 * UTF-8 string form.
 *
 * Two consecutive calls with structurally equal input MUST produce
 * byte-identical output, regardless of the input's key insertion order
 * or the host operating system.
 */
export function serializeCache(cache: SkillTypeBundle['cache']): string {
  // 1. Sort skills ascending by `id` using a pure code-point comparator.
  const sortedSkills = [...cache.skills]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((entry) => deepSortKeys(entry));

  // 2. Build the top-level object in fixed key order. V8 preserves
  //    insertion order for string keys, so JSON.stringify emits
  //    `schemaVersion` before `skills`.
  const normalized = {
    schemaVersion: cache.schemaVersion,
    skills: sortedSkills,
  };

  // 3. JSON.stringify with 2-space indent. Per the JSON spec the only
  //    line separator emitted is `\n`, but normalize defensively so the
  //    LF guarantee holds even if a caller has injected CR characters
  //    into a string field.
  const json = JSON.stringify(normalized, null, 2);
  const lfOnly = json.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 4. Exactly one trailing LF.
  return `${lfOnly}\n`;
}

/**
 * Recursively rebuilds an object with its own keys sorted by Unicode
 * code-point order, leaving arrays in their existing order (skill
 * ordering is handled at the caller; inner arrays are JSON-Schema
 * sub-structures whose order is meaningful).
 *
 * `undefined` values inside objects are dropped to match
 * `JSON.stringify`'s behavior — keeping them would produce a key with
 * no value once stringified, breaking the "keys present after sort"
 * invariant.
 */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort(compareCodePoints);
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const child = source[key];
      if (child === undefined) {
        continue;
      }
      result[key] = deepSortKeys(child);
    }
    return result;
  }
  return value;
}

/**
 * Lexicographic comparator over UTF-16 code units (the same ordering
 * `Array.prototype.sort` uses by default for strings). Pure: result is
 * a function of the two inputs only and does not consult any host
 * locale or ICU table.
 */
function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
