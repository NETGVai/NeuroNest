/**
 * Skill Taxonomy - Versioned typed taxonomy and deterministic normalization
 *
 * Provides separate SkillSelector and CategorySelector types, schema validation,
 * Unicode NFKC/case/whitespace/punctuation normalization, aliases, token-boundary
 * matching, and longest-match then lexical precedence for taxonomy rule resolution.
 *
 * Category expansion resolves through snapshot metadata and never emits a category
 * label as an ID without an explicit uniquely resolvable skill selector.
 *
 * Requirements: 10.3–10.7, 10.10, 10.12
 */

// ─────────────────────────────────────────────
// Selector Types (mutually exclusive)
// ─────────────────────────────────────────────

/**
 * A SkillSelector identifies a single authoritative skill by its exact Skill_ID.
 * Resolution requires exactly one enabled+installed catalog entry with this ID.
 */
export interface SkillSelector {
  readonly kind: 'skill';
  readonly skillId: string;
}

/**
 * A CategorySelector identifies a category for expansion through catalog metadata.
 * It never becomes an ID directly; expansion yields eligible entries matching
 * the category and capability key in the authoritative snapshot.
 */
export interface CategorySelector {
  readonly kind: 'category';
  readonly category: string;
  readonly capabilityKey: string;
}

/** Discriminated union of taxonomy selectors. */
export type TaxonomySelector = SkillSelector | CategorySelector;

// ─────────────────────────────────────────────
// Taxonomy Rule
// ─────────────────────────────────────────────

/** Dimensions against which taxonomy rules are matched. */
export type TaxonomyDimension =
  | 'department'
  | 'specialty'
  | 'capability'
  | 'technology'
  | 'deliverable';

/**
 * A versioned taxonomy rule connects a normalized match string in a given
 * dimension to one or more typed selectors and supported capability keys.
 */
export interface SkillTaxonomyRule {
  readonly ruleId: string;
  readonly version: number;
  readonly dimension: TaxonomyDimension;
  readonly normalizedMatch: string;
  readonly selectors: readonly TaxonomySelector[];
  readonly supportedCapabilityKeys: readonly string[];
}

// ─────────────────────────────────────────────
// Taxonomy Snapshot (immutable versioned data)
// ─────────────────────────────────────────────

/**
 * Immutable frozen taxonomy data used for one validation run.
 */
export interface SkillTaxonomySnapshot {
  readonly version: number;
  readonly rules: readonly SkillTaxonomyRule[];
  readonly aliases: ReadonlyMap<string, string>;
  readonly fingerprint: string;
}

// ─────────────────────────────────────────────
// Catalog Snapshot Types (minimal for taxonomy use)
// ─────────────────────────────────────────────

/**
 * Minimal catalog entry interface used by taxonomy resolution.
 * The full SkillCatalogEntry is owned by AgentSkillsService (task 4.1).
 */
export interface TaxonomyCatalogEntry {
  readonly skillId: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly capabilityKeys: readonly string[];
}

/**
 * Minimal authoritative catalog snapshot interface for taxonomy resolution.
 */
export interface TaxonomyCatalogSnapshot {
  readonly entries: readonly TaxonomyCatalogEntry[];
  readonly byId: ReadonlyMap<string, readonly TaxonomyCatalogEntry[]>;
  readonly byCategory: ReadonlyMap<string, readonly TaxonomyCatalogEntry[]>;
}

// ─────────────────────────────────────────────
// Taxonomy Resolution Result
// ─────────────────────────────────────────────

export type ResolutionStatus =
  | 'resolved'
  | 'unresolved'
  | 'multiply-resolved'
  | 'disabled'
  | 'uninstalled';

export interface SelectorResolution {
  readonly selector: TaxonomySelector;
  readonly status: ResolutionStatus;
  readonly resolvedSkillIds: readonly string[];
  readonly matchCount: number;
}

export interface TaxonomyResolutionResult {
  readonly matchedRules: readonly SkillTaxonomyRule[];
  readonly resolutions: readonly SelectorResolution[];
  readonly resolvedSkillIds: readonly string[];
  readonly errors: readonly TaxonomyResolutionError[];
}

export interface TaxonomyResolutionError {
  readonly ruleId: string;
  readonly selector: TaxonomySelector;
  readonly status: ResolutionStatus;
  readonly message: string;
}

