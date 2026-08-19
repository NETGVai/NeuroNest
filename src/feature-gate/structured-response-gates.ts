/**
 * Structured Response Renderer Feature Gates
 *
 * Defines the independent gate topology for the structured response renderer
 * staged rollout. Three gates operate independently:
 *
 * - `chat_timeline`: projection/windowing ownership (canonical timeline as sole projection owner)
 * - `structured_response_renderer`: typed composition surfaces (selects typed block dispatch)
 * - `enhanced_chat_renderer`: legacy compatibility flag only (retains old formatter; cannot
 *   silently select canonical ownership)
 *
 * All gates default OFF. Per-surface rollout flags fall back only to the typed
 * safe generic surface, never to legacy semantic inference.
 *
 * Requirements: 2.4, 21.1, 21.6, 22.9
 */

// ─── Gate Identifiers ───────────────────────────────────────────

/**
 * The three response-rendering gates that participate in the structured response
 * renderer rollout. Each operates independently from the editor-chat gates.
 */
export type StructuredResponseGateId =
  | 'chat_timeline'
  | 'structured_response_renderer'
  | 'enhanced_chat_renderer';

export const STRUCTURED_RESPONSE_GATE_IDS: readonly StructuredResponseGateId[] = [
  'chat_timeline',
  'structured_response_renderer',
  'enhanced_chat_renderer',
] as const;

// ─── Ownership Domain ───────────────────────────────────────────

/**
 * Ownership domains that must have exactly one active owner at any rollout stage.
 */
export type OwnershipDomain =
  | 'projection'
  | 'windowing'
  | 'composition_surfaces'
  | 'legacy_formatting';

/**
 * Describes which gate owns which domain.
 */
export interface GateOwnershipDeclaration {
  gateId: StructuredResponseGateId;
  /** Domains this gate owns when enabled */
  ownedDomains: OwnershipDomain[];
  /** Domains this gate must NOT own (enforced) */
  excludedDomains: OwnershipDomain[];
}

/**
 * The ownership declarations that enforce single-owner semantics.
 *
 * - `chat_timeline` owns projection and windowing.
 * - `structured_response_renderer` owns composition surfaces.
 * - `enhanced_chat_renderer` owns only legacy formatting and cannot own projection or composition.
 */
export const GATE_OWNERSHIP_DECLARATIONS: readonly GateOwnershipDeclaration[] = [
  {
    gateId: 'chat_timeline',
    ownedDomains: ['projection', 'windowing'],
    excludedDomains: ['legacy_formatting'],
  },
  {
    gateId: 'structured_response_renderer',
    ownedDomains: ['composition_surfaces'],
    excludedDomains: ['legacy_formatting', 'projection'],
  },
  {
    gateId: 'enhanced_chat_renderer',
    ownedDomains: ['legacy_formatting'],
    excludedDomains: ['projection', 'windowing', 'composition_surfaces'],
  },
] as const;

// ─── Gate Metadata ──────────────────────────────────────────────

export interface StructuredResponseGateMetadata {
  id: StructuredResponseGateId;
  description: string;
  /** Requirement areas this gate covers */
  requirementAreas: string[];
  /** Role in the rollout topology */
  role: 'ownership' | 'presentation' | 'legacy_compatibility';
  /**
   * When this gate is disabled, per-surface rollout flags fall back to this behavior.
   * `safe_generic` means typed inert output. `none` means the gate has no surface fallback.
   */
  disabledFallback: 'safe_generic' | 'none';
}

