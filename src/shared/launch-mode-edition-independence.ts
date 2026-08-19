/**
 * Launch-mode and edition independence enforcement.
 *
 * This module locks in the invariant from Requirement 4 and Property 1/5 of
 * the enhanced-chat-ui spec: `Launch_Mode` (`classic` | `advanced`) and
 * `Edition` (`community` | `professional` | `enterprise`) are independent
 * axes. All six `(LaunchMode, Edition)` combinations must use identical
 * project, conversation, provider, and route services. Launch mode must
 * never become an input to entitlement resolution, credential lifecycle,
 * routing, or the Mode Selector's option list.
 *
 * Contents:
 *
 * 1. Closed tuples/unions of every supported launch mode and edition value.
 * 2. The exhaustive `(LaunchMode, Edition)` combination product, frozen for
 *    use by tests and services that must iterate every combination.
 * 3. Compile-time guards (`type` helpers) that reject any input record whose
 *    keys look like a launch-mode carrier. Adding a `launchMode` field to
 *    an entitlement, routing, or credential input type produces a TypeScript
 *    error at the call site.
 * 4. Runtime guards that reject launch-mode-shaped payload keys at the
 *    entitlement/route/credential boundary. Defense in depth for callers
 *    whose shapes are only known at runtime (e.g. plain JSON bridges).
 * 5. An `editionOnly` projection helper that returns the edition axis alone
 *    when a caller must derive an entitlement input from a bootstrap
 *    snapshot without accidentally carrying `launchMode` along.
 *
 * The module has zero runtime dependencies beyond the closed unions declared
 * in `app-bootstrap-contracts`. It must remain a leaf so both main and
 * renderer processes can import it (Requirements 4.1, 4.5).
 */

import {
  AppEditionSchema,
  LaunchModeSchema,
  type AppEdition,
  type LaunchMode,
} from './app-bootstrap-contracts.js';

// ── Closed enumerations ────────────────────────────────────────────────

/**
 * The complete, ordered set of persisted graphical launch modes. The order
 * matches the Mode Selector display order and is stable for snapshot tests.
 * A future addition must extend both this tuple and `LaunchModeSchema`.
 */
export const ALL_LAUNCH_MODES = ['classic', 'advanced'] as const satisfies readonly LaunchMode[];

/**
 * The complete, ordered set of commercial editions. The order matches the
 * user-visible tier hierarchy (community first) and is stable for snapshot
 * tests. A future addition must extend both this tuple and `AppEditionSchema`.
 */
export const ALL_APP_EDITIONS = [
  'community',
  'professional',
  'enterprise',
] as const satisfies readonly AppEdition[];

/**
 * Closed count of `LaunchMode` × `Edition` combinations. Exposed as a
 * literal so tests can assert coverage without depending on `Array.length`
 * observations that a caller may accidentally short-circuit.
 */
export const LAUNCH_MODE_EDITION_COMBINATION_COUNT = 6 as const;

// ── Exhaustive combination product ─────────────────────────────────────

/**
 * One `(LaunchMode, Edition)` combination. The two axes are intentionally
 * kept as strictly named properties so callers cannot accidentally swap
 * them (e.g. via positional destructuring of a tuple).
 */
export interface LaunchModeEditionCombination {
  readonly launchMode: LaunchMode;
  readonly edition: AppEdition;
}

/**
 * The exhaustive, ordered product of every supported launch mode and every
 * supported edition. Frozen at module load so tests, static architecture
 * checks, and iteration helpers cannot mutate the canonical list.
 *
 * Order is (mode × edition) in `ALL_LAUNCH_MODES` / `ALL_APP_EDITIONS`
 * declaration order so a snapshot of this list is stable across runs.
 */
export const ALL_LAUNCH_MODE_EDITION_COMBINATIONS: readonly LaunchModeEditionCombination[] =
  Object.freeze(
    ALL_LAUNCH_MODES.flatMap((launchMode) =>
      ALL_APP_EDITIONS.map((edition) =>
        Object.freeze({ launchMode, edition } satisfies LaunchModeEditionCombination),
      ),
    ),
  );

/**
 * Iterate every `(LaunchMode, Edition)` combination and invoke `visit`
 * for each. The helper exists so tests and diagnostics cannot forget an
 * axis — a new mode or edition automatically propagates without editing
 * every call site.
 *
 * A callback that never returns fails the enclosing test explicitly:
 * `expect(seen).toBe(LAUNCH_MODE_EDITION_COMBINATION_COUNT)`.
 */
export function forEachLaunchModeEditionCombination(
  visit: (combination: LaunchModeEditionCombination) => void,
): void {
  for (const combination of ALL_LAUNCH_MODE_EDITION_COMBINATIONS) {
    visit(combination);
  }
}

