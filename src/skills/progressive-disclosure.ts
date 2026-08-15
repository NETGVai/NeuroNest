/**
 * Progressive Disclosure Planner
 *
 * Implements the enforceable three-level lifecycle that indexes metadata (Level 1),
 * conditionally loads bodies (Level 2), and selectively loads references or scripts
 * (Level 3) under bounded budgets with recorded reasons.
 *
 * Requirements: 43.1, 43.2, 43.3, 43.4, 43.5, 43.6, 43.8
 *
 * Design component: ProgressiveDisclosurePlanner (Section 14 of design.md)
 */

// ---------------------------------------------------------------------------
// Types and interfaces
// ---------------------------------------------------------------------------

/** Level 1 metadata entry for each enabled skill in the catalog. */
export interface SkillMetadataEntry {
  skillId: string;
  name: string;
  version: string;
  triggers: string[];
  exclusions: string[];
  capabilities: string[];
  compatibility: string[];
  provenance: string;
  tokenEstimate: number;
  enabled: boolean;
  /** Priority value for deterministic ordering (lower = higher priority). */
  priority?: number;
}

/** The immutable catalog snapshot fingerprint used for consistency checks. */
export interface CatalogSnapshotRef {
  snapshotId: string;
  fingerprint: string;
  timestamp: number;
}

/** Describes a validated trigger match or explicit task assignment for a skill. */
export interface DisclosureReason {
  kind: 'trigger' | 'assignment';
  /** For triggers, the matched trigger pattern. For assignments, the task/run ID. */
  source: string;
  validatedAt: number;
}

/** Level 2 loaded body record. */
export interface LoadedBody {
  skillId: string;
  version: string;
  reason: DisclosureReason;
  tokens: number;
  provenance: string;
  contentFingerprint: string;
  loadedAt: number;
  /** The actual body content (prompt-visible when active). */
  content: string;
}

/** Level 3 asset request descriptor. */
export interface Level3AssetRequest {
  skillId: string;
  assetId: string;
  assetType: 'reference' | 'script';
  purpose: string;
  declaredFingerprint: string;
}

/** Typed diagnostic categories for blocked operations. */
export type BlockDiagnosticKind =
  | 'zero_limit'
  | 'budget_exceeded'
  | 'capacity_pressure'
  | 'body_not_loaded'
  | 'asset_limit_reached'
  | 'cycle_detected'
  | 'churn_detected'
  | 'fail_closed'
  | 'step_budget_exceeded'
  | 'run_budget_exceeded'
  | 'not_in_metadata';

