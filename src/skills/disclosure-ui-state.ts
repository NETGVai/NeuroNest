/**
 * Disclosure UI State Service
 *
 * Projects each skill's current disclosure state (indexed/triggered/loaded/cached/
 * unloaded/pinned/excluded/blocked) with reasons, versions, token use, and provenance.
 *
 * Provides authorized users with the ability to preview pin/exclude/request effects
 * and records complete disclosure Evidence (position, timing, fingerprint, provenance).
 *
 * Requirements: 43.7, 51.6, 51.8
 */

import type {
  SkillMetadataEntry,
  LoadedBody,
  LoadedAsset,
  Level3BlockedRecord,
  InactiveCacheEntry,
  FailClosedRecord,
  DisclosureEvent,
  DisclosureState,
  ProgressiveDisclosurePlanner,
} from './progressive-disclosure.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Possible disclosure UI states for a skill. */
export type DisclosureUIStatus =
  | 'indexed'
  | 'triggered'
  | 'loaded'
  | 'cached'
  | 'unloaded'
  | 'pinned'
  | 'excluded'
  | 'blocked';

/** Complete disclosure state record for a single skill in the UI. */
export interface SkillDisclosureUIEntry {
  skillId: string;
  status: DisclosureUIStatus;
  reason: string;
  version: string;
  tokenUsage: number;
  provenance: string;
  /** When the skill entered this state */
  stateTimestamp: number;
  /** Content fingerprint if loaded (Level 2 or 3) */
  contentFingerprint?: string;
  /** Loaded Level 3 assets for this skill */
  loadedAssets: LoadedAssetSummary[];
  /** Blocked Level 3 assets for this skill */
  blockedAssets: BlockedAssetSummary[];
}

/** Summary of a loaded Level 3 asset for UI display. */
export interface LoadedAssetSummary {
  assetId: string;
  assetType: 'reference' | 'script';
  tokens: number;
  purpose: string;
  fingerprint: string;
}

/** Summary of a blocked Level 3 asset for UI display. */
export interface BlockedAssetSummary {
  assetId: string;
  assetType: 'reference' | 'script';
  reason: string;
  fingerprint: string;
}

/** Pin configuration for a skill. */
export interface PinConfig {
  skillId: string;
  pinnedBy: string;
  pinnedAt: number;
  reason: string;
}

/** Exclusion configuration for a skill. */
export interface ExcludeConfig {
  skillId: string;
  excludedBy: string;
  excludedAt: number;
  reason: string;
}

/** Preview result for a pin/exclude/request operation. */
export interface EffectPreview {
  action: 'pin' | 'exclude' | 'request';
  skillId: string;
  /** What the prompt would look like after the action */
  tokenDelta: number;
  /** Skills affected by the action (e.g. conflicts, dependencies) */
  affectedSkills: string[];
  /** Whether the action is safe to apply (passes bundle completeness/safety) */
  safe: boolean;
  /** Reason if unsafe */
  unsafeReason?: string;
  /** Timestamp of the preview */
  previewedAt: number;
}

/** Disclosure Evidence record for complete audit trail. */
export interface DisclosureEvidence {
  id: string;
  runId: string;
  stepId: string;
  skillId: string;
  /** Position in the assembled prompt (0-indexed) */
  promptPosition: number;
  /** When the disclosure was recorded */
  timing: number;
  /** Content fingerprint */
  fingerprint: string;
  /** Provenance of the content */
  provenance: string;
  /** Tokens consumed */
  tokens: number;
  /** Action taken */
  action: 'load' | 'unload' | 'pin' | 'exclude' | 'request' | 'block';
  /** Additional context */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Disclosure UI State Service
// ---------------------------------------------------------------------------

export class DisclosureUIStateService {
  private pins: Map<string, PinConfig> = new Map();
  private exclusions: Map<string, ExcludeConfig> = new Map();
  private evidenceLog: DisclosureEvidence[] = [];
  private previewHistory: EffectPreview[] = [];
  private currentRunId = '';
  private currentStepId = '';