/**
 * Runtime completeness check. Verifies that the exhaustive list contains
 * exactly `|LaunchMode| × |Edition|` unique combinations and every combo is
 * a distinct pair. Called from module tests; also useful as a defensive
 * check when downstream tooling regenerates the enumeration.
 */
export function assertExhaustiveLaunchModeEditionCombinations(
  combinations: readonly LaunchModeEditionCombination[] = ALL_LAUNCH_MODE_EDITION_COMBINATIONS,
): void {
  const expected = ALL_LAUNCH_MODES.length * ALL_APP_EDITIONS.length;
  if (combinations.length !== expected) {
    throw new Error(
      `LaunchModeEditionCombinations must contain exactly ${expected} entries; ` +
        `got ${combinations.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const combo of combinations) {
    // Parse each axis independently so a caller cannot smuggle an unsupported
    // launch mode or edition through the exhaustive list.
    LaunchModeSchema.parse(combo.launchMode);
    AppEditionSchema.parse(combo.edition);
    const key = `${combo.launchMode}\u0000${combo.edition}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate LaunchModeEditionCombination entry: ${combo.launchMode}/${combo.edition}`,
      );
    }
    seen.add(key);
  }
}

// ── Launch-mode key rejection ──────────────────────────────────────────

/**
 * Property name variants that must never appear on an entitlement,
 * routing, or credential input. The check is intentionally structural —
 * an entitlement service does not consult a launch-mode-shaped key even
 * when a caller adds one by mistake.
 */
export const LAUNCH_MODE_KEY_ALIASES: readonly string[] = Object.freeze([
  'launchMode',
  'launchmode',
  'launch_mode',
  'LaunchMode',
  'launch-mode',
  'processLaunchKind',
]);

/**
 * Type-level guard. Attempting to pass a record whose keys include any
 * launch-mode alias to `assertEntitlementInputShape<T>()` produces
 * `never`, which propagates as a compile error at the call site.
 *
 * Usage:
 * ```ts
 * function preflight<T extends EntitlementInputShape<T>>(input: T) { ... }
 * ```
 */
export type EntitlementInputShape<T> = LaunchModeAliasKey<keyof T> extends never
  ? T
  : never;

type LaunchModeAliasKey<K> = K extends
  | 'launchMode'
  | 'launchmode'
  | 'launch_mode'
  | 'LaunchMode'
  | 'launch-mode'
  | 'processLaunchKind'
  ? K
  : never;

/**
 * Runtime companion to `EntitlementInputShape<T>`. Throws when any launch-
 * mode-shaped key is present on the payload. Used at process/network
 * boundaries where the shape is only known at runtime (IPC, JSON bridges).
 *
 * The check is deliberately conservative:
 *
 * - It rejects any own enumerable property whose name matches the alias
 *   list, regardless of value type.
 * - It does NOT inspect the value itself. Legitimate string fields that
 *   happen to equal `'classic'` or `'advanced'` (for example a colour
 *   swatch called `advanced`) remain acceptable.
 */
export function assertNoLaunchModeInEntitlementInput(
  input: unknown,
  context = 'entitlement input',
): void {
  if (typeof input !== 'object' || input === null) return;
  const owned = Object.prototype.hasOwnProperty;
  for (const alias of LAUNCH_MODE_KEY_ALIASES) {
    if (owned.call(input as object, alias)) {
      throw new Error(
        `${context} must not carry a launch-mode axis; ` +
          `received forbidden key '${alias}'. Launch mode and edition are ` +
          `independent — pass edition only.`,
      );
    }
  }
}

/**
 * Non-throwing companion. Returns `true` when the input is safe to hand to
 * an entitlement/route/credential service, otherwise `false`. Intended for
 * defensive branches where an assertion is undesirable.
 */
export function isLaunchModeIndependentInput(input: unknown): boolean {
  try {
    assertNoLaunchModeInEntitlementInput(input);
    return true;
  } catch {
    return false;
  }
}

// ── Edition-only projection ────────────────────────────────────────────

/**
 * Structural subset of `AppBootstrapSnapshot` used when a caller only
 * needs the edition axis. Declared locally so this module does not have
 * to depend on the full snapshot schema (which carries Inspector state
 * and other fields that are irrelevant to entitlement inputs).
 */
export interface EditionAxisCarrier {
  readonly edition: AppEdition;
  readonly launchMode?: LaunchMode;
  readonly launchModeSource?: string;
  readonly inspector?: unknown;
}

/**
 * Projects the edition axis alone from any bootstrap-shaped carrier. The
 * returned object contains `edition` and nothing else, ensuring downstream
 * services cannot accidentally observe or persist launch-mode state.
 */
export function editionOnlyForEntitlement(
  carrier: EditionAxisCarrier,
): { readonly edition: AppEdition } {
  const edition = AppEditionSchema.parse(carrier.edition);
  return Object.freeze({ edition });
}
