/**
 * Reviewed Override Schema, Loading, and Validation
 *
 * Implements immutable override snapshots and validation for agent selector,
 * exact eligible skill ID, approved status, reviewer identity, rationale,
 * supported extracted capability/deliverable, and taxonomy version.
 *
 * Reports pending, rejected, expired, malformed, stale, or conflicting
 * overrides without allowing them to authorize assignments.
 *
 * Requirements: 10.4, 10.5, 10.7, 10.10, 10.12
 */

// ─────────────────────────────────────────────
// Types and Interfaces
// ─────────────────────────────────────────────

/**
 * Review status of an override record.
 * Only 'approved' overrides may authorize skill assignments.
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * The selector that identifies which agent(s) an override applies to.
 * At least one of sourcePath or agentId must be non-empty.
 */
export interface OverrideAgentSelector {
  readonly sourcePath?: string;
  readonly agentId?: string;
}

/**
 * A single reviewed override record that can authorize or block a skill
 * assignment for a specific agent-capability-skill combination.
 */
export interface ReviewedOverride {
  readonly overrideId: string;
  readonly agentSelector: OverrideAgentSelector;
  readonly skillId: string;
  readonly reviewStatus: ReviewStatus;
  readonly reviewerId: string;
  readonly rationale: string;
  readonly supportedCapabilityKey: string;
  readonly supportedDeliverable?: string;
  readonly taxonomyVersion: number;
}

/**
 * Diagnostic severity for override validation findings.
 */
export type OverrideDiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Diagnostic codes for override validation findings.
 */
export type OverrideDiagnosticCode =
  | 'OVERRIDE_MALFORMED'
  | 'OVERRIDE_MISSING_OVERRIDE_ID'
  | 'OVERRIDE_MISSING_AGENT_SELECTOR'
  | 'OVERRIDE_MISSING_SKILL_ID'
  | 'OVERRIDE_MISSING_REVIEWER'
  | 'OVERRIDE_MISSING_RATIONALE'
  | 'OVERRIDE_MISSING_CAPABILITY'
  | 'OVERRIDE_MISSING_TAXONOMY_VERSION'
  | 'OVERRIDE_INVALID_STATUS'
  | 'OVERRIDE_PENDING'
  | 'OVERRIDE_REJECTED'
  | 'OVERRIDE_EXPIRED'
  | 'OVERRIDE_STALE_TAXONOMY'
  | 'OVERRIDE_CONFLICTING'
  | 'OVERRIDE_SKILL_NOT_IN_CATALOG'
  | 'OVERRIDE_SKILL_DISABLED'
  | 'OVERRIDE_SKILL_NOT_INSTALLED'
  | 'OVERRIDE_SKILL_MULTIPLY_RESOLVED'
  | 'OVERRIDE_CAPABILITY_NOT_EXTRACTED';

/**
 * A diagnostic produced during override validation.
 */
export interface OverrideDiagnostic {
  readonly overrideId: string;
  readonly code: OverrideDiagnosticCode;
  readonly severity: OverrideDiagnosticSeverity;
  readonly message: string;
}

/**
 * Result of validating a single override for use in assignment authorization.
 */
export interface OverrideValidationResult {
  readonly override: ReviewedOverride;
  readonly eligible: boolean;
  readonly diagnostics: readonly OverrideDiagnostic[];
}

/**
 * Immutable snapshot of all reviewed overrides with validation outcomes.
 */
export interface ReviewedOverrideSnapshot {
  readonly overrides: readonly ReviewedOverride[];
  readonly validationResults: readonly OverrideValidationResult[];
  readonly eligibleOverrides: readonly ReviewedOverride[];
  readonly diagnostics: readonly OverrideDiagnostic[];
  readonly taxonomyVersion: number;
  readonly fingerprint: string;
}

/**
 * Minimal skill catalog entry representation used for override validation.
 * Provided externally by the authoritative catalog snapshot.
 */
export interface OverrideCatalogEntry {
  readonly skillId: string;
  readonly enabled: boolean;
  readonly installed: boolean;
}

/**
 * Context required to validate overrides against catalog and agent state.
 */
