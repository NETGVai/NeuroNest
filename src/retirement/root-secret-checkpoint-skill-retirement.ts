/**
 * Legacy-root / plaintext-secret / checkpoint-artifact / skill-alias RETIREMENT
 * authority (FUT-PKG-09-RETIREMENT/T-004 — Data Migration Authority).
 *
 * This is the P8 leaf that clears the FINAL removal of four legacy surfaces
 * ONLY AFTER the whole migration/retirement matrix is proven, per surface:
 *
 *   1. LEGACY DATA ROOT — the old writable root (`~/.ai-superagent` and any
 *      itemized legacy root) has been migrated into the canonical DataRoot
 *      (FOUNDATION T-003, src/storage/data-root.ts / data-directory.ts) so there
 *      is ONE writable root; the legacy content is preserved and the migration
 *      completion marker is present (NN-DATA-001/003/006, NN-INV-008).
 *   2. PLAINTEXT SECRET — every scattered/plaintext secret has been cut over
 *      into the one Credential Authority (SECURITY T-002,
 *      src/shared/credential-service.ts + credential-migration.ts) with a
 *      read-back verify, and after cutover a plaintext secret is NEVER read on
 *      the normal path (V-SEC-001/plaintext-denial-postcutover; NN-SEC-008,
 *      NN-PROXY-008). A rollback restores a quarantine READ adapter only — never
 *      a plaintext writer or plaintext normal-use fallback.
 *   3. CHECKPOINT ARTIFACT — every legacy file-delta / git-ref / full-snapshot
 *      artifact has been wrapped as a verified `Checkpoint@1` read adapter
 *      (RECOVERY T-003, src/checkpoint/legacy-artifact-wrapper.ts); an
 *      unverified/quarantined artifact BLOCKS retirement and stays read-only
 *      (NN-CHECKPOINT-001/002).
 *   4. SKILL ALIAS — the legacy skill roots/state have been migrated once
 *      through the ledger (EXECUTION T-005, src/skills/skill-migration.ts) with
 *      path/state parity, no unresolved conflict, and a MEASURED zero required
 *      alias-read window; a conflicted id or a non-zero required alias read
 *      BLOCKS alias retirement (NN-SKILL-001/002).
 *
 * Every surface's removal is ADDITIONALLY gated on the 8.1 RetirementInventory
 * item being CLEARED by {@link ./retirement-inventory}.evaluateRetirementItem
 * (disposition REMOVE with all six deletion prerequisites — measured zero-use /
 * migrated data / recorded owner / proven-unreachable / parity / rescue +
 * rollback rehearsal). This authority creates NO parallel truth: it OBSERVES
 * the four dependency authorities and the observer evidence graph
 * (src/shared/evidence-observability.ts) and renders a fail-closed per-surface
 * removal verdict. It DELETES NOTHING itself and NEVER becomes a writer.
 *
 * FAIL CLOSED. An uncertain secret/data/artifact/provenance BLOCKS retirement
 * and the item stays QUARANTINED / READ-ONLY (the task Acceptance). Removal is
 * telemetry-backed AFTER a restore rehearsal. Rollback restores a verified READ
 * adapter/reference only ({@link rollbackToReadReference}) — never an old
 * writer or plaintext normal use.
 *
 * Design anchors: D-05, D-20 (migration & compatibility plan), D-23 (phased
 * rollout/rollback), D-24 (risks). CD-003 (checkpoint artifacts), CD-008 (skill
 * roots), CD-015 / CD-020 (credential/plaintext cutover) ground the surfaces.
 * Requirements: NN-DATA-001/003/006, NN-SEC-008, NN-PROXY-008,
 * NN-CHECKPOINT-001/002, NN-SKILL-001/002.
 */

import { type EvidenceService } from '../shared/evidence-observability.js';
import {
  evaluateRetirementItem,
  type RetirementItem,
  type RetirementVerdict,
} from './retirement-inventory.js';