  /**
   * Project the full UI state for all skills known to the planner.
   * Returns one entry per skill with its current disclosure status.
   *
   * Requirement 43.7: Show indexed, triggered, loaded, cached, unloaded,
   * pinned, excluded, and blocked disclosure states.
   */
  projectAllStates(planner: ProgressiveDisclosurePlanner): SkillDisclosureUIEntry[] {
    const entries: SkillDisclosureUIEntry[] = [];
    const state = planner.getState();
    const now = Date.now();

    for (const [skillId, metadata] of state.metadataIndex) {
      const entry = this.projectSingleSkill(skillId, metadata, state, planner, now);
      entries.push(entry);
    }

    return entries;
  }

  /**
   * Project the disclosure state for a single skill.
   */
  projectSingleSkill(
    skillId: string,
    metadata: SkillMetadataEntry,
    state: DisclosureState,
    planner: ProgressiveDisclosurePlanner,
    now: number = Date.now(),
  ): SkillDisclosureUIEntry {
    // Collect loaded/blocked assets for this skill
    const loadedAssets: LoadedAssetSummary[] = [];
    const blockedAssets: BlockedAssetSummary[] = [];

    for (const asset of state.loadedAssets.values()) {
      if (asset.skillId === skillId) {
        loadedAssets.push({
          assetId: asset.assetId,
          assetType: asset.assetType,
          tokens: asset.tokens,
          purpose: asset.purpose,
          fingerprint: asset.declaredFingerprint,
        });
      }
    }

    for (const blocked of state.blockedAssets.values()) {
      if (blocked.skillId === skillId) {
        blockedAssets.push({
          assetId: blocked.assetId,
          assetType: blocked.assetType,
          reason: blocked.reason,
          fingerprint: blocked.declaredFingerprint,
        });
      }
    }

    // Determine status in priority order
    if (this.exclusions.has(skillId)) {
      const excl = this.exclusions.get(skillId)!;
      return {
        skillId,
        status: 'excluded',
        reason: excl.reason,
        version: metadata.version,
        tokenUsage: 0,
        provenance: metadata.provenance,
        stateTimestamp: excl.excludedAt,
        loadedAssets,
        blockedAssets,
      };
    }

    if (planner.isFailClosed(skillId)) {
      const fcRecord = planner.getFailClosedRecord(skillId);
      return {
        skillId,
        status: 'blocked',
        reason: fcRecord?.message ?? 'Blocked pending review',
        version: metadata.version,
        tokenUsage: 0,
        provenance: metadata.provenance,
        stateTimestamp: fcRecord?.blockedAt ?? now,
        loadedAssets,
        blockedAssets,
      };
    }

    if (this.pins.has(skillId)) {
      const pin = this.pins.get(skillId)!;
      const body = state.loadedBodies.get(skillId);
      return {
        skillId,
        status: 'pinned',
        reason: pin.reason,
        version: metadata.version,
        tokenUsage: body?.tokens ?? 0,
        provenance: metadata.provenance,
        stateTimestamp: pin.pinnedAt,
        contentFingerprint: body?.contentFingerprint,
        loadedAssets,
        blockedAssets,
      };
    }

    const body = state.loadedBodies.get(skillId);
    if (body) {
      return {
        skillId,
        status: 'loaded',
        reason: `${body.reason.kind}: ${body.reason.source}`,
        version: body.version,
        tokenUsage: body.tokens,
        provenance: body.provenance,
        stateTimestamp: body.loadedAt,
        contentFingerprint: body.contentFingerprint,
        loadedAssets,
        blockedAssets,
      };
    }

    if (planner.isInInactiveCache(skillId)) {
      return {
        skillId,
        status: 'cached',
        reason: 'In inactive cache (prompt-invisible)',
        version: metadata.version,
        tokenUsage: 0,
        provenance: metadata.provenance,
        stateTimestamp: now,
        loadedAssets,
        blockedAssets,
      };
    }

    if (planner.wasStepEndUnloaded(skillId)) {
      return {
        skillId,
        status: 'unloaded',
        reason: 'Unloaded at step-end',
        version: metadata.version,
        tokenUsage: 0,
        provenance: metadata.provenance,
        stateTimestamp: now,
        loadedAssets,
        blockedAssets,
      };
    }

    // Default: indexed only (Level 1 metadata available)
    return {
      skillId,
      status: 'indexed',
      reason: 'Level 1 metadata available',
      version: metadata.version,
      tokenUsage: metadata.tokenEstimate,
      provenance: metadata.provenance,
      stateTimestamp: now,
      loadedAssets,
      blockedAssets,
    };
  }