export const STRUCTURED_RESPONSE_GATE_METADATA: Record<StructuredResponseGateId, StructuredResponseGateMetadata> = {
  chat_timeline: {
    id: 'chat_timeline',
    description: 'Canonical projection and windowing ownership for the chat timeline',
    requirementAreas: ['R21.1', 'R21.6', 'R22.9'],
    role: 'ownership',
    disabledFallback: 'none',
  },
  structured_response_renderer: {
    id: 'structured_response_renderer',
    description: 'Typed composition surface dispatch for structured response rendering',
    requirementAreas: ['R2.4', 'R21.1', 'R21.6', 'R22.9'],
    role: 'presentation',
    disabledFallback: 'safe_generic',
  },
  enhanced_chat_renderer: {
    id: 'enhanced_chat_renderer',
    description: 'Legacy compatibility flag for existing chat formatting (retained during migration only)',
    requirementAreas: ['R21.6'],
    role: 'legacy_compatibility',
    disabledFallback: 'none',
  },
};

// ─── Gate Configuration ─────────────────────────────────────────

export interface StructuredResponseGateConfig {
  /** All gates default to disabled (off) */
  gates: Record<StructuredResponseGateId, boolean>;
}

export const DEFAULT_STRUCTURED_RESPONSE_GATE_CONFIG: StructuredResponseGateConfig = {
  gates: {
    chat_timeline: false,
    structured_response_renderer: false,
    enhanced_chat_renderer: false,
  },
};

// ─── Ownership Validation ───────────────────────────────────────

export interface OwnershipValidationResult {
  valid: boolean;
  /** Which domain has a conflict (more than one active owner) */
  conflicts: Array<{
    domain: OwnershipDomain;
    claimingGates: StructuredResponseGateId[];
  }>;
  /** Gates that are trying to own excluded domains */
  violations: Array<{
    gateId: StructuredResponseGateId;
    attemptedDomain: OwnershipDomain;
    reason: string;
  }>;
}

/**
 * Validate that the given gate configuration does not produce hidden ownership
 * changes or domain conflicts. Returns a detailed result.
 *
 * Rules enforced:
 * 1. No domain may have more than one active owner.
 * 2. A gate cannot own a domain listed in its `excludedDomains`.
 * 3. `enhanced_chat_renderer` cannot silently select canonical ownership
 *    (projection, windowing, or composition_surfaces).
 */
export function validateOwnership(
  activeGates: ReadonlySet<StructuredResponseGateId>,
): OwnershipValidationResult {
  const conflicts: OwnershipValidationResult['conflicts'] = [];
  const violations: OwnershipValidationResult['violations'] = [];

  // Collect active ownership claims
  const domainOwners = new Map<OwnershipDomain, StructuredResponseGateId[]>();

  for (const decl of GATE_OWNERSHIP_DECLARATIONS) {
    if (!activeGates.has(decl.gateId)) continue;

    // Check exclusion violations
    for (const domain of decl.ownedDomains) {
      if ((decl.excludedDomains as readonly OwnershipDomain[]).includes(domain)) {
        violations.push({
          gateId: decl.gateId,
          attemptedDomain: domain,
          reason: `Gate '${decl.gateId}' declares '${domain}' as both owned and excluded`,
        });
      }
    }

    // Record claims
    for (const domain of decl.ownedDomains) {
      const existing = domainOwners.get(domain) ?? [];
      existing.push(decl.gateId);
      domainOwners.set(domain, existing);
    }
  }

  // Check for multi-owner conflicts
  for (const [domain, owners] of domainOwners.entries()) {
    if (owners.length > 1) {
      conflicts.push({ domain, claimingGates: owners });
    }
  }

  // Check that enhanced_chat_renderer never owns projection/windowing/composition_surfaces
  if (activeGates.has('enhanced_chat_renderer')) {
    const enhancedDecl = GATE_OWNERSHIP_DECLARATIONS.find(
      (d) => d.gateId === 'enhanced_chat_renderer',
    )!;
    for (const excluded of enhancedDecl.excludedDomains) {
      // If enhanced_chat_renderer somehow tries to claim these via code,
      // it should be caught. Here we also check if it's trying to be
      // the sole owner of projection/windowing (hidden ownership change).
      const ownersOfExcluded = domainOwners.get(excluded) ?? [];
      if (ownersOfExcluded.includes('enhanced_chat_renderer')) {
        violations.push({
          gateId: 'enhanced_chat_renderer',
          attemptedDomain: excluded,
          reason: `enhanced_chat_renderer cannot own '${excluded}' — it is a legacy compatibility flag only`,
        });
      }
    }
  }

  return {
    valid: conflicts.length === 0 && violations.length === 0,
    conflicts,
    violations,
  };
}