// ─── The four retirement surfaces this leaf clears ───────────────────────────

/**
 * The four legacy surfaces the task Deliverables enumerate. Each is retired
 * INDEPENDENTLY (one surface at a time) so a block on one never removes
 * another.
 */
export const RETIREMENT_SURFACES = Object.freeze([
  'legacy-data-root', // old writable data root migrated into the canonical DataRoot
  'plaintext-secret', // scattered/plaintext secret cut over to the Credential Authority
  'legacy-checkpoint-artifact', // legacy file-delta/git-ref/full-snapshot artifact wrapped
  'skill-alias', // legacy skill root/state read alias
] as const);
export type RetirementSurface = (typeof RETIREMENT_SURFACES)[number];

/** Whether a value is a known retirement surface. */
export function isRetirementSurface(value: unknown): value is RetirementSurface {
  return (
    typeof value === 'string' &&
    (RETIREMENT_SURFACES as readonly string[]).includes(value)
  );
}

// ─── Per-surface observations (READ from the dependency authorities) ─────────

/**
 * LEGACY DATA ROOT observation (FOUNDATION T-003). All fields are OBSERVED from
 * the DataRoot / data-directory migration, never asserted here. `singleWritableRoot`
 * proves there is exactly ONE writable root after migration; `migrationMarkerPresent`
 * proves the one-time legacy migration completed; `legacySourcePreserved` proves
 * the legacy content was not destroyed; `conflictsResolved` proves no unresolved
 * data conflict remains. Any false value keeps the legacy root read-only and
 * blocks retirement (fail closed).
 */
export interface LegacyRootObservation {
  /** The canonical DataRoot is the sole writable root after migration. */
  readonly singleWritableRoot: boolean;
  /** The one-time legacy migration completion marker is present. */
  readonly migrationMarkerPresent: boolean;
  /** The legacy source content is preserved (not destroyed) for rollback. */
  readonly legacySourcePreserved: boolean;
  /** Every itemized data conflict was resolved (none quarantined-uncertain). */
  readonly conflictsResolved: boolean;
}

/**
 * PLAINTEXT SECRET observation (SECURITY T-002). `cutoverComplete` proves every
 * legacy plaintext entry was stored in the Credential Authority with a
 * read-back verify; `plaintextReadableOnNormalPath` MUST be false post-cutover
 * (a plaintext secret is never read on the normal path — the fail-closed core of
 * V-SEC-001/plaintext-denial-postcutover); `quarantineReadAdapterAvailable`
 * proves the reversible escape hatch exists (a recovery READER only, never a
 * plaintext writer); `provenanceCertain` proves each migrated secret's origin is
 * known (an uncertain-provenance secret blocks retirement and stays quarantined).
 */
export interface PlaintextSecretObservation {
  /** Every legacy plaintext secret was cut over (stored + read-back verified). */
  readonly cutoverComplete: boolean;
  /** MUST be false post-cutover: plaintext is never read on the normal path. */
  readonly plaintextReadableOnNormalPath: boolean;
  /** A quarantine READ adapter is available for rollback (recovery reader only). */
  readonly quarantineReadAdapterAvailable: boolean;
  /** Every migrated secret's provenance is certain (no uncertain origin). */
  readonly provenanceCertain: boolean;
}

/**
 * LEGACY CHECKPOINT ARTIFACT observation (RECOVERY T-003). `allArtifactsVerified`
 * proves every inventoried legacy artifact wrapped as a VERIFIED read adapter;
 * `quarantinedArtifactCount` counts artifacts that failed verification (an
 * unverified artifact BLOCKS retirement and stays read-only); `wrapperIsReadAdapterOnly`
 * proves the wrapped artifacts are non-authoritative readers (the sole writer is
 * the CheckpointService); `sourcePreserved` proves no source was removed.
 */