// ─────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────

export interface TaxonomyValidationError {
  readonly path: string;
  readonly message: string;
  readonly value?: unknown;
}

const VALID_DIMENSIONS: readonly TaxonomyDimension[] = [
  'department', 'specialty', 'capability', 'technology', 'deliverable',
];

/**
 * Validates a single TaxonomySelector schema.
 */
export function validateSelector(
  selector: unknown,
  path: string
): TaxonomyValidationError[] {
  const errors: TaxonomyValidationError[] = [];
  if (selector === null || typeof selector !== 'object') {
    errors.push({ path, message: 'Selector must be a non-null object', value: selector });
    return errors;
  }
  const sel = selector as Record<string, unknown>;
  if (sel['kind'] === 'skill') {
    if (typeof sel['skillId'] !== 'string' || sel['skillId'].trim().length === 0) {
      errors.push({ path: `${path}.skillId`, message: 'SkillSelector requires a non-empty skillId string', value: sel['skillId'] });
    }
  } else if (sel['kind'] === 'category') {
    if (typeof sel['category'] !== 'string' || sel['category'].trim().length === 0) {
      errors.push({ path: `${path}.category`, message: 'CategorySelector requires a non-empty category string', value: sel['category'] });
    }
    if (typeof sel['capabilityKey'] !== 'string' || sel['capabilityKey'].trim().length === 0) {
      errors.push({ path: `${path}.capabilityKey`, message: 'CategorySelector requires a non-empty capabilityKey string', value: sel['capabilityKey'] });
    }
  } else {
    errors.push({ path: `${path}.kind`, message: 'Selector kind must be "skill" or "category"', value: sel['kind'] });
  }
  return errors;
}

/**
 * Validates a SkillTaxonomyRule schema.
 */
export function validateRule(rule: unknown, index: number): TaxonomyValidationError[] {
  const errors: TaxonomyValidationError[] = [];
  const path = `rules[${index}]`;

  if (rule === null || typeof rule !== 'object') {
    errors.push({ path, message: 'Rule must be a non-null object', value: rule });
    return errors;
  }
  const r = rule as Record<string, unknown>;

  if (typeof r['ruleId'] !== 'string' || r['ruleId'].trim().length === 0) {
    errors.push({ path: `${path}.ruleId`, message: 'ruleId must be a non-empty string', value: r['ruleId'] });
  }
  if (typeof r['version'] !== 'number' || !Number.isInteger(r['version']) || (r['version'] as number) < 1) {
    errors.push({ path: `${path}.version`, message: 'version must be a positive integer', value: r['version'] });
  }
  if (!VALID_DIMENSIONS.includes(r['dimension'] as TaxonomyDimension)) {
    errors.push({ path: `${path}.dimension`, message: `dimension must be one of: ${VALID_DIMENSIONS.join(', ')}`, value: r['dimension'] });
  }
  if (typeof r['normalizedMatch'] !== 'string' || r['normalizedMatch'].trim().length === 0) {
    errors.push({ path: `${path}.normalizedMatch`, message: 'normalizedMatch must be a non-empty string', value: r['normalizedMatch'] });
  }

  // Validate selectors array
  if (!Array.isArray(r['selectors']) || (r['selectors'] as unknown[]).length === 0) {
    errors.push({ path: `${path}.selectors`, message: 'selectors must be a non-empty array', value: r['selectors'] });
  } else {
    for (let i = 0; i < (r['selectors'] as unknown[]).length; i++) {
      errors.push(...validateSelector((r['selectors'] as unknown[])[i], `${path}.selectors[${i}]`));
    }
  }

  // Validate supportedCapabilityKeys
  if (!Array.isArray(r['supportedCapabilityKeys'])) {
    errors.push({ path: `${path}.supportedCapabilityKeys`, message: 'supportedCapabilityKeys must be an array', value: r['supportedCapabilityKeys'] });
  } else {
    for (let i = 0; i < (r['supportedCapabilityKeys'] as unknown[]).length; i++) {
      const key = (r['supportedCapabilityKeys'] as unknown[])[i];
      if (typeof key !== 'string' || (key as string).trim().length === 0) {
        errors.push({ path: `${path}.supportedCapabilityKeys[${i}]`, message: 'Each capability key must be a non-empty string', value: key });
      }
    }
  }

  return errors;
}