// ─── Owner Selection ────────────────────────────────────────────

/**
 * Result of selecting the active owner for a given domain.
 */
export interface OwnerSelectionResult {
  domain: OwnershipDomain;
  owner: StructuredResponseGateId | null;
  fallback: 'safe_generic' | 'legacy' | 'none';
}

/**
 * Determine who owns each domain given the current gate state.
 * When no gate is active for a domain, the fallback is:
 * - `composition_surfaces` → `safe_generic` (typed inert output, never legacy inference)
 * - `projection` / `windowing` → `legacy` (existing renderer is the projection owner)
 * - `legacy_formatting` → `none` (only active when enhanced_chat_renderer is on)
 */
export function selectOwners(
  activeGates: ReadonlySet<StructuredResponseGateId>,
): OwnerSelectionResult[] {
  const domains: OwnershipDomain[] = [
    'projection',
    'windowing',
    'composition_surfaces',
    'legacy_formatting',
  ];

  const results: OwnerSelectionResult[] = [];

  for (const domain of domains) {
    let owner: StructuredResponseGateId | null = null;

    for (const decl of GATE_OWNERSHIP_DECLARATIONS) {
      if (activeGates.has(decl.gateId) && decl.ownedDomains.includes(domain)) {
        owner = decl.gateId;
        break;
      }
    }

    let fallback: 'safe_generic' | 'legacy' | 'none';
    if (owner !== null) {
      fallback = 'none';
    } else if (domain === 'composition_surfaces') {
      // Per spec: per-surface rollout flags fall back only to typed safe generic output,
      // never legacy semantic inference.
      fallback = 'safe_generic';
    } else if (domain === 'projection' || domain === 'windowing') {
      // Legacy renderer remains the projection owner before canonical cutover
      fallback = 'legacy';
    } else {
      fallback = 'none';
    }

    results.push({ domain, owner, fallback });
  }

  return results;
}

/**
 * Check if the given gate configuration would cause a hidden ownership change.
 * A hidden ownership change occurs when enabling or disabling a gate silently
 * transfers projection/mutation authority without explicit stage advancement.
 *
 * Requirements: 21.1, 21.6 — exactly one Projection_Owner at every rollout stage.
 */
export function detectsHiddenOwnershipChange(
  previousGates: ReadonlySet<StructuredResponseGateId>,
  nextGates: ReadonlySet<StructuredResponseGateId>,
): { changed: boolean; affectedDomains: OwnershipDomain[]; reason: string } {
  const prevOwners = selectOwners(previousGates);
  const nextOwners = selectOwners(nextGates);

  const affectedDomains: OwnershipDomain[] = [];
  const reasons: string[] = [];

  for (let i = 0; i < prevOwners.length; i++) {
    const prev = prevOwners[i]!;
    const next = nextOwners[i]!;

    // Owner changed without explicit gate activation for that domain
    if (prev.owner !== next.owner) {
      // This is a valid explicit change if the domain's gate was toggled
      const domainGateToggled = GATE_OWNERSHIP_DECLARATIONS.some(
        (d) =>
          d.ownedDomains.includes(prev.domain) &&
          previousGates.has(d.gateId) !== nextGates.has(d.gateId),
      );

      if (!domainGateToggled) {
        affectedDomains.push(prev.domain);
        reasons.push(
          `Domain '${prev.domain}' owner changed from '${prev.owner ?? 'none'}' to '${next.owner ?? 'none'}' without its owning gate being toggled`,
        );
      }
    }
  }

  return {
    changed: affectedDomains.length > 0,
    affectedDomains,
    reason: reasons.join('; '),
  };
}
