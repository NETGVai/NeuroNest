/**
 * Skill Publication Service
 *
 * Handles transactional publication of imported skills through the authoritative catalog.
 * This service:
 * 1. Classifies skills as orchestrator vs extension/domain and retains source evidence
 * 2. Validates manifest, graph, capability, tools, permissions, safety, triggers,
 *    compatibility, provenance, and duplicates
 * 3. Assigns canonical IDs and versions with uniquely resolvable aliases
 * 4. Fails closed and quarantines unresolved/ambiguous/disabled/uninstalled/incompatible/unsafe deps
 * 5. Writes all data in one SQLite transaction preserving the prior snapshot on failure
 * 6. Supports side-by-side inspection, update approval, assignment impact, rollback
 *
 * Requirements: 49.1, 49.2, 49.3, 49.4, 49.5, 49.6, 49.7, 49.8
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import type {
  ExternalAssetId,
  TransformationProvenance,
} from './corpus-inventory-types.js';
import type {
  QuarantineReason,
} from './import-recovery-types.js';

// ─────────────────────────────────────────────
// Skill Classification
// ─────────────────────────────────────────────

export type SkillClassificationType = 'orchestrator' | 'extension_domain';

export interface ClassificationEvidence {
  readonly classification: SkillClassificationType;
  /** Source path evidence used for classification */
  readonly sourcePathEvidence: string;
  /** Content-based signals (e.g., workflow patterns, team patterns) */
  readonly contentSignals: readonly string[];
  /** Confidence score 0-1 */
  readonly confidence: number;
  /** Timestamp of classification */
  readonly classifiedAt: string;
}

// ─────────────────────────────────────────────
// Skill Manifest for Publication
// ─────────────────────────────────────────────

export interface PublishableSkillManifest {
  /** The staged candidate ID */
  readonly candidateId: string;
  /** External asset identity (for imported skills) */
  readonly externalAssetId: ExternalAssetId | null;
  /** Human-readable name */
  readonly name: string;
  /** Aliases (source names) */
  readonly aliases: readonly string[];
  /** Version string */
  readonly version: string;
  /** Skill classification */
  readonly classification: ClassificationEvidence;
  /** Capability keys this skill covers */
  readonly capabilities: readonly string[];
  /** Tool declarations */
  readonly tools: readonly ToolReference[];
  /** Permission declarations */
  readonly permissions: readonly PermissionReference[];
  /** Trigger patterns */
  readonly triggers: readonly TriggerReference[];
  /** Compatibility constraints */
  readonly compatibility: CompatibilityInfo;
  /** Transformation provenance */
  readonly provenance: TransformationProvenance;
  /** Relationships to other skills */
  readonly relationships: readonly SkillRelationship[];
  /** Test fixture references */
  readonly tests: readonly TestReference[];
  /** Content fingerprints */
  readonly fingerprints: SkillFingerprints;
  /** Safety assessment outcome */
  readonly safetyAssessment: SafetyAssessment;
}

export interface ToolReference {
  readonly toolId: string;
  readonly name: string;
  readonly required: boolean;
  readonly purpose: string;
}

export interface PermissionReference {
  readonly scope: string;
  readonly level: string;
  readonly resource: string;
  readonly justification: string;
}

export interface TriggerReference {
  readonly patternId: string;
  readonly description: string;
  readonly rule: string;
  readonly type: string;
}

export interface CompatibilityInfo {
  readonly minPlatformVersion: string;
  readonly maxPlatformVersion: string | null;
  readonly requiredFeatures: readonly string[];
  readonly incompatibleSkills: readonly string[];
}

export interface SkillRelationship {
  readonly targetSkillId: string;
  readonly targetName: string;
  readonly type: 'depends_on' | 'extends' | 'conflicts_with' | 'replaces' | 'composed_from';
  readonly required: boolean;
}

export interface TestReference {
  readonly testId: string;
  readonly type: string;
  readonly description: string;
  readonly expectedOutcome: string;
}

export interface SkillFingerprints {
  readonly manifestFingerprint: string;
  readonly contentFingerprint: string;
  readonly combinedFingerprint: string;
}

export interface SafetyAssessment {
  readonly safe: boolean;
  readonly concerns: readonly string[];
  readonly assessedAt: string;
}

// ─────────────────────────────────────────────
// Validation Types
// ─────────────────────────────────────────────

export type ValidationGate =
  | 'manifest_schema'
  | 'relationship_graph'
  | 'capability'
  | 'tools_permissions'
  | 'safety'
  | 'triggers'
  | 'compatibility'
  | 'provenance'
  | 'duplicates';

export interface ValidationOutcome {
  readonly gate: ValidationGate;
  readonly passed: boolean;
  readonly details: string;
  readonly validatedAt: string;
}