export interface OverrideValidationContext {
  /** Current taxonomy version number */
  readonly currentTaxonomyVersion: number;
  /** Catalog entries indexed by skill ID; arrays handle multiply resolved IDs */
  readonly catalogBySkillId: ReadonlyMap<string, readonly OverrideCatalogEntry[]>;
  /** Extracted material capability keys for the target agent (when validating per-agent) */
  readonly extractedCapabilityKeys?: ReadonlySet<string>;
}

// ─────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────

/**
 * Validates the structural completeness of a raw override record.
 * Returns diagnostics for every malformed or missing field.
 */
export function validateOverrideSchema(raw: unknown): {
  override: ReviewedOverride | null;
  diagnostics: OverrideDiagnostic[];
} {
  const diagnostics: OverrideDiagnostic[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    diagnostics.push({
      overrideId: '<unknown>',
      code: 'OVERRIDE_MALFORMED',
      severity: 'error',
      message: 'Override record is not an object',
    });
    return { override: null, diagnostics };
  }

  const record = raw as Record<string, unknown>;
  const overrideId = typeof record.overrideId === 'string' && record.overrideId.trim()
    ? record.overrideId.trim()
    : '';

  const idForDiag = overrideId || '<unknown>';

  if (!overrideId) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_OVERRIDE_ID',
      severity: 'error',
      message: 'Override record is missing a non-empty overrideId',
    });
  }

  // Agent selector validation
  const agentSelector = record.agentSelector;
  let validSelector: OverrideAgentSelector = {};
  if (agentSelector === null || agentSelector === undefined || typeof agentSelector !== 'object') {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_AGENT_SELECTOR',
      severity: 'error',
      message: 'Override record is missing agentSelector',
    });
  } else {
    const sel = agentSelector as Record<string, unknown>;
    const sourcePath = typeof sel.sourcePath === 'string' && sel.sourcePath.trim() ? sel.sourcePath.trim() : undefined;
    const agentId = typeof sel.agentId === 'string' && sel.agentId.trim() ? sel.agentId.trim() : undefined;
    if (!sourcePath && !agentId) {
      diagnostics.push({
        overrideId: idForDiag,
        code: 'OVERRIDE_MISSING_AGENT_SELECTOR',
        severity: 'error',
        message: 'Override agentSelector must have at least one of sourcePath or agentId',
      });
    }
    validSelector = { sourcePath, agentId };
  }

  // Skill ID
  const skillId = typeof record.skillId === 'string' && record.skillId.trim()
    ? record.skillId.trim()
    : '';
  if (!skillId) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_SKILL_ID',
      severity: 'error',
      message: 'Override record is missing a non-empty skillId',
    });
  }

  // Review status
  const validStatuses: ReviewStatus[] = ['pending', 'approved', 'rejected', 'expired'];
  const reviewStatus = typeof record.reviewStatus === 'string' && validStatuses.includes(record.reviewStatus as ReviewStatus)
    ? (record.reviewStatus as ReviewStatus)
    : null;
  if (!reviewStatus) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_INVALID_STATUS',
      severity: 'error',
      message: `Override record has invalid reviewStatus: ${String(record.reviewStatus)}; expected one of: ${validStatuses.join(', ')}`,
    });
  }

  // Reviewer identity
  const reviewerId = typeof record.reviewerId === 'string' && record.reviewerId.trim()
    ? record.reviewerId.trim()
    : '';
  if (!reviewerId) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_REVIEWER',
      severity: 'error',
      message: 'Override record is missing a non-empty reviewerId',
    });
  }

  // Rationale
  const rationale = typeof record.rationale === 'string' && record.rationale.trim()
    ? record.rationale.trim()
    : '';
  if (!rationale) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_RATIONALE',
      severity: 'error',
      message: 'Override record is missing a non-empty rationale',
    });
  }

  // Supported capability key
  const supportedCapabilityKey = typeof record.supportedCapabilityKey === 'string' && record.supportedCapabilityKey.trim()
    ? record.supportedCapabilityKey.trim()
    : '';
  if (!supportedCapabilityKey) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_CAPABILITY',
      severity: 'error',
      message: 'Override record is missing a non-empty supportedCapabilityKey',
    });
  }

  // Supported deliverable (optional)
  const supportedDeliverable = typeof record.supportedDeliverable === 'string' && record.supportedDeliverable.trim()
    ? record.supportedDeliverable.trim()
    : undefined;

  // Taxonomy version
  const taxonomyVersion = typeof record.taxonomyVersion === 'number' && Number.isFinite(record.taxonomyVersion) && record.taxonomyVersion > 0
    ? record.taxonomyVersion
    : 0;
  if (taxonomyVersion === 0) {
    diagnostics.push({
      overrideId: idForDiag,
      code: 'OVERRIDE_MISSING_TAXONOMY_VERSION',
      severity: 'error',
      message: 'Override record is missing a valid positive taxonomyVersion',
    });
  }

  // If there are structural errors, return null override
  if (diagnostics.some(d => d.severity === 'error')) {
    return { override: null, diagnostics };
  }

  const override: ReviewedOverride = Object.freeze({
    overrideId,
    agentSelector: Object.freeze(validSelector),
    skillId,
    reviewStatus: reviewStatus!,
    reviewerId,
    rationale,
    supportedCapabilityKey,
    supportedDeliverable,
    taxonomyVersion,
  });

  return { override, diagnostics };
}