/** Typed diagnostic emitted when an operation is blocked. */
export interface BlockDiagnostic {
  kind: BlockDiagnosticKind;
  skillId: string;
  assetId?: string;
  assetType?: 'reference' | 'script';
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

/** Fail-closed condition kind. */
export type FailClosedCondition =
  | 'stale'
  | 'cyclic'
  | 'missing'
  | 'disabled'
  | 'uninstalled'
  | 'incompatible'
  | 'multiply_resolved';

/** Record of a fail-closed block requiring manual review. */
export interface FailClosedRecord {
  skillId: string;
  assetId?: string;
  condition: FailClosedCondition;
  message: string;
  blockedAt: number;
  revalidated: boolean;
  reviewedAt?: number;
}

/** Result of a Level 3 load attempt. */
export type Level3LoadResult =
  | { status: 'loaded'; asset: LoadedAsset }
  | { status: 'load_blocked'; reason: string; metadata: Level3BlockedRecord; diagnostic: BlockDiagnostic };

/** Level 3 loaded asset record. */
export interface LoadedAsset {
  skillId: string;
  assetId: string;
  assetType: 'reference' | 'script';
  purpose: string;
  declaredFingerprint: string;
  tokens: number;
  content: string;
  loadedAt: number;
}

/** Record persisted when a Level 3 load is blocked by policy or limits. */
export interface Level3BlockedRecord {
  skillId: string;
  assetId: string;
  assetType: 'reference' | 'script';
  purpose: string;
  declaredFingerprint: string;
  reason: string;
  blockedAt: number;
}

/** Result of a Level 2 load attempt with typed diagnostics. */
export type Level2LoadResult =
  | { status: 'loaded'; body: LoadedBody }
  | { status: 'load_blocked'; reason: string; diagnostic: BlockDiagnostic };

/** Disclosure event persisted for audit/evidence. */
export interface DisclosureEvent {
  id: string;
  runId: string;
  stepId: string;
  skillId: string;
  level: 1 | 2 | 3;
  action: 'index' | 'load' | 'unload' | 'block';
  assetId?: string;
  reason: string;
  version: string;
  tokens: number;
  fingerprint: string;
  timestamp: number;
}

/** Configuration for budget enforcement. */
export interface DisclosureBudget {
  /** Maximum tokens for all Level 2 bodies in a single step. */
  perStepTokenBudget: number;
  /** Maximum tokens for all Level 2 bodies across the entire run. */
  perRunTokenBudget: number;
  /** Maximum number of Level 3 references that can be loaded. */
  maxLevel3References: number;
  /** Maximum number of Level 3 scripts that can be loaded. */
  maxLevel3Scripts: number;
  /** Maximum entries in the metadata index (Level 1). */
  maxMetadataEntries: number;
  /** Capacity pressure threshold (fraction of budget before blocking). Defaults to 0.9 */
  capacityPressureThreshold?: number;
  /** Maximum load/unload cycles for the same asset before churn blocking. Defaults to 3 */
  maxChurnCycles?: number;
}

/** State representing what is currently disclosed in active prompt context. */
export interface DisclosureState {
  /** Level 1 metadata index — always available for enabled skills. */
  metadataIndex: ReadonlyMap<string, SkillMetadataEntry>;
  /** Level 2 loaded bodies — only for active trigger/assignment. */
  loadedBodies: ReadonlyMap<string, LoadedBody>;
  /** Level 3 loaded assets — only for specifically requested references/scripts. */
  loadedAssets: ReadonlyMap<string, LoadedAsset>;
  /** Level 3 blocked assets — persisted when policy/limits deny loading. */
  blockedAssets: ReadonlyMap<string, Level3BlockedRecord>;
  /** Tokens currently consumed by Level 2 bodies. */
  level2TokensUsed: number;
  /** Tokens currently consumed by Level 3 assets. */
  level3TokensUsed: number;
}

/** Inactive cache entry: retains content bytes but is NOT prompt-visible. */
export interface InactiveCacheEntry {
  skillId: string;
  content: string;
  cachedAt: number;
  lastActiveAt: number;
}

/** Churn tracking record for cycle/churn detection. */
interface ChurnRecord {
  loadCount: number;
  unloadCount: number;
  lastLoadAt: number;
  lastUnloadAt: number;
}

// ---------------------------------------------------------------------------
// Progressive Disclosure Planner
// ---------------------------------------------------------------------------

export class ProgressiveDisclosurePlanner {
  private metadataIndex: Map<string, SkillMetadataEntry> = new Map();
  private loadedBodies: Map<string, LoadedBody> = new Map();
  private loadedAssets: Map<string, LoadedAsset> = new Map();
  private blockedAssets: Map<string, Level3BlockedRecord> = new Map();
  private inactiveCache: Map<string, InactiveCacheEntry> = new Map();
  private disclosureEvents: DisclosureEvent[] = [];
  private diagnostics: BlockDiagnostic[] = [];
  private budget: DisclosureBudget;
  private runTokensUsed = 0;
  private stepTokensUsed = 0;
  private currentRunId = '';
  private currentStepId = '';
  private catalogRef: CatalogSnapshotRef | null = null;

  /** Fail-closed records requiring manual review. */
  private failClosedRecords: Map<string, FailClosedRecord> = new Map();

  /** Churn tracking: key is skillId or skillId:assetId */
  private churnTracker: Map<string, ChurnRecord> = new Map();

  /** Track which bodies have been unloaded at step-end (requiring re-check on reload). */
  private stepEndUnloaded: Set<string> = new Set();

  constructor(budget: DisclosureBudget) {
    this.budget = budget;
  }

  // -------------------------------------------------------------------------
  // Level 1 — Skill Metadata Index
  // -------------------------------------------------------------------------

  /**
   * Populate the Level 1 metadata index from the immutable catalog snapshot.
   * Only enabled skills are indexed. Bodies and references are NOT loaded.
   *
   * Requirement 43.1: Keep Level 1 entries available for every enabled skill
   * without loading bodies or references.
   */
  indexMetadata(
    entries: SkillMetadataEntry[],
    catalogRef: CatalogSnapshotRef,
  ): void {
    this.catalogRef = catalogRef;
    this.metadataIndex.clear();

    const bounded = entries.slice(0, this.budget.maxMetadataEntries);
    for (const entry of bounded) {
      if (entry.enabled) {
        this.metadataIndex.set(entry.skillId, entry);
      }
    }
  }