export interface CheckpointArtifactObservation {
  /** Every inventoried legacy artifact wrapped as a verified read adapter. */
  readonly allArtifactsVerified: boolean;
  /** Count of artifacts that failed verification (quarantined, read-only). */
  readonly quarantinedArtifactCount: number;
  /** The wrapped artifacts are read adapters only (CheckpointService is writer). */
  readonly wrapperIsReadAdapterOnly: boolean;
  /** Every legacy artifact source is preserved (not removed). */
  readonly sourcePreserved: boolean;
}

/**
 * SKILL ALIAS observation (EXECUTION T-005). `pathStateParity` proves the
 * migrated canonical state matches the legacy path/state (content-hash + semver,
 * never last-writer-wins); `unresolvedConflictCount` counts conflicted ids (a
 * conflicted id preserves both sides and BLOCKS alias retirement);
 * `requiredAliasReadWindowMeasured` proves the zero-required-alias-read window
 * completed; `requiredAliasReadsObserved` counts required reads still hitting a
 * legacy alias (a non-zero count BLOCKS alias retirement — measured zero-use
 * only); `readAliasRestorable` proves rollback can restore the read alias.
 */
export interface SkillAliasObservation {
  /** The migrated canonical state matches the legacy path/state (parity). */
  readonly pathStateParity: boolean;
  /** Count of skill ids under an unresolved migration conflict (blocked). */
  readonly unresolvedConflictCount: number;
  /** The zero-required-alias-read window completed and was measured. */
  readonly requiredAliasReadWindowMeasured: boolean;
  /** Count of required reads still hitting a legacy alias (measured). */
  readonly requiredAliasReadsObserved: number;
  /** A read alias can be restored on rollback (never a second writer). */
  readonly readAliasRestorable: boolean;
}

/** The surface-specific observation, discriminated by surface. */
export type SurfaceObservation =
  | { readonly surface: 'legacy-data-root'; readonly legacyRoot: LegacyRootObservation }
  | { readonly surface: 'plaintext-secret'; readonly plaintextSecret: PlaintextSecretObservation }
  | {
      readonly surface: 'legacy-checkpoint-artifact';
      readonly checkpointArtifact: CheckpointArtifactObservation;
    }
  | { readonly surface: 'skill-alias'; readonly skillAlias: SkillAliasObservation };

/**
 * The full retirement request for ONE surface. `inventoryItem` binds the 8.1
 * RetirementInventory item for this surface; its parity/rollback/rescue evidence
 * is verified against the observer evidence graph (fail-closed). `observation`
 * carries the surface-specific evidence read from the owning dependency
 * authority.
 */
export interface RetireSurfaceRequest {
  /** Stable surface candidate id, e.g. `orphan:legacy-root:ai-superagent`. */
  readonly candidateId: string;
  readonly surface: RetirementSurface;
  readonly inventoryItem: RetirementItem;
  readonly observation: SurfaceObservation;
}

// ─── Fail-closed block taxonomy ──────────────────────────────────────────────

/**
 * Every category of finding that BLOCKS a surface retirement. `inventory-not-cleared`
 * folds the 8.1 gate. `surface-mismatch` guards a request whose observation does
 * not match its declared surface. The remaining categories are the fail-closed
 * per-surface faults the task Acceptance names (uncertain secret/data/artifact/
 * provenance).
 */
export type SurfaceBlockCategory =
  | 'inventory-not-cleared'
  | 'surface-mismatch'
  // legacy-data-root
  | 'multiple-writable-roots'
  | 'migration-incomplete'
  | 'legacy-source-destroyed'
  | 'data-conflict-unresolved'
  // plaintext-secret
  | 'secret-cutover-incomplete'
  | 'plaintext-readable-on-normal-path'
  | 'no-quarantine-read-adapter'
  | 'secret-provenance-uncertain'
  // legacy-checkpoint-artifact
  | 'artifact-unverified'
  | 'artifact-quarantined'
  | 'wrapper-not-read-adapter-only'
  | 'artifact-source-destroyed'
  // skill-alias
  | 'skill-path-state-divergence'
  | 'skill-conflict-unresolved'
  | 'alias-read-window-unmeasured'
  | 'required-alias-read-observed'
  | 'read-alias-not-restorable';