// ─────────────────────────────────────────────
// Eligibility Validation
// ─────────────────────────────────────────────

/**
 * Validates whether a structurally valid override is eligible to authorize
 * an assignment in the given context. Only 'approved' overrides with valid
 * catalog resolution, reviewer identity, rationale, matching capability,
 * and current taxonomy version can authorize.
 *
 * Pending, rejected, expired, malformed, stale, or conflicting overrides
 * are reported but never authorize assignments.
 */
export function validateOverrideEligibility(
  override: ReviewedOverride,
  context: OverrideValidationContext,
): OverrideValidationResult {
  const diagnostics: OverrideDiagnostic[] = [];
  let eligible = true;

  // 1. Check review status
  if (override.reviewStatus === 'pending') {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_PENDING',
      severity: 'warning',
      message: `Override ${override.overrideId} has pending review status and cannot authorize assignments`,
    });
    eligible = false;
  } else if (override.reviewStatus === 'rejected') {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_REJECTED',
      severity: 'warning',
      message: `Override ${override.overrideId} has been rejected and cannot authorize assignments`,
    });
    eligible = false;
  } else if (override.reviewStatus === 'expired') {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_EXPIRED',
      severity: 'warning',
      message: `Override ${override.overrideId} has expired and cannot authorize assignments`,
    });
    eligible = false;
  }

  // 2. Validate taxonomy version is not stale
  if (override.taxonomyVersion < context.currentTaxonomyVersion) {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_STALE_TAXONOMY',
      severity: 'warning',
      message: `Override ${override.overrideId} references taxonomy version ${override.taxonomyVersion} but current version is ${context.currentTaxonomyVersion}`,
    });
    eligible = false;
  }

  // 3. Validate skill ID against the authoritative catalog
  const catalogEntries = context.catalogBySkillId.get(override.skillId);

  if (!catalogEntries || catalogEntries.length === 0) {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_SKILL_NOT_IN_CATALOG',
      severity: 'error',
      message: `Override ${override.overrideId} references skill ID '${override.skillId}' which does not exist in the authoritative catalog`,
    });
    eligible = false;
  } else if (catalogEntries.length > 1) {
    diagnostics.push({
      overrideId: override.overrideId,
      code: 'OVERRIDE_SKILL_MULTIPLY_RESOLVED',
      severity: 'error',
      message: `Override ${override.overrideId} references skill ID '${override.skillId}' which resolves to ${catalogEntries.length} entries; exactly one expected`,
    });
    eligible = false;
  } else {
    const entry = catalogEntries[0];
    if (!entry.enabled) {
      diagnostics.push({
        overrideId: override.overrideId,
        code: 'OVERRIDE_SKILL_DISABLED',
        severity: 'error',
        message: `Override ${override.overrideId} references skill ID '${override.skillId}' which is disabled in the catalog`,
      });
      eligible = false;
    }
    if (!entry.installed) {
      diagnostics.push({
        overrideId: override.overrideId,
        code: 'OVERRIDE_SKILL_NOT_INSTALLED',
        severity: 'error',
        message: `Override ${override.overrideId} references skill ID '${override.skillId}' which is not installed in the catalog`,
      });
      eligible = false;
    }
  }

  // 4. Validate supported capability against extracted capabilities (when available)
  if (context.extractedCapabilityKeys) {
    if (!context.extractedCapabilityKeys.has(override.supportedCapabilityKey)) {
      diagnostics.push({
        overrideId: override.overrideId,
        code: 'OVERRIDE_CAPABILITY_NOT_EXTRACTED',
        severity: 'error',
        message: `Override ${override.overrideId} claims support for capability '${override.supportedCapabilityKey}' which was not extracted from the agent definition`,
      });
      eligible = false;
    }
  }

  return Object.freeze({
    override,
    eligible,
    diagnostics: Object.freeze(diagnostics),
  });
}