/**
 * Validates an entire taxonomy data payload and returns all errors.
 */
export function validateTaxonomyData(
  data: unknown
): TaxonomyValidationError[] {
  const errors: TaxonomyValidationError[] = [];
  if (data === null || typeof data !== 'object') {
    errors.push({ path: '', message: 'Taxonomy data must be a non-null object', value: data });
    return errors;
  }
  const d = data as Record<string, unknown>;

  if (typeof d['version'] !== 'number' || !Number.isInteger(d['version']) || (d['version'] as number) < 1) {
    errors.push({ path: 'version', message: 'Taxonomy version must be a positive integer', value: d['version'] });
  }

  if (!Array.isArray(d['rules'])) {
    errors.push({ path: 'rules', message: 'rules must be an array', value: d['rules'] });
  } else {
    for (let i = 0; i < (d['rules'] as unknown[]).length; i++) {
      errors.push(...validateRule((d['rules'] as unknown[])[i], i));
    }
  }

  if (d['aliases'] !== undefined && d['aliases'] !== null) {
    if (typeof d['aliases'] !== 'object' || Array.isArray(d['aliases'])) {
      errors.push({ path: 'aliases', message: 'aliases must be a plain object mapping strings to strings', value: d['aliases'] });
    } else {
      const aliases = d['aliases'] as Record<string, unknown>;
      for (const [key, val] of Object.entries(aliases)) {
        if (typeof val !== 'string') {
          errors.push({ path: `aliases.${key}`, message: 'Alias value must be a string', value: val });
        }
      }
    }
  }

  return errors;
}

// ─────────────────────────────────────────────
// Deterministic Normalization
// ─────────────────────────────────────────────

/**
 * Applies Unicode NFKC normalization, lowercase, punctuation-to-space,
 * whitespace trim/collapse, and alias expansion.
 *
 * This produces a canonical string suitable for token-boundary matching
 * against taxonomy rule `normalizedMatch` values.
 */
export function normalizeText(
  input: string,
  aliases?: ReadonlyMap<string, string>
): string {
  // Step 1: Unicode NFKC normalization
  let result = input.normalize('NFKC');

  // Step 2: Lowercase
  result = result.toLowerCase();

  // Step 3: Replace punctuation with spaces (keep alphanumeric and whitespace)
  result = result.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  // Step 4: Collapse whitespace and trim
  result = result.replace(/\s+/g, ' ').trim();

  // Step 5: Alias expansion (iterative single-pass over tokens)
  if (aliases && aliases.size > 0) {
    const tokens = result.split(' ');
    const expanded = tokens.map(token => {
      const alias = aliases.get(token);
      return alias !== undefined ? alias : token;
    });
    result = expanded.join(' ');
  }

  return result;
}

// ─────────────────────────────────────────────
// Token-Boundary Matching
// ─────────────────────────────────────────────

/**
 * Checks whether `pattern` appears in `text` at token boundaries.
 * Both inputs must already be normalized.
 *
 * Token-boundary matching means the pattern is found as a contiguous
 * subsequence of tokens (words) in the text. This prevents partial-word
 * matches (e.g., "test" matching inside "testing").
 */