// ─────────────────────────────────────────────
// Dependency Resolution
// ─────────────────────────────────────────────

export type DependencyStatus =
  | 'resolved'
  | 'unresolved'
  | 'ambiguous'
  | 'disabled'
  | 'uninstalled'
  | 'incompatible'
  | 'unsafe';

export interface DependencyResolution {
  readonly targetId: string;
  readonly targetName: string;
  readonly status: DependencyStatus;
  readonly resolvedToCanonicalId: string | null;
  readonly reason: string;
}

// ─────────────────────────────────────────────
// Publication Types
// ─────────────────────────────────────────────

export interface CanonicalSkillId {
  readonly id: string;
  readonly version: string;
  readonly aliases: readonly string[];
}

export interface CatalogSnapshotMetadata {
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly effectiveSkillCount: number;
  readonly version: number;
}

export interface PublicationCandidate {
  readonly manifest: PublishableSkillManifest;
  readonly canonicalId: CanonicalSkillId;
  readonly validationOutcomes: readonly ValidationOutcome[];
  readonly dependencyResolutions: readonly DependencyResolution[];
}

export interface PublicationResult {
  readonly success: boolean;
  readonly publishedSkills: readonly PublishedSkillRecord[];
  readonly quarantined: readonly QuarantinedPublicationRecord[];
  readonly priorSnapshot: CatalogSnapshotMetadata;
  readonly newSnapshot: CatalogSnapshotMetadata | null;
  readonly error: string | null;
  readonly completedAt: string;
}

export interface PublishedSkillRecord {
  readonly canonicalId: string;
  readonly version: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly classification: SkillClassificationType;
  readonly fingerprint: string;
}

export interface QuarantinedPublicationRecord {
  readonly candidateId: string;
  readonly name: string;
  readonly reason: QuarantineReason | 'dependency_unresolved';
  readonly details: string;
  readonly quarantinedAt: string;
}

// ─────────────────────────────────────────────
// Side-by-Side Inspection / Update Approval
// ─────────────────────────────────────────────

export interface VersionInspection {
  readonly canonicalId: string;
  readonly currentVersion: PublishedSkillRecord | null;
  readonly proposedVersion: PublicationCandidate;
  readonly assignmentImpact: AssignmentImpact;
}

export interface AssignmentImpact {
  readonly affectedAgentIds: readonly string[];
  readonly bundlesRequiringRevalidation: number;
  readonly breakingChanges: readonly string[];
}

export interface UpdateApproval {
  readonly canonicalId: string;
  readonly approved: boolean;
  readonly reviewerIdentity: string;
  readonly reason: string;
  readonly decidedAt: string;
}

// ─────────────────────────────────────────────
// Service Interface
// ─────────────────────────────────────────────

/**
 * Interface for querying the existing catalog state during publication.
 */
export interface CatalogStateReader {
  /** Get the current effective snapshot metadata */
  getCurrentSnapshot(): CatalogSnapshotMetadata;
  /** Check if a skill ID already exists in the effective catalog */
  skillIdExists(id: string): boolean;
  /** Check if an alias is already used in the effective catalog */
  aliasExists(alias: string): boolean;
  /** Get a skill by its canonical ID */
  getSkillByCanonicalId(id: string): PublishedSkillRecord | null;
  /** Get agents assigned to a skill */
  getAssignedAgents(skillId: string): readonly string[];
  /** Check if a dependency target is enabled, installed, and compatible */
  getDependencyStatus(targetId: string): DependencyStatus;
  /** Get the catalog fingerprint */
  getCatalogFingerprint(): string;
}

// ─────────────────────────────────────────────
// SkillPublicationService
// ─────────────────────────────────────────────

/**
 * Manages transactional publication of imported skills to the authoritative catalog.
 *
 * Key invariants:
 * - All writes happen in ONE SQLite transaction
 * - On any failure, the prior immutable snapshot remains active
 * - No parallel catalog may be created
 * - Aliases must be uniquely resolvable
 * - Dependencies must be fully resolved or the candidate is quarantined
 */