// ─────────────────────────────────────────────
// Conflict Detection
// ─────────────────────────────────────────────

/**
 * Detects conflicting overrides: multiple approved overrides targeting the
 * same agent and skill with different capability keys. Conflicting overrides
 * cannot authorize assignments.
 */
export function detectConflicts(
  overrides: readonly ReviewedOverride[],
): OverrideDiagnostic[] {
  const diagnostics: OverrideDiagnostic[] = [];

  // Group approved overrides by (agentSelector key, skillId)
  const groups = new Map<string, ReviewedOverride[]>();

  for (const ov of overrides) {
    if (ov.reviewStatus !== 'approved') continue;
    const selectorKey = buildSelectorKey(ov.agentSelector);
    const groupKey = `${selectorKey}::${ov.skillId}`;
    const group = groups.get(groupKey);
    if (group) {
      group.push(ov);
    } else {
      groups.set(groupKey, [ov]);
    }
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    // Check if all capability keys are the same; different keys are conflicting
    const capKeys = new Set(group.map(o => o.supportedCapabilityKey));
    if (capKeys.size > 1) {
      for (const ov of group) {
        diagnostics.push({
          overrideId: ov.overrideId,
          code: 'OVERRIDE_CONFLICTING',
          severity: 'error',
          message: `Override ${ov.overrideId} conflicts with ${group.length - 1} other override(s) for the same agent and skill ID '${ov.skillId}' with differing capability keys`,
        });
      }
    }
  }

  return diagnostics;
}

// ─────────────────────────────────────────────
// Snapshot Construction
// ─────────────────────────────────────────────

/**
 * Loads raw override records, validates schema, checks eligibility and
 * conflicts, and builds an immutable snapshot. Only overrides that pass
 * all validation are eligible to authorize assignments.
 */