/** One structured, human-safe reason a surface retirement is blocked. */
export interface SurfaceBlockReason {
  readonly category: SurfaceBlockCategory;
  readonly detail: string;
}

/**
 * The verdict for ONE surface retirement. `clearedForRetirement` is the single
 * fail-closed decision: the legacy surface's old writer / normal-use plaintext /
 * alias may be removed IFF `clearedForRetirement` is true. When blocked the
 * surface stays QUARANTINED / READ-ONLY (`quarantinedReadOnly` true) and every
 * unmet reason is reported. `plaintextDeniedOnNormalPath` is true whenever a
 * plaintext secret is never read on the normal path (always true for a cleared
 * plaintext surface). `coreReadinessUnchanged` is ALWAYS true (NN-INV-014, D-24).
 */
export interface RetireSurfaceVerdict {
  readonly candidateId: string;
  readonly surface: RetirementSurface;
  readonly clearedForRetirement: boolean;
  /** Complement of `clearedForRetirement`: a blocked surface stays read-only. */
  readonly quarantinedReadOnly: boolean;
  /** True iff plaintext is never read on the normal path (plaintext surfaces). */
  readonly plaintextDeniedOnNormalPath: boolean;
  /** The 8.1 inventory verdict this retirement is gated on. */
  readonly inventoryVerdict: RetirementVerdict;
  /** Every independent reason retirement is blocked (empty iff cleared). */
  readonly blockReasons: readonly SurfaceBlockReason[];
  readonly coreReadinessUnchanged: true;
}

// ─── Per-surface parity checks (read the dependency authority observations) ──

function checkLegacyRoot(o: LegacyRootObservation): SurfaceBlockReason[] {
  const reasons: SurfaceBlockReason[] = [];
  if (!o.singleWritableRoot) {
    reasons.push({
      category: 'multiple-writable-roots',
      detail:
        'more than one writable data root remains; the canonical DataRoot must be the sole writer before the legacy root is retired',
    });
  }
  if (!o.migrationMarkerPresent) {
    reasons.push({
      category: 'migration-incomplete',
      detail: 'the one-time legacy data migration completion marker is absent; migration is not proven complete',
    });
  }
  if (!o.legacySourcePreserved) {
    reasons.push({
      category: 'legacy-source-destroyed',
      detail: 'the legacy data source is not preserved; retirement requires a recoverable prior source',
    });
  }
  if (!o.conflictsResolved) {
    reasons.push({
      category: 'data-conflict-unresolved',
      detail: 'an uncertain/unresolved data conflict remains; it stays quarantined and blocks retirement',
    });
  }
  return reasons;
}

function checkPlaintextSecret(o: PlaintextSecretObservation): SurfaceBlockReason[] {
  const reasons: SurfaceBlockReason[] = [];
  if (!o.cutoverComplete) {
    reasons.push({
      category: 'secret-cutover-incomplete',
      detail: 'the protected secret cutover is incomplete; a legacy plaintext entry was not stored + read-back verified',
    });
  }
  // The fail-closed CORE (V-SEC-001/plaintext-denial-postcutover): after cutover
  // a plaintext secret must NEVER be readable on the normal path.
  if (o.plaintextReadableOnNormalPath) {
    reasons.push({
      category: 'plaintext-readable-on-normal-path',
      detail:
        'a plaintext secret is still readable on the normal path post-cutover; normal-use plaintext must be denied before retirement',
    });
  }
  if (!o.quarantineReadAdapterAvailable) {
    reasons.push({
      category: 'no-quarantine-read-adapter',
      detail:
        'no quarantine READ adapter is available; rollback must restore a recovery reader (never a plaintext writer)',
    });
  }
  if (!o.provenanceCertain) {
    reasons.push({
      category: 'secret-provenance-uncertain',
      detail: 'a migrated secret has uncertain provenance; it stays quarantined and blocks retirement',
    });
  }
  return reasons;
}