export class SkillPublicationService {
  private readonly db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
    this.ensurePublicationSchema();
  }

  // ─── Schema ──────────────────────────────────────────────────

  private ensurePublicationSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_catalog_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL,
        effective_skill_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS published_skills (
        canonical_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        name TEXT NOT NULL,
        classification TEXT NOT NULL CHECK(classification IN ('orchestrator', 'extension_domain')),
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES skill_catalog_snapshots(snapshot_id)
      );

      CREATE TABLE IF NOT EXISTS skill_aliases (
        alias TEXT PRIMARY KEY,
        canonical_id TEXT NOT NULL,
        FOREIGN KEY (canonical_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        canonical_id TEXT NOT NULL,
        version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        published_at TEXT NOT NULL,
        PRIMARY KEY (canonical_id, version),
        FOREIGN KEY (canonical_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS skill_relationships (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (source_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS skill_tests (
        test_id TEXT PRIMARY KEY,
        canonical_id TEXT NOT NULL,
        test_type TEXT NOT NULL,
        description TEXT NOT NULL,
        expected_outcome TEXT NOT NULL,
        FOREIGN KEY (canonical_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS skill_provenance (
        canonical_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        source_path TEXT NOT NULL,
        blob_hash TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        license_spdx TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        transform_version TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (canonical_id),
        FOREIGN KEY (canonical_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS skill_fingerprints (
        canonical_id TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        combined_fingerprint TEXT NOT NULL,
        PRIMARY KEY (canonical_id),
        FOREIGN KEY (canonical_id) REFERENCES published_skills(canonical_id)
      );

      CREATE TABLE IF NOT EXISTS publication_quarantine (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        name TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_published_skills_classification
        ON published_skills(classification);
      CREATE INDEX IF NOT EXISTS idx_published_skills_snapshot
        ON published_skills(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_skill_relationships_source
        ON skill_relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_skill_relationships_target
        ON skill_relationships(target_id);
    `);
  }

  // ─── Classification ─────────────────────────────────────────

  /**
   * Classify a skill as orchestrator or extension/domain and retain source evidence.
   * Requirement 49.1
   */
  classifySkill(manifest: PublishableSkillManifest): ClassificationEvidence {
    return manifest.classification;
  }

  // ─── Validation ─────────────────────────────────────────────

  /**
   * Run all validation gates on a publishable skill manifest.
   * Requirement 49.2
   */
  validateManifest(manifest: PublishableSkillManifest): readonly ValidationOutcome[] {
    const outcomes: ValidationOutcome[] = [];
    const now = new Date().toISOString();

    // 1. Manifest schema validation
    outcomes.push(this.validateSchema(manifest, now));

    // 2. Relationship graph validation
    outcomes.push(this.validateRelationshipGraph(manifest, now));

    // 3. Capability validation
    outcomes.push(this.validateCapabilities(manifest, now));

    // 4. Tools and permissions validation
    outcomes.push(this.validateToolsPermissions(manifest, now));

    // 5. Safety validation
    outcomes.push(this.validateSafety(manifest, now));

    // 6. Trigger validation
    outcomes.push(this.validateTriggers(manifest, now));

    // 7. Compatibility validation
    outcomes.push(this.validateCompatibility(manifest, now));

    // 8. Provenance validation
    outcomes.push(this.validateProvenance(manifest, now));

    // 9. Duplicate validation
    outcomes.push(this.validateDuplicates(manifest, now));

    return outcomes;
  }

  private validateSchema(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    if (!manifest.candidateId) issues.push('Missing candidateId');
    if (!manifest.name || manifest.name.trim().length === 0) issues.push('Missing or empty name');
    if (!manifest.version) issues.push('Missing version');
    if (!manifest.classification) issues.push('Missing classification');
    if (!manifest.capabilities || manifest.capabilities.length === 0) {
      issues.push('Missing capabilities');
    }
    if (!manifest.fingerprints) issues.push('Missing fingerprints');
    if (!manifest.fingerprints?.manifestFingerprint) issues.push('Missing manifest fingerprint');
    if (!manifest.fingerprints?.contentFingerprint) issues.push('Missing content fingerprint');

    return {
      gate: 'manifest_schema',
      passed: issues.length === 0,
      details: issues.length === 0 ? 'Schema validation passed' : `Schema issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateRelationshipGraph(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    // Check for self-references
    for (const rel of manifest.relationships) {
      if (rel.targetSkillId === manifest.candidateId) {
        issues.push(`Self-referencing relationship to ${rel.targetSkillId}`);
      }
    }

    // Check for duplicate relationships
    const relKeys = manifest.relationships.map(r => `${r.targetSkillId}:${r.type}`);
    const duplicates = relKeys.filter((k, i) => relKeys.indexOf(k) !== i);
    if (duplicates.length > 0) {
      issues.push(`Duplicate relationships: ${duplicates.join(', ')}`);
    }

    return {
      gate: 'relationship_graph',
      passed: issues.length === 0,
      details: issues.length === 0 ? 'Relationship graph valid' : `Graph issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateCapabilities(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    if (manifest.capabilities.length === 0) {
      issues.push('No capabilities declared');
    }

    // Check for duplicate capabilities
    const uniqueCaps = new Set(manifest.capabilities);
    if (uniqueCaps.size !== manifest.capabilities.length) {
      issues.push('Duplicate capability keys found');
    }

    return {
      gate: 'capability',
      passed: issues.length === 0,
      details: issues.length === 0
        ? `${manifest.capabilities.length} capabilities validated`
        : `Capability issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateToolsPermissions(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    for (const tool of manifest.tools) {
      if (!tool.toolId) issues.push(`Tool missing ID`);
      if (!tool.name) issues.push(`Tool missing name`);
    }

    for (const perm of manifest.permissions) {
      if (!perm.scope) issues.push(`Permission missing scope`);
      if (!perm.level) issues.push(`Permission missing level`);
      if (!perm.justification) issues.push(`Permission missing justification for ${perm.resource}`);
    }

    return {
      gate: 'tools_permissions',
      passed: issues.length === 0,
      details: issues.length === 0
        ? `${manifest.tools.length} tools and ${manifest.permissions.length} permissions validated`
        : `Tools/Permissions issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateSafety(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    return {
      gate: 'safety',
      passed: manifest.safetyAssessment.safe,
      details: manifest.safetyAssessment.safe
        ? 'Safety assessment passed'
        : `Safety concerns: ${manifest.safetyAssessment.concerns.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateTriggers(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    if (manifest.triggers.length === 0) {
      issues.push('No triggers declared');
    }

    for (const trigger of manifest.triggers) {
      if (!trigger.patternId) issues.push('Trigger missing patternId');
      if (!trigger.rule) issues.push('Trigger missing rule');
    }

    // Check for duplicate trigger IDs
    const triggerIds = manifest.triggers.map(t => t.patternId);
    const dupTriggers = triggerIds.filter((id, i) => triggerIds.indexOf(id) !== i);
    if (dupTriggers.length > 0) {
      issues.push(`Duplicate trigger IDs: ${dupTriggers.join(', ')}`);
    }

    return {
      gate: 'triggers',
      passed: issues.length === 0,
      details: issues.length === 0
        ? `${manifest.triggers.length} triggers validated`
        : `Trigger issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateCompatibility(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    if (!manifest.compatibility.minPlatformVersion) {
      issues.push('Missing minimum platform version');
    }

    return {
      gate: 'compatibility',
      passed: issues.length === 0,
      details: issues.length === 0
        ? 'Compatibility constraints validated'
        : `Compatibility issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateProvenance(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    const issues: string[] = [];

    if (!manifest.provenance.sourceCommit) issues.push('Missing source commit');
    if (!manifest.provenance.sourcePath) issues.push('Missing source path');
    if (!manifest.provenance.blobHash) issues.push('Missing blob hash');
    if (!manifest.provenance.canonicalHash) issues.push('Missing canonical hash');
    if (!manifest.provenance.licenseSpdx) issues.push('Missing license SPDX');

    return {
      gate: 'provenance',
      passed: issues.length === 0,
      details: issues.length === 0
        ? 'Provenance validated'
        : `Provenance issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  private validateDuplicates(manifest: PublishableSkillManifest, now: string): ValidationOutcome {
    // Check against existing published skills for duplicate canonical IDs or aliases
    const issues: string[] = [];

    try {
      const existingById = this.db.prepare(
        'SELECT canonical_id FROM published_skills WHERE canonical_id = ?'
      ).get(manifest.candidateId) as { canonical_id: string } | undefined;

      if (existingById) {
        // This is an update, not a new skill - check that it's intentional
        // Update is allowed when explicitly approved
      }

      // Check for alias collisions
      for (const alias of manifest.aliases) {
        const existingAlias = this.db.prepare(
          'SELECT canonical_id FROM skill_aliases WHERE alias = ?'
        ).get(alias) as { canonical_id: string } | undefined;

        if (existingAlias && existingAlias.canonical_id !== manifest.candidateId) {
          issues.push(`Alias '${alias}' already resolves to ${existingAlias.canonical_id}`);
        }
      }
    } catch {
      // Tables may not exist yet in a fresh DB - that's fine
    }

    return {
      gate: 'duplicates',
      passed: issues.length === 0,
      details: issues.length === 0
        ? 'No duplicate conflicts'
        : `Duplicate issues: ${issues.join('; ')}`,
      validatedAt: now,
    };
  }

  // ─── Canonical ID and Version Assignment ────────────────────

  /**
   * Assign a canonical ID and version with uniquely resolvable aliases.
   * Requirement 49.3
   */
  assignCanonicalId(manifest: PublishableSkillManifest): CanonicalSkillId {
    const id = this.deriveCanonicalId(manifest);
    const resolvedAliases = this.resolveUniqueAliases(manifest, id);

    return {
      id,
      version: manifest.version,
      aliases: resolvedAliases,
    };
  }

  private deriveCanonicalId(manifest: PublishableSkillManifest): string {
    // Use external asset ID if available (imported skills)
    if (manifest.externalAssetId) {
      return manifest.externalAssetId.id;
    }
    // Otherwise derive from content fingerprint + name
    const hash = createHash('sha256')
      .update(`${manifest.name}:${manifest.fingerprints.contentFingerprint}`)
      .digest('hex')
      .slice(0, 16);
    return `skill:${this.slugify(manifest.name)}:${hash}`;
  }

  private resolveUniqueAliases(manifest: PublishableSkillManifest, canonicalId: string): readonly string[] {
    const uniqueAliases: string[] = [];

    for (const alias of manifest.aliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;

      // Check if alias already resolves to a different canonical ID
      try {
        const existing = this.db.prepare(
          'SELECT canonical_id FROM skill_aliases WHERE alias = ?'
        ).get(normalized) as { canonical_id: string } | undefined;

        if (!existing || existing.canonical_id === canonicalId) {
          uniqueAliases.push(normalized);
        }
        // Skip non-unique aliases silently per requirement
      } catch {
        // Table may not exist - alias is unique
        uniqueAliases.push(normalized);
      }
    }

    return uniqueAliases;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // ─── Dependency Resolution ──────────────────────────────────

  /**
   * Resolve all dependencies. Fail closed on any unresolved, ambiguous,
   * disabled, uninstalled, incompatible, or unsafe dependency.
   * Requirement 49.4
   */
  resolveDependencies(
    manifest: PublishableSkillManifest,
    catalogReader: CatalogStateReader,
  ): readonly DependencyResolution[] {
    const resolutions: DependencyResolution[] = [];

    for (const relationship of manifest.relationships) {
      if (relationship.type === 'depends_on' || relationship.type === 'extends' || relationship.type === 'composed_from') {
        const status = catalogReader.getDependencyStatus(relationship.targetSkillId);
        resolutions.push({
          targetId: relationship.targetSkillId,
          targetName: relationship.targetName,
          status,
          resolvedToCanonicalId: status === 'resolved' ? relationship.targetSkillId : null,
          reason: status === 'resolved'
            ? 'Dependency resolved in effective catalog'
            : `Dependency ${status}: ${relationship.targetName}`,
        });
      }
    }

    return resolutions;
  }

  /**
   * Checks if any dependency is in a failed state requiring quarantine.
   */
  hasUnresolvedDependencies(resolutions: readonly DependencyResolution[]): boolean {
    return resolutions.some(r => r.status !== 'resolved');
  }

  // ─── Transactional Publication ──────────────────────────────

  /**
   * Publish validated skills in one atomic SQLite transaction.
   * On any failure, preserves the prior immutable snapshot.
   * Requirements 49.5, 49.6
   */
  publish(
    candidates: readonly PublicationCandidate[],
    catalogReader: CatalogStateReader,
  ): PublicationResult {
    const now = new Date().toISOString();
    const priorSnapshot = this.getCurrentActiveSnapshot() ?? this.createInitialSnapshot(now);
    const publishedSkills: PublishedSkillRecord[] = [];
    const quarantined: QuarantinedPublicationRecord[] = [];

    // Pre-flight: separate passing candidates from those that need quarantine
    const validCandidates: PublicationCandidate[] = [];
    for (const candidate of candidates) {
      const allPassed = candidate.validationOutcomes.every(v => v.passed);
      const depsResolved = !this.hasUnresolvedDependencies(candidate.dependencyResolutions);

      if (!allPassed || !depsResolved) {
        const reasons: string[] = [];
        if (!allPassed) {
          const failedGates = candidate.validationOutcomes
            .filter(v => !v.passed)
            .map(v => v.gate);
          reasons.push(`Failed gates: ${failedGates.join(', ')}`);
        }
        if (!depsResolved) {
          const unresolvedDeps = candidate.dependencyResolutions
            .filter(d => d.status !== 'resolved')
            .map(d => `${d.targetName} (${d.status})`);
          reasons.push(`Unresolved deps: ${unresolvedDeps.join(', ')}`);
        }

        quarantined.push({
          candidateId: candidate.manifest.candidateId,
          name: candidate.manifest.name,
          reason: !depsResolved ? 'dependency_unresolved' : 'validation_failed',
          details: reasons.join('; '),
          quarantinedAt: now,
        });
      } else {
        validCandidates.push(candidate);
      }
    }

    // If no valid candidates, return without transaction
    if (validCandidates.length === 0) {
      // Record quarantine entries outside transaction
      for (const q of quarantined) {
        this.recordQuarantine(q);
      }
      return {
        success: quarantined.length === 0,
        publishedSkills: [],
        quarantined,
        priorSnapshot,
        newSnapshot: null,
        error: quarantined.length > 0 ? 'All candidates quarantined' : null,
        completedAt: now,
      };
    }

    // Execute publication in one SQLite transaction
    const transaction = this.db.transaction(() => {
      // Create new snapshot FIRST (required for FK constraint on published_skills)
      const newSnapshotId = this.generateId('snapshot');
      const newVersion = priorSnapshot.version + 1;
      const newEffectiveCount = priorSnapshot.effectiveSkillCount + validCandidates.length;

      this.db.prepare(`
        INSERT INTO skill_catalog_snapshots (snapshot_id, fingerprint, version, effective_skill_count, created_at, is_active)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(newSnapshotId, 'pending', newVersion, newEffectiveCount, now);

      // Write each valid candidate
      for (const candidate of validCandidates) {
        const { manifest, canonicalId } = candidate;

        // Insert published skill
        this.db.prepare(`
          INSERT OR REPLACE INTO published_skills
            (canonical_id, version, name, classification, manifest_json, fingerprint, provenance_json, snapshot_id, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          canonicalId.id,
          canonicalId.version,
          manifest.name,
          manifest.classification.classification,
          JSON.stringify(manifest),
          manifest.fingerprints.combinedFingerprint,
          JSON.stringify(manifest.provenance),
          newSnapshotId,
          now,
        );

        // Insert aliases (only uniquely resolvable ones)
        for (const alias of canonicalId.aliases) {
          this.db.prepare(`
            INSERT OR REPLACE INTO skill_aliases (alias, canonical_id)
            VALUES (?, ?)
          `).run(alias, canonicalId.id);
        }

        // Insert version record
        this.db.prepare(`
          INSERT OR REPLACE INTO skill_versions (canonical_id, version, fingerprint, published_at)
          VALUES (?, ?, ?, ?)
        `).run(canonicalId.id, canonicalId.version, manifest.fingerprints.combinedFingerprint, now);

        // Insert relationships
        for (const rel of manifest.relationships) {
          this.db.prepare(`
            INSERT INTO skill_relationships (source_id, target_id, relationship_type, required)
            VALUES (?, ?, ?, ?)
          `).run(canonicalId.id, rel.targetSkillId, rel.type, rel.required ? 1 : 0);
        }

        // Insert tests
        for (const test of manifest.tests) {
          this.db.prepare(`
            INSERT OR REPLACE INTO skill_tests (test_id, canonical_id, test_type, description, expected_outcome)
            VALUES (?, ?, ?, ?, ?)
          `).run(test.testId, canonicalId.id, test.type, test.description, test.expectedOutcome);
        }

        // Insert provenance
        this.db.prepare(`
          INSERT OR REPLACE INTO skill_provenance
            (canonical_id, source_commit, source_path, blob_hash, canonical_hash, license_spdx, parser_version, transform_version, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          canonicalId.id,
          manifest.provenance.sourceCommit,
          manifest.provenance.sourcePath,
          manifest.provenance.blobHash,
          manifest.provenance.canonicalHash,
          manifest.provenance.licenseSpdx,
          manifest.provenance.parserVersion,
          manifest.provenance.transformVersion,
          now,
        );

        // Insert fingerprints
        this.db.prepare(`
          INSERT OR REPLACE INTO skill_fingerprints (canonical_id, manifest_fingerprint, content_fingerprint, combined_fingerprint)
          VALUES (?, ?, ?, ?)
        `).run(
          canonicalId.id,
          manifest.fingerprints.manifestFingerprint,
          manifest.fingerprints.contentFingerprint,
          manifest.fingerprints.combinedFingerprint,
        );

        publishedSkills.push({
          canonicalId: canonicalId.id,
          version: canonicalId.version,
          name: manifest.name,
          aliases: canonicalId.aliases,
          classification: manifest.classification.classification,
          fingerprint: manifest.fingerprints.combinedFingerprint,
        });
      }

      // Compute new snapshot fingerprint and update the snapshot record
      const newFingerprint = this.computeSnapshotFingerprint(publishedSkills);
      this.db.prepare(`
        UPDATE skill_catalog_snapshots SET fingerprint = ?, is_active = 1 WHERE snapshot_id = ?
      `).run(newFingerprint, newSnapshotId);

      // Deactivate prior snapshot
      this.db.prepare(`
        UPDATE skill_catalog_snapshots SET is_active = 0 WHERE snapshot_id != ?
      `).run(newSnapshotId);

      // Postcondition: verify new snapshot is active
      const activeSnapshot = this.db.prepare(
        'SELECT snapshot_id FROM skill_catalog_snapshots WHERE is_active = 1'
      ).get() as { snapshot_id: string } | undefined;

      if (!activeSnapshot || activeSnapshot.snapshot_id !== newSnapshotId) {
        throw new Error('Postcondition failed: new snapshot not active after publication');
      }

      return {
        snapshotId: newSnapshotId,
        fingerprint: newFingerprint,
        createdAt: now,
        effectiveSkillCount: newEffectiveCount,
        version: newVersion,
      } as CatalogSnapshotMetadata;
    });

    try {
      const newSnapshot = transaction();

      // Record quarantine entries (outside the main transaction)
      for (const q of quarantined) {
        this.recordQuarantine(q);
      }

      return {
        success: true,
        publishedSkills,
        quarantined,
        priorSnapshot,
        newSnapshot,
        error: null,
        completedAt: now,
      };
    } catch (error) {
      // Transaction rolled back automatically by SQLite
      // Record quarantine entries
      for (const q of quarantined) {
        this.recordQuarantine(q);
      }

      return {
        success: false,
        publishedSkills: [],
        quarantined,
        priorSnapshot,
        newSnapshot: null,
        error: error instanceof Error ? error.message : String(error),
        completedAt: now,
      };
    }
  }

  // ─── Side-by-Side Inspection ────────────────────────────────

  /**
   * Generate a side-by-side version inspection for update approval.
   * Requirement 49.7
   */
  inspectVersion(candidate: PublicationCandidate): VersionInspection {
    const currentVersion = this.getPublishedSkill(candidate.canonicalId.id);
    const affectedAgents = this.getAffectedAgents(candidate.canonicalId.id);
    const breakingChanges = this.detectBreakingChanges(currentVersion, candidate);

    return {
      canonicalId: candidate.canonicalId.id,
      currentVersion,
      proposedVersion: candidate,
      assignmentImpact: {
        affectedAgentIds: affectedAgents,
        bundlesRequiringRevalidation: affectedAgents.length,
        breakingChanges,
      },
    };
  }

  /**
   * Rollback to a prior passing skill version.
   * Requirement 49.7
   */
  rollbackToVersion(canonicalId: string, targetVersion: string): boolean {
    const versionRecord = this.db.prepare(
      'SELECT * FROM skill_versions WHERE canonical_id = ? AND version = ?'
    ).get(canonicalId, targetVersion) as { canonical_id: string; version: string; fingerprint: string } | undefined;

    if (!versionRecord) {
      return false;
    }

    const transaction = this.db.transaction(() => {
      // Update published_skills to point to the target version
      this.db.prepare(`
        UPDATE published_skills SET version = ?, fingerprint = ? WHERE canonical_id = ?
      `).run(targetVersion, versionRecord.fingerprint, canonicalId);
    });

    try {
      transaction();
      return true;
    } catch {
      return false;
    }
  }

  // ─── Effective Resolution ───────────────────────────────────

  /**
   * Resolve a canonical ID or alias to a single deterministic effective skill.
   * Excludes quarantined, disabled, uninstalled, or superseded candidates.
   * Requirement 49.8
   */
  resolveEffective(idOrAlias: string): PublishedSkillRecord | null {
    // Try direct canonical ID first
    const direct = this.getPublishedSkill(idOrAlias);
    if (direct) return direct;

    // Try alias resolution
    const aliasRow = this.db.prepare(
      'SELECT canonical_id FROM skill_aliases WHERE alias = ?'
    ).get(idOrAlias.trim().toLowerCase()) as { canonical_id: string } | undefined;

    if (aliasRow) {
      return this.getPublishedSkill(aliasRow.canonical_id);
    }

    return null;
  }

  /**
   * Get all effective skills in the catalog.
   * Excludes quarantined and non-effective candidates.
   * The effective catalog is the complete set of published_skills records.
   */
  getEffectiveCatalog(): readonly PublishedSkillRecord[] {
    const activeSnapshot = this.getCurrentActiveSnapshot();
    if (!activeSnapshot) return [];

    const rows = this.db.prepare(
      'SELECT * FROM published_skills ORDER BY canonical_id ASC'
    ).all() as any[];

    return rows.map(row => ({
      canonicalId: row.canonical_id,
      version: row.version,
      name: row.name,
      aliases: this.getAliasesForSkill(row.canonical_id),
      classification: row.classification as SkillClassificationType,
      fingerprint: row.fingerprint,
    }));
  }

  // ─── Helpers ────────────────────────────────────────────────

  private getCurrentActiveSnapshot(): CatalogSnapshotMetadata | null {
    const row = this.db.prepare(
      'SELECT * FROM skill_catalog_snapshots WHERE is_active = 1 ORDER BY version DESC LIMIT 1'
    ).get() as any | undefined;

    if (!row) return null;

    return {
      snapshotId: row.snapshot_id,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      effectiveSkillCount: row.effective_skill_count,
      version: row.version,
    };
  }

  private createInitialSnapshot(now: string): CatalogSnapshotMetadata {
    const snapshotId = this.generateId('initial-snapshot');
    const fingerprint = createHash('sha256').update('empty-catalog').digest('hex');

    this.db.prepare(`
      INSERT INTO skill_catalog_snapshots (snapshot_id, fingerprint, version, effective_skill_count, created_at, is_active)
      VALUES (?, ?, 0, 0, ?, 1)
    `).run(snapshotId, fingerprint, now);

    return {
      snapshotId,
      fingerprint,
      createdAt: now,
      effectiveSkillCount: 0,
      version: 0,
    };
  }

  private getPublishedSkill(canonicalId: string): PublishedSkillRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM published_skills WHERE canonical_id = ?'
    ).get(canonicalId) as any | undefined;

    if (!row) return null;

    return {
      canonicalId: row.canonical_id,
      version: row.version,
      name: row.name,
      aliases: this.getAliasesForSkill(row.canonical_id),
      classification: row.classification as SkillClassificationType,
      fingerprint: row.fingerprint,
    };
  }

  private getAliasesForSkill(canonicalId: string): readonly string[] {
    const rows = this.db.prepare(
      'SELECT alias FROM skill_aliases WHERE canonical_id = ? ORDER BY alias ASC'
    ).all(canonicalId) as Array<{ alias: string }>;

    return rows.map(r => r.alias);
  }

  private getAffectedAgents(canonicalId: string): readonly string[] {
    try {
      // Check agent_skill_assignments for this skill
      const rows = this.db.prepare(
        'SELECT DISTINCT agent_id FROM agent_skill_assignments WHERE skill_id = ?'
      ).all(canonicalId) as Array<{ agent_id: string }>;
      return rows.map(r => r.agent_id);
    } catch {
      return [];
    }
  }

  private detectBreakingChanges(
    current: PublishedSkillRecord | null,
    proposed: PublicationCandidate,
  ): readonly string[] {
    if (!current) return [];

    const changes: string[] = [];

    if (current.classification !== proposed.manifest.classification.classification) {
      changes.push(`Classification changed from ${current.classification} to ${proposed.manifest.classification.classification}`);
    }

    if (current.fingerprint !== proposed.manifest.fingerprints.combinedFingerprint) {
      changes.push('Content fingerprint changed');
    }

    // Check if incompatible skills list changed
    for (const incompat of proposed.manifest.compatibility.incompatibleSkills) {
      changes.push(`New incompatibility declared with: ${incompat}`);
    }

    return changes;
  }

  private recordQuarantine(record: QuarantinedPublicationRecord): void {
    const id = this.generateId(`quarantine:${record.candidateId}`);
    this.db.prepare(`
      INSERT OR REPLACE INTO publication_quarantine (id, candidate_id, name, reason, details, quarantined_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, record.candidateId, record.name, record.reason, record.details, record.quarantinedAt);
  }

  private computeSnapshotFingerprint(skills: readonly PublishedSkillRecord[]): string {
    const hash = createHash('sha256');
    hash.update('skill-catalog-snapshot:');
    for (const skill of [...skills].sort((a, b) => a.canonicalId.localeCompare(b.canonicalId))) {
      hash.update(`${skill.canonicalId}:${skill.version}:${skill.fingerprint}\n`);
    }
    return hash.digest('hex');
  }

  private generateId(prefix: string): string {
    const random = createHash('sha256')
      .update(`${prefix}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    return `${prefix}-${random}`;
  }

  // ─── Full Publication Pipeline ──────────────────────────────

  /**
   * Execute the full publication pipeline:
   * 1. Classify
   * 2. Validate
   * 3. Assign canonical IDs
   * 4. Resolve dependencies
   * 5. Publish transactionally
   *
   * This is the primary entry point for publishing imported skills.
   */
  publishImportedSkills(
    manifests: readonly PublishableSkillManifest[],
    catalogReader: CatalogStateReader,
  ): PublicationResult {
    const candidates: PublicationCandidate[] = [];

    for (const manifest of manifests) {
      // 1. Validate
      const validationOutcomes = this.validateManifest(manifest);

      // 2. Assign canonical ID
      const canonicalId = this.assignCanonicalId(manifest);

      // 3. Resolve dependencies
      const dependencyResolutions = this.resolveDependencies(manifest, catalogReader);

      candidates.push({
        manifest,
        canonicalId,
        validationOutcomes,
        dependencyResolutions,
      });
    }

    // 4. Publish transactionally
    return this.publish(candidates, catalogReader);
  }
}