  // -------------------------------------------------------------------------
  // Pin / Exclude Management
  // -------------------------------------------------------------------------

  /**
   * Pin a skill for the current run (ensures it stays loaded).
   * Requires authorization check by caller.
   */
  pinSkill(skillId: string, pinnedBy: string, reason: string): PinConfig {
    const pin: PinConfig = {
      skillId,
      pinnedBy,
      pinnedAt: Date.now(),
      reason,
    };
    this.pins.set(skillId, pin);

    this.recordEvidence({
      skillId,
      promptPosition: -1,
      action: 'pin',
      fingerprint: '',
      provenance: pinnedBy,
      tokens: 0,
      details: { reason },
    });

    return pin;
  }

  /**
   * Exclude a skill from loading for the current run.
   * Requires authorization check by caller.
   */
  excludeSkill(skillId: string, excludedBy: string, reason: string): ExcludeConfig {
    const excl: ExcludeConfig = {
      skillId,
      excludedBy,
      excludedAt: Date.now(),
      reason,
    };
    this.exclusions.set(skillId, excl);

    this.recordEvidence({
      skillId,
      promptPosition: -1,
      action: 'exclude',
      fingerprint: '',
      provenance: excludedBy,
      tokens: 0,
      details: { reason },
    });

    return excl;
  }

  /**
   * Remove a pin from a skill.
   */
  unpinSkill(skillId: string): boolean {
    return this.pins.delete(skillId);
  }

  /**
   * Remove an exclusion from a skill.
   */
  unexcludeSkill(skillId: string): boolean {
    return this.exclusions.delete(skillId);
  }

  /**
   * Check if a skill is pinned.
   */
  isPinned(skillId: string): boolean {
    return this.pins.has(skillId);
  }

  /**
   * Check if a skill is excluded.
   */
  isExcluded(skillId: string): boolean {
    return this.exclusions.has(skillId);
  }

  /**
   * Get all current pins.
   */
  getPins(): ReadonlyMap<string, PinConfig> {
    return this.pins;
  }

  /**
   * Get all current exclusions.
   */
  getExclusions(): ReadonlyMap<string, ExcludeConfig> {
    return this.exclusions;
  }

  // -------------------------------------------------------------------------
  // Effect Preview (Requirement 51.8)
  // -------------------------------------------------------------------------

  /**
   * Preview the effect of pinning a skill without actually applying it.
   * Shows token changes, affected skills, and safety status.
   *
   * Requirement 51.8: Let authorized users preview resulting prompt and token changes.
   */
  previewPinEffect(
    skillId: string,
    planner: ProgressiveDisclosurePlanner,
    estimatedTokens: number,
  ): EffectPreview {
    const metadata = planner.getMetadataIndex().get(skillId);
    const budgetUsage = planner.getBudgetUsage();
    const safe = metadata !== undefined && !planner.isFailClosed(skillId) && !this.exclusions.has(skillId);
    let unsafeReason: string | undefined;

    if (!metadata) {
      unsafeReason = 'Skill not found in metadata index';
    } else if (planner.isFailClosed(skillId)) {
      unsafeReason = 'Skill is blocked pending manual review';
    } else if (this.exclusions.has(skillId)) {
      unsafeReason = 'Skill is currently excluded';
    }

    const preview: EffectPreview = {
      action: 'pin',
      skillId,
      tokenDelta: safe ? estimatedTokens : 0,
      affectedSkills: this.findDependentSkills(skillId, planner),
      safe,
      unsafeReason,
      previewedAt: Date.now(),
    };

    this.previewHistory.push(preview);
    return preview;
  }

  /**
   * Preview the effect of excluding a skill without actually applying it.
   */
  previewExcludeEffect(
    skillId: string,
    planner: ProgressiveDisclosurePlanner,
  ): EffectPreview {
    const state = planner.getState();
    const body = state.loadedBodies.get(skillId);
    const tokenDelta = body ? -body.tokens : 0;
    const safe = !this.pins.has(skillId);
    let unsafeReason: string | undefined;

    if (this.pins.has(skillId)) {
      unsafeReason = 'Skill is currently pinned — unpin first';
    }

    const preview: EffectPreview = {
      action: 'exclude',
      skillId,
      tokenDelta,
      affectedSkills: this.findDependentSkills(skillId, planner),
      safe,
      unsafeReason,
      previewedAt: Date.now(),
    };

    this.previewHistory.push(preview);
    return preview;
  }