function checkCheckpointArtifact(o: CheckpointArtifactObservation): SurfaceBlockReason[] {
  const reasons: SurfaceBlockReason[] = [];
  if (!o.allArtifactsVerified) {
    reasons.push({
      category: 'artifact-unverified',
      detail: 'not every legacy checkpoint artifact wrapped as a verified read adapter',
    });
  }
  if (o.quarantinedArtifactCount > 0) {
    reasons.push({
      category: 'artifact-quarantined',
      detail: `${o.quarantinedArtifactCount} legacy checkpoint artifact(s) are quarantined (verification failed); they stay read-only and block retirement`,
    });
  }
  if (!o.wrapperIsReadAdapterOnly) {
    reasons.push({
      category: 'wrapper-not-read-adapter-only',
      detail: 'the wrapped legacy artifacts are not read-adapter-only; the CheckpointService must remain the sole writer',
    });
  }
  if (!o.sourcePreserved) {
    reasons.push({
      category: 'artifact-source-destroyed',
      detail: 'a legacy artifact source is not preserved; retirement requires a recoverable prior source',
    });
  }
  return reasons;
}

function checkSkillAlias(o: SkillAliasObservation): SurfaceBlockReason[] {
  const reasons: SurfaceBlockReason[] = [];
  if (!o.pathStateParity) {
    reasons.push({
      category: 'skill-path-state-divergence',
      detail: 'the migrated canonical skill state diverges from the legacy path/state; parity must hold before alias retirement',
    });
  }
  if (o.unresolvedConflictCount > 0) {
    reasons.push({
      category: 'skill-conflict-unresolved',
      detail: `${o.unresolvedConflictCount} skill id(s) are under an unresolved migration conflict (both sides preserved); a conflicted id blocks alias retirement`,
    });
  }
  if (!o.requiredAliasReadWindowMeasured) {
    reasons.push({
      category: 'alias-read-window-unmeasured',
      detail: 'the zero-required-alias-read window is not measured; required alias use cannot be ruled out',
    });
  }
  // Zero REQUIRED alias reads (measured deprecation only).
  if (o.requiredAliasReadsObserved > 0) {
    reasons.push({
      category: 'required-alias-read-observed',
      detail: `${o.requiredAliasReadsObserved} required read(s) still hit a legacy skill alias; a non-zero required alias read blocks retirement`,
    });
  }
  if (!o.readAliasRestorable) {
    reasons.push({
      category: 'read-alias-not-restorable',
      detail: 'the read alias is not restorable on rollback; rollback must restore a read alias (never a second writer)',
    });
  }
  return reasons;
}

/**
 * Whether an observation matches its declared surface. A mismatched request is a
 * fail-closed `surface-mismatch` block (a request must carry the observation for
 * the surface it declares).
 */
function observationMatchesSurface(request: RetireSurfaceRequest): boolean {
  return request.observation.surface === request.surface;
}

// ─── The per-surface removal gate (fail-closed, one surface at a time) ───────

/**
 * Evaluate the fail-closed retirement gate for ONE legacy surface. Pure and
 * total over its inputs and the observer evidence graph — NO deletion, NO writes,
 * NO throws. Every check is evaluated so the verdict reports EVERY unmet reason.
 *
 * A surface is cleared for retirement IFF:
 *   - its 8.1 RetirementInventory item is CLEARED (disposition REMOVE with all
 *     six deletion prerequisites — this already folds measured zero-use,
 *     migrated data, recorded owner, proven-unreachable, parity, and the
 *     rescue + rollback rehearsal, i.e. the restore rehearsal); AND
 *   - the surface-specific parity/integrity/denial checks all pass.
 *
 * An uncertain secret/data/artifact/provenance, an incomplete cutover, a
 * still-readable plaintext normal path, an unverified/quarantined artifact, a
 * skill conflict, or a non-zero required alias read BLOCKS retirement and keeps
 * the surface QUARANTINED / READ-ONLY (fail closed).
 */