  /**
   * Get the full Level 1 metadata index.
   * Always available without triggering any body or reference loads.
   */
  getMetadataIndex(): ReadonlyMap<string, SkillMetadataEntry> {
    return this.metadataIndex;
  }

  /**
   * Check if a skill exists in the metadata index.
   */
  hasSkillMetadata(skillId: string): boolean {
    return this.metadataIndex.has(skillId);
  }

  // -------------------------------------------------------------------------
  // Level 2 — Skill Body Loading
  // -------------------------------------------------------------------------

  /**
   * Reactively load a Level 2 Skill_Body when an active validated trigger or
   * explicit task assignment exists.
   *
   * Requirement 43.2:
   * - Load Level 2 only for an active validated trigger or explicit assignment.
   * - Record reason, version, tokens, and provenance.
   * - Inactive caches must remain prompt-invisible.
   *
   * Requirement 43.4: Enforce per-run/per-step budgets and deterministic priority.
   * Requirement 43.5: Fail closed on stale/cyclic/missing/disabled/incompatible/multiply resolved.
   * Requirement 43.8: Prevent context exhaustion with capacity pressure blocking.
   *
   * Returns the loaded body, or null if budget/policy prevents loading.
   */
  loadLevel2Body(
    skillId: string,
    reason: DisclosureReason,
    bodyContent: string,
    bodyFingerprint: string,
    tokenCount: number,
    provenance: string,
  ): LoadedBody | null {
    // Must be in the metadata index
    const metadata = this.metadataIndex.get(skillId);
    if (!metadata) {
      this.emitDiagnostic({
        kind: 'not_in_metadata',
        skillId,
        message: `Skill ${skillId} not found in metadata index`,
        timestamp: Date.now(),
      });
      return null;
    }

    // Check fail-closed conditions
    if (this.isFailClosed(skillId)) {
      this.emitDiagnostic({
        kind: 'fail_closed',
        skillId,
        message: `Skill ${skillId} is blocked pending manual review`,
        timestamp: Date.now(),
        details: { record: this.failClosedRecords.get(skillId) },
      });
      return null;
    }

    // Validate reason — must be a trigger or assignment
    if (reason.kind !== 'trigger' && reason.kind !== 'assignment') {
      return null;
    }

    // Check cycle/churn for body loads
    if (this.isChurnBlocked(skillId)) {
      this.emitDiagnostic({
        kind: 'churn_detected',
        skillId,
        message: `Skill ${skillId} blocked due to excessive load/unload churn`,
        timestamp: Date.now(),
        details: { churn: this.churnTracker.get(skillId) },
      });
      return null;
    }

    // Budget check: capacity pressure (approaching limit blocks)
    const pressureThreshold = this.budget.capacityPressureThreshold ?? 0.9;

    // Budget check: per-step
    if (this.stepTokensUsed + tokenCount > this.budget.perStepTokenBudget) {
      this.emitDiagnostic({
        kind: 'step_budget_exceeded',
        skillId,
        message: `Per-step token budget would be exceeded (${this.stepTokensUsed + tokenCount} > ${this.budget.perStepTokenBudget})`,
        timestamp: Date.now(),
        details: { current: this.stepTokensUsed, requested: tokenCount, limit: this.budget.perStepTokenBudget },
      });
      return null;
    }

    // Budget check: per-run
    if (this.runTokensUsed + tokenCount > this.budget.perRunTokenBudget) {
      this.emitDiagnostic({
        kind: 'run_budget_exceeded',
        skillId,
        message: `Per-run token budget would be exceeded (${this.runTokensUsed + tokenCount} > ${this.budget.perRunTokenBudget})`,
        timestamp: Date.now(),
        details: { current: this.runTokensUsed, requested: tokenCount, limit: this.budget.perRunTokenBudget },
      });
      return null;
    }

    // Capacity pressure check (warn-level blocking before hard limit)
    if (this.stepTokensUsed + tokenCount > this.budget.perStepTokenBudget * pressureThreshold &&
        this.stepTokensUsed + tokenCount <= this.budget.perStepTokenBudget) {
      this.emitDiagnostic({
        kind: 'capacity_pressure',
        skillId,
        message: `Approaching per-step token budget capacity (${((this.stepTokensUsed + tokenCount) / this.budget.perStepTokenBudget * 100).toFixed(1)}% used)`,
        timestamp: Date.now(),
        details: { current: this.stepTokensUsed, requested: tokenCount, limit: this.budget.perStepTokenBudget, threshold: pressureThreshold },
      });
      return null;
    }

    const loadedBody: LoadedBody = {
      skillId,
      version: metadata.version,
      reason,
      tokens: tokenCount,
      provenance,
      contentFingerprint: bodyFingerprint,
      loadedAt: Date.now(),
      content: bodyContent,
    };

    this.loadedBodies.set(skillId, loadedBody);
    this.stepTokensUsed += tokenCount;
    this.runTokensUsed += tokenCount;

    // Remove from inactive cache if present (it's now active/prompt-visible)
    this.inactiveCache.delete(skillId);

    // Track churn
    this.trackLoad(skillId);

    // Record disclosure event
    this.recordEvent({
      skillId,
      level: 2,
      action: 'load',
      reason: `${reason.kind}: ${reason.source}`,
      version: metadata.version,
      tokens: tokenCount,
      fingerprint: bodyFingerprint,
    });

    return loadedBody;
  }