export function matchesAtTokenBoundary(
  normalizedText: string,
  normalizedPattern: string
): boolean {
  if (normalizedPattern.length === 0) return false;
  if (normalizedText === normalizedPattern) return true;

  const textTokens = normalizedText.split(' ');
  const patternTokens = normalizedPattern.split(' ');

  if (patternTokens.length > textTokens.length) return false;

  // Sliding window: find contiguous subsequence of tokens
  const windowSize = patternTokens.length;
  for (let i = 0; i <= textTokens.length - windowSize; i++) {
    let match = true;
    for (let j = 0; j < windowSize; j++) {
      if (textTokens[i + j] !== patternTokens[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}

// ─────────────────────────────────────────────
// Rule Matching with Precedence
// ─────────────────────────────────────────────

/**
 * Comparator for taxonomy rule precedence:
 * 1. Within same dimension
 * 2. Descending normalizedMatch length (longest match first)
 * 3. Ascending ruleId (lexical tiebreaker for determinism)
 */
function ruleComparator(a: SkillTaxonomyRule, b: SkillTaxonomyRule): number {
  // Longest match first
  const lenDiff = b.normalizedMatch.length - a.normalizedMatch.length;
  if (lenDiff !== 0) return lenDiff;
  // Lexical ruleId ascending tiebreaker
  return a.ruleId.localeCompare(b.ruleId);
}

/**
 * Finds all taxonomy rules that match a given normalized input text
 * for a specific dimension. Returns rules in precedence order
 * (longest-match then lexical ruleId).
 *
 * Multiple applicable rules merge evidence rather than letting broad
 * department rules erase specific technology/deliverable rules.
 */
export function findMatchingRules(
  normalizedInput: string,
  dimension: TaxonomyDimension,
  rules: readonly SkillTaxonomyRule[]
): readonly SkillTaxonomyRule[] {
  const matched: SkillTaxonomyRule[] = [];

  for (const rule of rules) {
    if (rule.dimension !== dimension) continue;
    if (matchesAtTokenBoundary(normalizedInput, rule.normalizedMatch)) {
      matched.push(rule);
    }
  }

  // Sort by precedence: longest-match then lexical ruleId
  matched.sort(ruleComparator);

  return matched;
}

// ─────────────────────────────────────────────
// Selector Resolution Against Catalog Snapshot
// ─────────────────────────────────────────────

/**
 * Resolves a SkillSelector against the catalog snapshot.
 * Requires exactly one entry with the ID where enabled=true and installed=true.
 */
function resolveSkillSelector(
  selector: SkillSelector,
  catalog: TaxonomyCatalogSnapshot
): SelectorResolution {
  const entries = catalog.byId.get(selector.skillId);
  if (!entries || entries.length === 0) {
    return {
      selector,
      status: 'unresolved',
      resolvedSkillIds: [],
      matchCount: 0,
    };
  }

  if (entries.length > 1) {
    return {
      selector,
      status: 'multiply-resolved',
      resolvedSkillIds: [],
      matchCount: entries.length,
    };
  }

  const entry = entries[0]!;
  if (!entry.enabled) {
    return {
      selector,
      status: 'disabled',
      resolvedSkillIds: [],
      matchCount: 1,
    };
  }
  if (!entry.installed) {
    return {
      selector,
      status: 'uninstalled',
      resolvedSkillIds: [],
      matchCount: 1,
    };
  }

  return {
    selector,
    status: 'resolved',
    resolvedSkillIds: [entry.skillId],
    matchCount: 1,
  };
}

/**
 * Resolves a CategorySelector through catalog metadata.
 * Expands to all enabled+installed entries in the snapshot that match
 * the category AND have the required capabilityKey in their metadata.
 *
 * CRITICAL: Never emits the category label as a Skill_ID. Only concrete
 * skill IDs from matching catalog entries are returned.
 */
function resolveCategorySelector(
  selector: CategorySelector,
  catalog: TaxonomyCatalogSnapshot
): SelectorResolution {
  const categoryEntries = catalog.byCategory.get(selector.category);
  if (!categoryEntries || categoryEntries.length === 0) {
    return {
      selector,
      status: 'unresolved',
      resolvedSkillIds: [],
      matchCount: 0,
    };
  }

  // Filter to entries that are enabled, installed, and support the capability
  const eligible = categoryEntries.filter(
    entry => entry.enabled && entry.installed &&
      entry.capabilityKeys.includes(selector.capabilityKey)
  );

  if (eligible.length === 0) {
    // Check if entries exist but are disabled/uninstalled
    const disabledMatches = categoryEntries.filter(
      entry => entry.capabilityKeys.includes(selector.capabilityKey)
    );
    if (disabledMatches.length > 0) {
      const allDisabled = disabledMatches.every(e => !e.enabled);
      return {
        selector,
        status: allDisabled ? 'disabled' : 'uninstalled',
        resolvedSkillIds: [],
        matchCount: disabledMatches.length,
      };
    }
    return {
      selector,
      status: 'unresolved',
      resolvedSkillIds: [],
      matchCount: 0,
    };
  }

  // Return all eligible skill IDs (sorted for determinism)
  const resolvedIds = eligible.map(e => e.skillId).sort();

  return {
    selector,
    status: 'resolved',
    resolvedSkillIds: resolvedIds,
    matchCount: eligible.length,
  };
}

/**
 * Resolves a single TaxonomySelector against the catalog snapshot.
 */
export function resolveSelector(
  selector: TaxonomySelector,
  catalog: TaxonomyCatalogSnapshot
): SelectorResolution {
  switch (selector.kind) {
    case 'skill':
      return resolveSkillSelector(selector, catalog);
    case 'category':
      return resolveCategorySelector(selector, catalog);
  }
}

// ─────────────────────────────────────────────
// Complete Taxonomy Resolution
// ─────────────────────────────────────────────

/**
 * Input for taxonomy resolution: the text to match per dimension.
 */
export interface TaxonomyInput {
  readonly department?: string;
  readonly specialty?: string;
  readonly capabilities?: readonly string[];
  readonly technologies?: readonly string[];
  readonly deliverables?: readonly string[];
}

/**
 * Resolves taxonomy rules for a given agent input against the authoritative
 * catalog snapshot, producing deterministic skill IDs.
 *
 * Algorithm:
 * 1. Normalize all input texts using NFKC/case/whitespace/punctuation/aliases
 * 2. For each dimension, find matching rules (longest-match then lexical)
 * 3. Collect all selectors from matched rules
 * 4. Resolve each selector against the catalog snapshot
 * 5. Merge all resolved skill IDs (ascending, unique)
 * 6. Report errors for unresolved/disabled/uninstalled/multiply-resolved
 *
 * Multiple applicable rules merge evidence rather than competing.
 */
export function resolveTaxonomy(
  input: TaxonomyInput,
  snapshot: SkillTaxonomySnapshot,
  catalog: TaxonomyCatalogSnapshot
): TaxonomyResolutionResult {
  const allMatchedRules: SkillTaxonomyRule[] = [];
  const allResolutions: SelectorResolution[] = [];
  const allErrors: TaxonomyResolutionError[] = [];
  const resolvedIdSet = new Set<string>();

  const aliases = snapshot.aliases;

  // Process each dimension
  const dimensionInputs: Array<{ dimension: TaxonomyDimension; texts: string[] }> = [
    { dimension: 'department', texts: input.department ? [input.department] : [] },
    { dimension: 'specialty', texts: input.specialty ? [input.specialty] : [] },
    { dimension: 'capability', texts: input.capabilities ? [...input.capabilities] : [] },
    { dimension: 'technology', texts: input.technologies ? [...input.technologies] : [] },
    { dimension: 'deliverable', texts: input.deliverables ? [...input.deliverables] : [] },
  ];

  for (const { dimension, texts } of dimensionInputs) {
    for (const rawText of texts) {
      const normalized = normalizeText(rawText, aliases);
      if (normalized.length === 0) continue;

      const matched = findMatchingRules(normalized, dimension, snapshot.rules);
      allMatchedRules.push(...matched);

      // Resolve all selectors from matched rules
      for (const rule of matched) {
        for (const selector of rule.selectors) {
          const resolution = resolveSelector(selector, catalog);
          allResolutions.push(resolution);

          if (resolution.status === 'resolved') {
            for (const id of resolution.resolvedSkillIds) {
              resolvedIdSet.add(id);
            }
          } else {
            allErrors.push({
              ruleId: rule.ruleId,
              selector,
              status: resolution.status,
              message: buildResolutionErrorMessage(selector, resolution),
            });
          }
        }
      }
    }
  }

  // Produce ascending unique sorted skill IDs
  const resolvedSkillIds = Array.from(resolvedIdSet).sort();

  return {
    matchedRules: allMatchedRules,
    resolutions: allResolutions,
    resolvedSkillIds,
    errors: allErrors,
  };
}

function buildResolutionErrorMessage(
  selector: TaxonomySelector,
  resolution: SelectorResolution
): string {
  const id = selector.kind === 'skill' ? selector.skillId : `${selector.category}/${selector.capabilityKey}`;
  switch (resolution.status) {
    case 'unresolved':
      return `No catalog entry found for ${selector.kind} selector: ${id}`;
    case 'multiply-resolved':
      return `Multiple catalog entries (${resolution.matchCount}) found for ${selector.kind} selector: ${id}`;
    case 'disabled':
      return `Catalog entry for ${selector.kind} selector is disabled: ${id}`;
    case 'uninstalled':
      return `Catalog entry for ${selector.kind} selector is not installed: ${id}`;
    default:
      return `Unknown resolution status for ${selector.kind} selector: ${id}`;
  }
}

// ─────────────────────────────────────────────
// Snapshot Construction
// ─────────────────────────────────────────────

/**
 * Constructs a frozen SkillTaxonomySnapshot from validated raw taxonomy data.
 * The caller must validate using validateTaxonomyData first.
 */
export function buildTaxonomySnapshot(
  data: {
    version: number;
    rules: SkillTaxonomyRule[];
    aliases?: Record<string, string>;
  }
): SkillTaxonomySnapshot {
  const aliasMap = new Map<string, string>();
  if (data.aliases) {
    for (const [key, value] of Object.entries(data.aliases)) {
      aliasMap.set(normalizeText(key), normalizeText(value));
    }
  }

  const fingerprint = computeTaxonomyFingerprint(data.version, data.rules, aliasMap);

  return Object.freeze({
    version: data.version,
    rules: Object.freeze([...data.rules]),
    aliases: aliasMap,
    fingerprint,
  });
}

/**
 * Computes a stable fingerprint for taxonomy content determinism.
 */
function computeTaxonomyFingerprint(
  version: number,
  rules: readonly SkillTaxonomyRule[],
  aliases: ReadonlyMap<string, string>
): string {
  // Stable canonical serialization
  const sortedRules = [...rules].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const aliasEntries = [...aliases.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const content = JSON.stringify({
    v: version,
    r: sortedRules.map(r => ({
      id: r.ruleId,
      ver: r.version,
      dim: r.dimension,
      match: r.normalizedMatch,
      sel: r.selectors.map(s =>
        s.kind === 'skill' ? { k: 'skill', id: s.skillId } : { k: 'cat', c: s.category, ck: s.capabilityKey }
      ),
      caps: [...r.supportedCapabilityKeys].sort(),
    })),
    a: aliasEntries,
  });

  // Simple deterministic hash (FNV-1a 32-bit)
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `tax-${version}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// ─────────────────────────────────────────────
// Catalog Snapshot Helpers
// ─────────────────────────────────────────────

/**
 * Builds a TaxonomyCatalogSnapshot from a flat list of entries.
 * Creates byId and byCategory indexes with deterministic sorted buckets.
 */
export function buildCatalogSnapshot(
  entries: readonly TaxonomyCatalogEntry[]
): TaxonomyCatalogSnapshot {
  const byId = new Map<string, TaxonomyCatalogEntry[]>();
  const byCategory = new Map<string, TaxonomyCatalogEntry[]>();

  const sortedEntries = [...entries].sort((a, b) => a.skillId.localeCompare(b.skillId));

  for (const entry of sortedEntries) {
    // Index by ID (intentionally stores arrays for multiply-resolved detection)
    const idBucket = byId.get(entry.skillId);
    if (idBucket) {
      idBucket.push(entry);
    } else {
      byId.set(entry.skillId, [entry]);
    }

    // Index by category
    const catBucket = byCategory.get(entry.category);
    if (catBucket) {
      catBucket.push(entry);
    } else {
      byCategory.set(entry.category, [entry]);
    }
  }

  return {
    entries: Object.freeze(sortedEntries),
    byId,
    byCategory,
  };
}

// ─────────────────────────────────────────────
// Selector Constructors
// ─────────────────────────────────────────────

/** Creates a typed SkillSelector. */
export function skillSelector(skillId: string): SkillSelector {
  return Object.freeze({ kind: 'skill', skillId });
}

/** Creates a typed CategorySelector. */
export function categorySelector(category: string, capabilityKey: string): CategorySelector {
  return Object.freeze({ kind: 'category', category, capabilityKey });
}

// ─────────────────────────────────────────────
// Rule Constructor
// ─────────────────────────────────────────────

/** Creates a validated SkillTaxonomyRule. */
export function createRule(params: {
  ruleId: string;
  version: number;
  dimension: TaxonomyDimension;
  normalizedMatch: string;
  selectors: TaxonomySelector[];
  supportedCapabilityKeys: string[];
}): SkillTaxonomyRule {
  return Object.freeze({
    ruleId: params.ruleId,
    version: params.version,
    dimension: params.dimension,
    normalizedMatch: params.normalizedMatch,
    selectors: Object.freeze([...params.selectors]),
    supportedCapabilityKeys: Object.freeze([...params.supportedCapabilityKeys]),
  });
}