  /**
   * Preview the effect of requesting a skill to be loaded.
   */
  previewRequestEffect(
    skillId: string,
    planner: ProgressiveDisclosurePlanner,
    estimatedTokens: number,
  ): EffectPreview {
    const metadata = planner.getMetadataIndex().get(skillId);
    const safe = metadata !== undefined && !planner.isFailClosed(skillId) && !this.exclusions.has(skillId);
    let unsafeReason: string | undefined;

    if (!metadata) {
      unsafeReason = 'Skill not found in metadata index';
    } else if (planner.isFailClosed(skillId)) {
      unsafeReason = 'Skill is blocked pending manual review';
    } else if (this.exclusions.has(skillId)) {
      unsafeReason = 'Skill is excluded';
    }

    const preview: EffectPreview = {
      action: 'request',
      skillId,
      tokenDelta: safe ? estimatedTokens : 0,
      affectedSkills: [],
      safe,
      unsafeReason,
      previewedAt: Date.now(),
    };

    this.previewHistory.push(preview);
    return preview;
  }

  // -------------------------------------------------------------------------
  // Evidence Recording (Requirement 51.6)
  // -------------------------------------------------------------------------

  /**
   * Record a disclosure evidence entry.
   *
   * Requirement 51.6: Record run, task, agent, skill and asset versions, trigger,
   * reason, prompt position, tokens, provenance, content fingerprint, load time,
   * and unload time.
   */
  recordEvidence(params: {
    skillId: string;
    promptPosition: number;
    action: DisclosureEvidence['action'];
    fingerprint: string;
    provenance: string;
    tokens: number;
    details?: Record<string, unknown>;
  }): DisclosureEvidence {
    const evidence: DisclosureEvidence = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: this.currentRunId,
      stepId: this.currentStepId,
      skillId: params.skillId,
      promptPosition: params.promptPosition,
      timing: Date.now(),
      fingerprint: params.fingerprint,
      provenance: params.provenance,
      tokens: params.tokens,
      action: params.action,
      details: params.details,
    };

    this.evidenceLog.push(evidence);
    return evidence;
  }

  /**
   * Get all evidence records.
   */
  getEvidenceLog(): readonly DisclosureEvidence[] {
    return this.evidenceLog;
  }

  /**
   * Get evidence records for a specific skill.
   */
  getEvidenceForSkill(skillId: string): DisclosureEvidence[] {
    return this.evidenceLog.filter(e => e.skillId === skillId);
  }

  /**
   * Get the preview history.
   */
  getPreviewHistory(): readonly EffectPreview[] {
    return this.previewHistory;
  }

  // -------------------------------------------------------------------------
  // Context Management
  // -------------------------------------------------------------------------

  /**
   * Set the current run and step IDs for evidence recording.
   */
  setContext(runId: string, stepId: string): void {
    this.currentRunId = runId;
    this.currentStepId = stepId;
  }

  /**
   * Reset all state for a new run.
   */
  reset(): void {
    this.pins.clear();
    this.exclusions.clear();
    this.evidenceLog = [];
    this.previewHistory = [];
    this.currentRunId = '';
    this.currentStepId = '';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find skills that depend on or are related to the given skill.
   * Uses metadata exclusions to find potential conflicts.
   */
  private findDependentSkills(skillId: string, planner: ProgressiveDisclosurePlanner): string[] {
    const affected: string[] = [];
    const index = planner.getMetadataIndex();

    for (const [id, meta] of index) {
      if (id === skillId) continue;
      // A skill that excludes this skill or is excluded by this skill is affected
      if (meta.exclusions.includes(skillId)) {
        affected.push(id);
      }
    }

    // Also check if the target skill excludes others
    const targetMeta = index.get(skillId);
    if (targetMeta) {
      for (const excluded of targetMeta.exclusions) {
        if (index.has(excluded) && !affected.includes(excluded)) {
          affected.push(excluded);
        }
      }
    }

    return affected;
  }
}