  /**
   * Load a Level 2 body with typed result (returns diagnostic on block).
   */
  loadLevel2BodyTyped(
    skillId: string,
    reason: DisclosureReason,
    bodyContent: string,
    bodyFingerprint: string,
    tokenCount: number,
    provenance: string,
  ): Level2LoadResult {
    const body = this.loadLevel2Body(skillId, reason, bodyContent, bodyFingerprint, tokenCount, provenance);
    if (body) {
      return { status: 'loaded', body };
    }
    // Return the last diagnostic emitted
    const lastDiag = this.diagnostics[this.diagnostics.length - 1];
    return {
      status: 'load_blocked',
      reason: lastDiag?.message ?? 'Unknown block reason',
      diagnostic: lastDiag ?? {
        kind: 'not_in_metadata',
        skillId,
        message: 'Unknown block reason',
        timestamp: Date.now(),
      },
    };
  }

  /**
   * Check whether a Level 2 body is currently loaded (prompt-visible).
   */
  isBodyLoaded(skillId: string): boolean {
    return this.loadedBodies.has(skillId);
  }

  /**
   * Get a loaded body by skill ID.
   * Returns null if the body is not currently loaded.
   */
  getLoadedBody(skillId: string): LoadedBody | null {
    return this.loadedBodies.get(skillId) ?? null;
  }

  /**
   * Unload a Level 2 body from active prompt context.
   * Moves it to the inactive cache (retains bytes but prompt-invisible).
   */
  unloadBody(skillId: string): void {
    const body = this.loadedBodies.get(skillId);
    if (!body) return;

    // Move to inactive cache
    this.inactiveCache.set(skillId, {
      skillId,
      content: body.content,
      cachedAt: Date.now(),
      lastActiveAt: body.loadedAt,
    });

    this.loadedBodies.delete(skillId);
    this.stepTokensUsed -= body.tokens;

    // Track churn
    this.trackUnload(skillId);

    // Record disclosure event
    this.recordEvent({
      skillId,
      level: 2,
      action: 'unload',
      reason: 'no longer active',
      version: body.version,
      tokens: body.tokens,
      fingerprint: body.contentFingerprint,
    });
  }

  /**
   * Check if a body is in the inactive cache (prompt-invisible).
   */
  isInInactiveCache(skillId: string): boolean {
    return this.inactiveCache.has(skillId);
  }

  // -------------------------------------------------------------------------
  // Fail-Closed Blocking (Requirement 43.5)
  // -------------------------------------------------------------------------

  /**
   * Mark a skill or asset as fail-closed, blocking all loads until manual review.
   * Requirement 43.5: Block stale, cyclic, missing, disabled, uninstalled,
   * incompatible, or multiply resolved bodies and assets.
   */
  markFailClosed(
    skillId: string,
    condition: FailClosedCondition,
    message: string,
    assetId?: string,
  ): FailClosedRecord {
    const key = assetId ? `${skillId}:${assetId}` : skillId;
    const record: FailClosedRecord = {
      skillId,
      assetId,
      condition,
      message,
      blockedAt: Date.now(),
      revalidated: false,
    };
    this.failClosedRecords.set(key, record);

    this.emitDiagnostic({
      kind: 'fail_closed',
      skillId,
      assetId,
      message: `Fail-closed: ${condition} — ${message}`,
      timestamp: Date.now(),
      details: { condition },
    });

    return record;
  }