export function buildReviewedOverrideSnapshot(
  rawRecords: readonly unknown[],
  context: OverrideValidationContext,
): ReviewedOverrideSnapshot {
  const allDiagnostics: OverrideDiagnostic[] = [];
  const validOverrides: ReviewedOverride[] = [];
  const validationResults: OverrideValidationResult[] = [];

  // 1. Schema validation pass
  for (const raw of rawRecords) {
    const { override, diagnostics } = validateOverrideSchema(raw);
    allDiagnostics.push(...diagnostics);

    if (override) {
      validOverrides.push(override);
    }
  }

  // 2. Conflict detection across all valid overrides
  const conflictDiagnostics = detectConflicts(validOverrides);
  allDiagnostics.push(...conflictDiagnostics);

  // Build a set of conflicting override IDs for fast lookup
  const conflictingIds = new Set(conflictDiagnostics.map(d => d.overrideId));

  // 3. Eligibility validation pass
  const eligibleOverrides: ReviewedOverride[] = [];

  for (const override of validOverrides) {
    const result = validateOverrideEligibility(override, context);
    const resultDiags = [...result.diagnostics];

    // If conflicting, mark ineligible
    let isEligible = result.eligible;
    if (conflictingIds.has(override.overrideId)) {
      isEligible = false;
    }

    const finalResult: OverrideValidationResult = Object.freeze({
      override: result.override,
      eligible: isEligible,
      diagnostics: Object.freeze(resultDiags),
    });

    validationResults.push(finalResult);
    allDiagnostics.push(...resultDiags);

    if (isEligible) {
      eligibleOverrides.push(override);
    }
  }

  // 4. Sort all output arrays for determinism
  const sortedOverrides = [...validOverrides].sort(compareOverrides);
  const sortedEligible = [...eligibleOverrides].sort(compareOverrides);
  const sortedResults = [...validationResults].sort((a, b) =>
    compareOverrides(a.override, b.override),
  );
  const sortedDiagnostics = [...allDiagnostics].sort(compareDiagnostics);

  // 5. Compute fingerprint for deterministic content identity
  const fingerprint = computeSnapshotFingerprint(sortedOverrides, context.currentTaxonomyVersion);

  return Object.freeze({
    overrides: Object.freeze(sortedOverrides),
    validationResults: Object.freeze(sortedResults),
    eligibleOverrides: Object.freeze(sortedEligible),
    diagnostics: Object.freeze(sortedDiagnostics),
    taxonomyVersion: context.currentTaxonomyVersion,
    fingerprint,
  });
}

// ─────────────────────────────────────────────
// Query Helpers
// ─────────────────────────────────────────────

/**
 * Finds all eligible overrides that apply to a specific agent.
 */
export function getEligibleOverridesForAgent(
  snapshot: ReviewedOverrideSnapshot,
  agentId?: string,
  sourcePath?: string,
): readonly ReviewedOverride[] {
  return snapshot.eligibleOverrides.filter(ov =>
    matchesSelector(ov.agentSelector, agentId, sourcePath),
  );
}

/**
 * Checks whether an override's agent selector matches the given agent identifiers.
 */
export function matchesSelector(
  selector: OverrideAgentSelector,
  agentId?: string,
  sourcePath?: string,
): boolean {
  // An override applies if either selector field matches
  if (selector.agentId && agentId && selector.agentId === agentId) return true;
  if (selector.sourcePath && sourcePath && selector.sourcePath === sourcePath) return true;
  return false;
}

// ─────────────────────────────────────────────
// Internal Utilities
// ─────────────────────────────────────────────

function buildSelectorKey(selector: OverrideAgentSelector): string {
  // Use both fields for grouping to detect same-target conflicts
  const parts: string[] = [];
  if (selector.sourcePath) parts.push(`path:${selector.sourcePath}`);
  if (selector.agentId) parts.push(`id:${selector.agentId}`);
  return parts.sort().join('|');
}

function compareOverrides(a: ReviewedOverride, b: ReviewedOverride): number {
  return a.overrideId.localeCompare(b.overrideId);
}

function compareDiagnostics(a: OverrideDiagnostic, b: OverrideDiagnostic): number {
  const cmp = a.overrideId.localeCompare(b.overrideId);
  if (cmp !== 0) return cmp;
  return a.code.localeCompare(b.code);
}

/**
 * Computes a stable fingerprint over the override content and taxonomy version.
 * Uses a simple hash of serialized canonical data.
 */
function computeSnapshotFingerprint(
  overrides: readonly ReviewedOverride[],
  taxonomyVersion: number,
): string {
  const canonical = JSON.stringify({
    v: 1,
    taxonomyVersion,
    overrides: overrides.map(o => ({
      id: o.overrideId,
      sel: { p: o.agentSelector.sourcePath || '', a: o.agentSelector.agentId || '' },
      sk: o.skillId,
      st: o.reviewStatus,
      rv: o.reviewerId,
      ra: o.rationale,
      ck: o.supportedCapabilityKey,
      dl: o.supportedDeliverable || '',
      tv: o.taxonomyVersion,
    })),
  });

  // Simple FNV-1a-like hash for deterministic fingerprinting without crypto deps
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned 32-bit hex
  return `override-snap-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