export function evaluateSurfaceRetirement(
  request: RetireSurfaceRequest,
  evidence: EvidenceService,
): RetireSurfaceVerdict {
  const blockReasons: SurfaceBlockReason[] = [];

  // Gate 1 — the 8.1 RetirementInventory clearance (reuse, do not re-implement).
  // This is the removal-is-gated-on-8.1 requirement and folds the restore
  // rehearsal (rollback prerequisite) + rescue artifact.
  const inventoryVerdict = evaluateRetirementItem(request.inventoryItem, evidence);
  if (!inventoryVerdict.clearedForDeletion) {
    blockReasons.push({
      category: 'inventory-not-cleared',
      detail: `retirement inventory item ${request.inventoryItem.itemId} is not cleared: ${inventoryVerdict.blockReasons
        .map((r) => r.prerequisite)
        .join(', ')}`,
    });
  }

  // Gate 2 — the surface-specific parity/integrity/denial checks.
  if (!observationMatchesSurface(request)) {
    blockReasons.push({
      category: 'surface-mismatch',
      detail: `request declares surface ${request.surface} but carries a ${request.observation.surface} observation`,
    });
  } else {
    switch (request.observation.surface) {
      case 'legacy-data-root':
        blockReasons.push(...checkLegacyRoot(request.observation.legacyRoot));
        break;
      case 'plaintext-secret':
        blockReasons.push(...checkPlaintextSecret(request.observation.plaintextSecret));
        break;
      case 'legacy-checkpoint-artifact':
        blockReasons.push(...checkCheckpointArtifact(request.observation.checkpointArtifact));
        break;
      case 'skill-alias':
        blockReasons.push(...checkSkillAlias(request.observation.skillAlias));
        break;
    }
  }

  const clearedForRetirement = blockReasons.length === 0;

  // Plaintext is denied on the normal path whenever the plaintext surface's
  // normal-path readability is false. For non-plaintext surfaces this is
  // vacuously true (there is no plaintext normal path to deny).
  const plaintextDeniedOnNormalPath =
    request.observation.surface === 'plaintext-secret'
      ? !request.observation.plaintextSecret.plaintextReadableOnNormalPath
      : true;

  return Object.freeze({
    candidateId: request.candidateId,
    surface: request.surface,
    clearedForRetirement,
    quarantinedReadOnly: !clearedForRetirement,
    plaintextDeniedOnNormalPath,
    inventoryVerdict,
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

// ─── Batch: retire the whole surface matrix, one at a time (no bulk on block) ─

/** The result of a full root/secret/checkpoint/skill retirement review. */
export interface SurfaceRetirementReview {
  readonly verdicts: readonly RetireSurfaceVerdict[];
  /** Candidate ids cleared for retirement (old writer / plaintext / alias removable). */
  readonly cleared: readonly string[];
  /** Candidate ids kept quarantined / read-only (retirement blocked, fail closed). */
  readonly quarantined: readonly string[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the retirement gate over a set of surface requests. Each surface is
 * evaluated INDEPENDENTLY and the verdicts are returned sorted by candidate id
 * for determinism — a block on one surface never clears or blocks another (one
 * surface at a time, the task Migration rule). No deletion is performed here.
 */
export function reviewSurfaceRetirement(
  requests: readonly RetireSurfaceRequest[],
  evidence: EvidenceService,
): SurfaceRetirementReview {
  const verdicts = [...requests]
    .map((r) => evaluateSurfaceRetirement(r, evidence))
    .sort((a, b) =>
      a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
    );
  const cleared = verdicts.filter((v) => v.clearedForRetirement).map((v) => v.candidateId);
  const quarantined = verdicts
    .filter((v) => !v.clearedForRetirement)
    .map((v) => v.candidateId);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    quarantined: Object.freeze(quarantined),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Whether the FINAL matrix removal may proceed. Fail-closed: removal of the old
 * writers / normal-use plaintext / aliases is authorized ONLY when the review is
 * non-empty AND every surface is cleared — an incomplete matrix (any quarantined
 * surface) authorizes NO removal (the task Migration/rollback rule: telemetry-
 * backed deletion after restore rehearsal, never from an incomplete matrix).
 */
export function matrixRetirementAuthorized(review: SurfaceRetirementReview): boolean {
  return review.verdicts.length > 0 && review.quarantined.length === 0;
}

// ─── Rollback — restore a verified READ reference, NEVER an old writer ───────

/** The reference roles a rollback is permitted to restore (read-only). */
export const RESTORABLE_REFERENCE_ROLES = Object.freeze([
  'read-adapter', // a verified read adapter over the wrapped/quarantined source
  'read-alias', // a legacy skill read alias (never a second writer)
  'quarantine-reader', // a credential quarantine recovery reader (never plaintext writer)
] as const);
export type RestorableReferenceRole = (typeof RESTORABLE_REFERENCE_ROLES)[number];

/**
 * The roles a rollback is FORBIDDEN to restore — the exact things retirement
 * removed. A rollback restores a verified READ reference, not an old writer or
 * plaintext normal use (the task Migration/rollback rule).
 */
export const FORBIDDEN_ROLLBACK_ROLES = Object.freeze([
  'old-writer', // a legacy independent writer / second writable root
  'plaintext-writer', // a plaintext secret writer
  'plaintext-normal-use', // plaintext secret readable on the normal path
] as const);
export type ForbiddenRollbackRole = (typeof FORBIDDEN_ROLLBACK_ROLES)[number];

/** Any role a rollback might request. */
export type RollbackReferenceRole = RestorableReferenceRole | ForbiddenRollbackRole;

/** Whether a role is a restorable READ reference (never a writer/normal-use). */
export function isRestorableReferenceRole(
  role: RollbackReferenceRole,
): role is RestorableReferenceRole {
  return (RESTORABLE_REFERENCE_ROLES as readonly string[]).includes(role);
}

/** The outcome of a surface retirement rollback. */
export type RollbackOutcome =
  | {
      readonly ok: true;
      readonly surface: RetirementSurface;
      readonly restoredRole: RestorableReferenceRole;
    }
  | {
      readonly ok: false;
      readonly surface: RetirementSurface;
      readonly refusedRole: ForbiddenRollbackRole;
      readonly reason: string;
    };

/**
 * Roll back a retired surface by reselecting a verified READ reference role for
 * it. Fail-closed on intent: a request to restore an old writer, a plaintext
 * writer, or plaintext normal use is REFUSED (a rollback restores a verified read
 * adapter/reference only — never an old writer or plaintext normal use). A
 * restorable read role succeeds; the canonical authority remains the sole writer
 * throughout. This performs no durable write; it models the rollback DECISION.
 */
export function rollbackToReadReference(
  surface: RetirementSurface,
  requestedRole: RollbackReferenceRole,
): RollbackOutcome {
  if (!isRestorableReferenceRole(requestedRole)) {
    return {
      ok: false,
      surface,
      refusedRole: requestedRole,
      reason:
        'a retirement rollback restores a verified read adapter/reference only; an old writer or plaintext normal use is never restored',
    };
  }
  return { ok: true, surface, restoredRole: requestedRole };
}

/** The authority id that owns the root/secret/checkpoint/skill retirement leaf. */
export const ROOT_SECRET_CHECKPOINT_SKILL_RETIREMENT_OWNER = 'authority-data-migration';