  /**
   * Check if a skill or asset is blocked by a fail-closed condition.
   */
  isFailClosed(skillId: string, assetId?: string): boolean {
    const key = assetId ? `${skillId}:${assetId}` : skillId;
    const record = this.failClosedRecords.get(key);
    return record !== undefined && !record.revalidated;
  }

  /**
   * Get the fail-closed record for a skill or asset.
   */
  getFailClosedRecord(skillId: string, assetId?: string): FailClosedRecord | null {
    const key = assetId ? `${skillId}:${assetId}` : skillId;
    return this.failClosedRecords.get(key) ?? null;
  }

  /**
   * Revalidate and clear a fail-closed condition after manual review.
   */
  revalidateFailClosed(skillId: string, assetId?: string): boolean {
    const key = assetId ? `${skillId}:${assetId}` : skillId;
    const record = this.failClosedRecords.get(key);
    if (!record) return false;
    record.revalidated = true;
    record.reviewedAt = Date.now();
    return true;
  }

  // -------------------------------------------------------------------------
  // Step-End Unloading (Requirement 43.6)
  // -------------------------------------------------------------------------

  /**
   * End the current step — mandatory unload of all bodies and Level 3 assets.
   *
   * Requirement 43.6: At step end, unload affected Skill_Body and Skill_Reference
   * even if a later step is expected to need them. A later step SHALL independently
   * re-evaluate eligibility and reload only after applicable checks pass.
   */
  endStep(): void {
    // Unload all Level 3 assets
    for (const [key, asset] of this.loadedAssets) {
      this.recordEvent({
        skillId: asset.skillId,
        level: 3,
        action: 'unload',
        assetId: asset.assetId,
        reason: 'step-end mandatory unload',
        version: this.metadataIndex.get(asset.skillId)?.version ?? 'unknown',
        tokens: asset.tokens,
        fingerprint: asset.declaredFingerprint,
      });
      this.trackUnload(`${asset.skillId}:${asset.assetId}`);
    }
    this.loadedAssets.clear();

    // Unload all Level 2 bodies
    for (const [skillId, body] of this.loadedBodies) {
      // Move to inactive cache
      this.inactiveCache.set(skillId, {
        skillId,
        content: body.content,
        cachedAt: Date.now(),
        lastActiveAt: body.loadedAt,
      });

      this.recordEvent({
        skillId,
        level: 2,
        action: 'unload',
        reason: 'step-end mandatory unload',
        version: body.version,
        tokens: body.tokens,
        fingerprint: body.contentFingerprint,
      });
      this.trackUnload(skillId);
      this.stepEndUnloaded.add(skillId);
    }
    this.loadedBodies.clear();
    this.stepTokensUsed = 0;
  }

  /**
   * Check if a body was unloaded at step-end (requires independent re-check).
   */
  wasStepEndUnloaded(skillId: string): boolean {
    return this.stepEndUnloaded.has(skillId);
  }

  // -------------------------------------------------------------------------
  // Level 3 — Reference and Script Loading
  // -------------------------------------------------------------------------

  /**
   * Resolve a specifically requested Level 3 reference or script.
   *
   * Requirement 43.3:
   * - Record purpose and declared fingerprint FIRST.
   * - Persist `load_blocked` when policy or limits deny loading.
   *
   * Requirement 43.4: Enforce separate maximums for references and scripts.
   * Zero prevents every new load of that type.
   *
   * Requirement 43.5: Fail-closed on stale/cyclic/missing/disabled/incompatible.
   * Requirement 43.8: Block on cycles, churn, or capacity pressure.
   *
   * Returns the load result (loaded or blocked).
   */
  loadLevel3Asset(
    request: Level3AssetRequest,
    assetContent: string,
    tokenCount: number,
  ): Level3LoadResult {
    const { skillId, assetId, assetType, purpose, declaredFingerprint } = request;

    // Check fail-closed for the specific asset
    if (this.isFailClosed(skillId, assetId) || this.isFailClosed(skillId)) {
      const diag = this.emitDiagnostic({
        kind: 'fail_closed',
        skillId,
        assetId,
        assetType,
        message: `Asset ${skillId}:${assetId} blocked pending manual review`,
        timestamp: Date.now(),
      });
      const blocked = this.blockAsset(request, 'Blocked pending manual review (fail-closed)');
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // The skill body must be currently loaded for Level 3 to be eligible
    if (!this.loadedBodies.has(skillId)) {
      const diag = this.emitDiagnostic({
        kind: 'body_not_loaded',
        skillId,
        assetId,
        assetType,
        message: `Skill body not loaded for ${skillId}`,
        timestamp: Date.now(),
      });
      const blocked = this.blockAsset(request, 'Skill body not loaded');
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // Check zero-limit enforcement (Requirement 43.4)
    const maxCount = assetType === 'reference'
      ? this.budget.maxLevel3References
      : this.budget.maxLevel3Scripts;

    if (maxCount === 0) {
      const diag = this.emitDiagnostic({
        kind: 'zero_limit',
        skillId,
        assetId,
        assetType,
        message: `Zero-limit: No new ${assetType} loads permitted (max${assetType === 'reference' ? 'Level3References' : 'Level3Scripts'} = 0)`,
        timestamp: Date.now(),
        details: { assetType, limit: 0 },
      });
      const blocked = this.blockAsset(
        request,
        `Zero ${assetType} limit — no new loads permitted`,
      );
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // Check cycle/churn for this specific asset
    const assetKey = `${skillId}:${assetId}`;
    if (this.isChurnBlocked(assetKey)) {
      const diag = this.emitDiagnostic({
        kind: 'churn_detected',
        skillId,
        assetId,
        assetType,
        message: `Asset ${assetKey} blocked due to excessive load/unload churn`,
        timestamp: Date.now(),
        details: { churn: this.churnTracker.get(assetKey) },
      });
      const blocked = this.blockAsset(request, 'Blocked due to excessive churn');
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // Check budget: max references or scripts
    const currentCount = this.countLoadedAssetsByType(assetType);
    if (currentCount >= maxCount) {
      const diag = this.emitDiagnostic({
        kind: 'asset_limit_reached',
        skillId,
        assetId,
        assetType,
        message: `Maximum ${assetType} limit reached (${currentCount}/${maxCount})`,
        timestamp: Date.now(),
        details: { current: currentCount, max: maxCount },
      });
      const blocked = this.blockAsset(
        request,
        `Maximum ${assetType} limit reached (${maxCount})`,
      );
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // Check token budget — capacity pressure
    const pressureThreshold = this.budget.capacityPressureThreshold ?? 0.9;
    if (this.stepTokensUsed + tokenCount > this.budget.perStepTokenBudget * pressureThreshold) {
      // If it exceeds the hard limit, block with budget_exceeded
      if (this.stepTokensUsed + tokenCount > this.budget.perStepTokenBudget) {
        const diag = this.emitDiagnostic({
          kind: 'step_budget_exceeded',
          skillId,
          assetId,
          assetType,
          message: `Per-step token budget exceeded (${this.stepTokensUsed + tokenCount} > ${this.budget.perStepTokenBudget})`,
          timestamp: Date.now(),
          details: { current: this.stepTokensUsed, requested: tokenCount, limit: this.budget.perStepTokenBudget },
        });
        const blocked = this.blockAsset(request, 'Per-step token budget exceeded');
        return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
      }
      // Capacity pressure: approaching limit
      const diag = this.emitDiagnostic({
        kind: 'capacity_pressure',
        skillId,
        assetId,
        assetType,
        message: `Capacity pressure: approaching step budget (${((this.stepTokensUsed + tokenCount) / this.budget.perStepTokenBudget * 100).toFixed(1)}%)`,
        timestamp: Date.now(),
        details: { current: this.stepTokensUsed, requested: tokenCount, limit: this.budget.perStepTokenBudget, threshold: pressureThreshold },
      });
      const blocked = this.blockAsset(request, 'Capacity pressure — approaching token budget limit');
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    if (this.runTokensUsed + tokenCount > this.budget.perRunTokenBudget) {
      const diag = this.emitDiagnostic({
        kind: 'run_budget_exceeded',
        skillId,
        assetId,
        assetType,
        message: `Per-run token budget exceeded (${this.runTokensUsed + tokenCount} > ${this.budget.perRunTokenBudget})`,
        timestamp: Date.now(),
        details: { current: this.runTokensUsed, requested: tokenCount, limit: this.budget.perRunTokenBudget },
      });
      const blocked = this.blockAsset(request, 'Per-run token budget exceeded');
      return { status: 'load_blocked', reason: blocked.reason, metadata: blocked, diagnostic: diag };
    }

    // Load the asset
    const loadedAsset: LoadedAsset = {
      skillId,
      assetId,
      assetType,
      purpose,
      declaredFingerprint,
      tokens: tokenCount,
      content: assetContent,
      loadedAt: Date.now(),
    };

    this.loadedAssets.set(assetKey, loadedAsset);
    this.stepTokensUsed += tokenCount;
    this.runTokensUsed += tokenCount;

    // Track churn
    this.trackLoad(assetKey);

    // Record disclosure event
    this.recordEvent({
      skillId,
      level: 3,
      action: 'load',
      assetId,
      reason: purpose,
      version: this.metadataIndex.get(skillId)?.version ?? 'unknown',
      tokens: tokenCount,
      fingerprint: declaredFingerprint,
    });

    return { status: 'loaded', asset: loadedAsset };
  }

  /**
   * Unload a Level 3 asset from active prompt context.
   */
  unloadAsset(skillId: string, assetId: string): void {
    const key = `${skillId}:${assetId}`;
    const asset = this.loadedAssets.get(key);
    if (!asset) return;

    this.loadedAssets.delete(key);
    this.stepTokensUsed -= asset.tokens;

    // Track churn
    this.trackUnload(key);

    this.recordEvent({
      skillId,
      level: 3,
      action: 'unload',
      assetId,
      reason: 'no longer needed',
      version: this.metadataIndex.get(skillId)?.version ?? 'unknown',
      tokens: asset.tokens,
      fingerprint: asset.declaredFingerprint,
    });
  }

  /**
   * Check if a Level 3 asset load is blocked.
   */
  isAssetBlocked(skillId: string, assetId: string): boolean {
    const key = `${skillId}:${assetId}`;
    return this.blockedAssets.has(key);
  }

  /**
   * Get a blocked asset record by skill and asset ID.
   */
  getBlockedAsset(skillId: string, assetId: string): Level3BlockedRecord | null {
    const key = `${skillId}:${assetId}`;
    return this.blockedAssets.get(key) ?? null;
  }

  // -------------------------------------------------------------------------
  // Deterministic Priority Ordering (Requirement 43.4)
  // -------------------------------------------------------------------------

  /**
   * Get skills ordered by deterministic priority for budget-constrained loading.
   * Order: priority (ascending), then tokenEstimate (ascending), then skillId (alphabetical).
   */
  getSkillsByPriority(): SkillMetadataEntry[] {
    const entries = Array.from(this.metadataIndex.values());
    return entries.sort((a, b) => {
      // Priority: lower number = higher priority (default to Infinity if not set)
      const priA = a.priority ?? Infinity;
      const priB = b.priority ?? Infinity;
      if (priA !== priB) return priA - priB;
      // Token estimate: smaller first
      if (a.tokenEstimate !== b.tokenEstimate) return a.tokenEstimate - b.tokenEstimate;
      // Canonical ID: alphabetical
      return a.skillId.localeCompare(b.skillId);
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Get all block diagnostics emitted during this run.
   */
  getDiagnostics(): readonly BlockDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * Get diagnostics filtered by kind.
   */
  getDiagnosticsByKind(kind: BlockDiagnosticKind): BlockDiagnostic[] {
    return this.diagnostics.filter(d => d.kind === kind);
  }

  // -------------------------------------------------------------------------
  // State and Context Management
  // -------------------------------------------------------------------------

  /**
   * Begin a new run context, resetting run-level accumulators.
   */
  beginRun(runId: string): void {
    this.currentRunId = runId;
    this.currentStepId = '';
    this.runTokensUsed = 0;
    this.stepTokensUsed = 0;
    this.disclosureEvents = [];
    this.diagnostics = [];
    this.loadedBodies.clear();
    this.loadedAssets.clear();
    this.blockedAssets.clear();
    this.inactiveCache.clear();
    this.failClosedRecords.clear();
    this.churnTracker.clear();
    this.stepEndUnloaded.clear();
  }

  /**
   * Begin a new step within the current run, resetting step-level accumulators.
   */
  beginStep(stepId: string): void {
    this.currentStepId = stepId;
    this.stepTokensUsed = 0;
    this.stepEndUnloaded.clear();
  }

  /**
   * Get a complete snapshot of current disclosure state.
   */
  getState(): DisclosureState {
    return {
      metadataIndex: new Map(this.metadataIndex),
      loadedBodies: new Map(this.loadedBodies),
      loadedAssets: new Map(this.loadedAssets),
      blockedAssets: new Map(this.blockedAssets),
      level2TokensUsed: this.computeLevel2Tokens(),
      level3TokensUsed: this.computeLevel3Tokens(),
    };
  }

  /**
   * Get all disclosure events for audit/evidence.
   */
  getDisclosureEvents(): readonly DisclosureEvent[] {
    return this.disclosureEvents;
  }

  /**
   * Get the current budget usage.
   */
  getBudgetUsage(): {
    stepTokensUsed: number;
    runTokensUsed: number;
    level3ReferencesLoaded: number;
    level3ScriptsLoaded: number;
  } {
    return {
      stepTokensUsed: this.stepTokensUsed,
      runTokensUsed: this.runTokensUsed,
      level3ReferencesLoaded: this.countLoadedAssetsByType('reference'),
      level3ScriptsLoaded: this.countLoadedAssetsByType('script'),
    };
  }

  /**
   * Get the catalog snapshot reference this planner is bound to.
   */
  getCatalogRef(): CatalogSnapshotRef | null {
    return this.catalogRef;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private blockAsset(request: Level3AssetRequest, reason: string): Level3BlockedRecord {
    const key = `${request.skillId}:${request.assetId}`;
    const record: Level3BlockedRecord = {
      skillId: request.skillId,
      assetId: request.assetId,
      assetType: request.assetType,
      purpose: request.purpose,
      declaredFingerprint: request.declaredFingerprint,
      reason,
      blockedAt: Date.now(),
    };

    this.blockedAssets.set(key, record);

    // Record disclosure event
    this.recordEvent({
      skillId: request.skillId,
      level: 3,
      action: 'block',
      assetId: request.assetId,
      reason,
      version: this.metadataIndex.get(request.skillId)?.version ?? 'unknown',
      tokens: 0,
      fingerprint: request.declaredFingerprint,
    });

    return record;
  }

  private emitDiagnostic(diagnostic: BlockDiagnostic): BlockDiagnostic {
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }

  private recordEvent(params: {
    skillId: string;
    level: 1 | 2 | 3;
    action: 'index' | 'load' | 'unload' | 'block';
    assetId?: string;
    reason: string;
    version: string;
    tokens: number;
    fingerprint: string;
  }): void {
    const event: DisclosureEvent = {
      id: `de-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: this.currentRunId,
      stepId: this.currentStepId,
      skillId: params.skillId,
      level: params.level,
      action: params.action,
      assetId: params.assetId,
      reason: params.reason,
      version: params.version,
      tokens: params.tokens,
      fingerprint: params.fingerprint,
      timestamp: Date.now(),
    };

    this.disclosureEvents.push(event);
  }

  private countLoadedAssetsByType(assetType: 'reference' | 'script'): number {
    let count = 0;
    for (const asset of this.loadedAssets.values()) {
      if (asset.assetType === assetType) {
        count++;
      }
    }
    return count;
  }

  private computeLevel2Tokens(): number {
    let total = 0;
    for (const body of this.loadedBodies.values()) {
      total += body.tokens;
    }
    return total;
  }

  private computeLevel3Tokens(): number {
    let total = 0;
    for (const asset of this.loadedAssets.values()) {
      total += asset.tokens;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Churn/Cycle Detection (Requirement 43.8)
  // -------------------------------------------------------------------------

  private trackLoad(key: string): void {
    const record = this.churnTracker.get(key) ?? { loadCount: 0, unloadCount: 0, lastLoadAt: 0, lastUnloadAt: 0 };
    record.loadCount++;
    record.lastLoadAt = Date.now();
    this.churnTracker.set(key, record);
  }

  private trackUnload(key: string): void {
    const record = this.churnTracker.get(key) ?? { loadCount: 0, unloadCount: 0, lastLoadAt: 0, lastUnloadAt: 0 };
    record.unloadCount++;
    record.lastUnloadAt = Date.now();
    this.churnTracker.set(key, record);
  }

  /**
   * Check if a key (skillId or skillId:assetId) is blocked due to excessive churn.
   * Churn is detected when the number of complete load/unload cycles exceeds the threshold.
   */
  private isChurnBlocked(key: string): boolean {
    const maxCycles = this.budget.maxChurnCycles ?? 3;
    const record = this.churnTracker.get(key);
    if (!record) return false;
    // A cycle is a load followed by an unload. Count = min(loads, unloads)
    const cycles = Math.min(record.loadCount, record.unloadCount);
    return cycles >= maxCycles;
  }

  /**
   * Get the churn record for a given key (public, for testing).
   */
  getChurnRecord(key: string): ChurnRecord | null {
    return this.churnTracker.get(key) ?? null;
  }
}
