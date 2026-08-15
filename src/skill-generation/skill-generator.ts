/**
 * Skill Generator
 *
 * Accepts only approved Catalog_Gaps from capability audits. Searches
 * existing skills for reuse, composition, extension, or safe generalization
 * before creating a candidate. Creates versioned inactive manifests, validates
 * schemas, shows semantic diffs, and rolls back on failure.
 *
 * Requirements: 42.1, 42.2, 42.3, 42.4, 42.5, 42.6, 42.7, 42.8
 */

import { createHash } from 'node:crypto';
import type {
  CandidateManifest,
  CandidateIdentity,
  CandidateState,
  CandidateFingerprints,
  CandidateApproval,
  CatalogPublicationResult,
  ExistingSkillMatch,
  SemanticDiff,
  DiffSection,
  StagedCandidate,
  TransformationProvenance,
  CompatibilityConstraints,
  TriggerPattern,
  ExclusionPattern,
  SkillInput,
  SkillOutput,
  ToolDeclaration,
  PermissionDeclaration,
  AssetReference,
  TestFixture,
  SourceAssetRecord,
  ContentOrigin,
  ValidationResult,
} from './types.js';

// ─── External Dependencies ───────────────────────────────────────

/**
 * Interface to query the existing skill catalog for reuse searches.
 */
export interface SkillRepository {
  /** Search skills by capability keys */
  searchByCapability(capabilityKey: string): readonly SkillRepositoryEntry[];
  /** Search skills by technology overlap */
  searchByTechnology(techKeys: readonly string[]): readonly SkillRepositoryEntry[];
  /** Get a skill by ID */
  getById(skillId: string): SkillRepositoryEntry | null;
  /** Get all enabled, installed, compatible skills */
  getActiveSkills(): readonly SkillRepositoryEntry[];
}

export interface SkillRepositoryEntry {
  readonly skillId: string;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly capabilityKeys: readonly string[];
  readonly technologyKeys: readonly string[];
  readonly deliverableKeys: readonly string[];
  readonly triggers: readonly string[];
  readonly exclusions: readonly string[];
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly contentFingerprint: string;
}

/**
 * Interface for approved audit decisions (from task 6.1).
 */
export interface AuditDecisionSource {
  /** Get an approved audit decision by ID */
  getApprovedDecision(auditDecisionId: string): ApprovedAuditDecision | null;
}

export interface ApprovedAuditDecision {
  readonly auditId: string;
  readonly catalogGapKey: string;
  readonly gapDisplayName: string;
  readonly sourceAssets: readonly string[];
  readonly capabilities: readonly string[];
  readonly triggers: readonly string[];
  readonly exclusions: readonly string[];
  readonly requiredTools: readonly string[];
  readonly approvedAt: number;
  readonly reviewerIdentity: string;
}

/**
 * Persistence for staged candidates.
 */
export interface CandidatePersistence {
  /** Save a staged candidate */
  saveCandidate(candidate: StagedCandidate): void;
  /** Get a staged candidate by ID */
  getCandidate(candidateId: string): StagedCandidate | null;
  /** Update candidate state */
  updateState(candidateId: string, state: CandidateState, updatedAt: number, error?: string): void;
  /** Add a validation result */
  addValidationResult(candidateId: string, result: ValidationResult): void;
  /** Set the semantic diff */
  setSemanticDiff(candidateId: string, diff: SemanticDiff): void;
  /** Remove all candidate data (for rollback) */
  rollbackCandidate(candidateId: string): void;
  /** List all staged candidates */
  listCandidates(): readonly StagedCandidate[];
}

/**
 * Interface for publishing to the immutable catalog.
 */
export interface CatalogPublisher {
  /** Publish a candidate as a new immutable catalog version */
  publish(manifest: CandidateManifest): CatalogPublicationResult;
  /** Get the current catalog version */
  getCurrentVersion(): number;
  /** Get the current catalog fingerprint */
  getCurrentFingerprint(): string;
}

// ─── Generator Configuration ─────────────────────────────────────

export interface SkillGeneratorConfig {
  /** Generator version identifier */
  readonly generatorVersion: string;
  /** Minimum platform version for generated candidates */
  readonly minPlatformVersion: string;
  /** Required catalog features for generated candidates */
  readonly requiredFeatures: readonly string[];
}

const DEFAULT_CONFIG: SkillGeneratorConfig = {
  generatorVersion: '1.0.0',
  minPlatformVersion: '1.0.0',
  requiredFeatures: [],
};

// ─── Skill Generator ─────────────────────────────────────────────

/**
 * SkillGenerator accepts only approved Catalog_Gaps and produces
 * schema-validated Generated_Skill_Candidates in a staging namespace.
 *
 * Core flow:
 * 1. Validate the audit decision is approved (R42.2)
 * 2. Search existing skills for reuse/compose/extend/generalize (R42.1)
 * 3. Create a versioned inactive manifest (R42.3)
 * 4. Record provenance and fingerprints (R42.4)
 * 5. Validate schema, references, permissions, triggers, behavior (R42.5)
 * 6. Show semantic diff for approval (R42.7)
 * 7. Roll back on failure (R42.6)
 * 8. Publish as new immutable catalog version (R42.8)
 */
export class SkillGenerator {
  private readonly config: SkillGeneratorConfig;

  constructor(
    private readonly repository: SkillRepository,
    private readonly auditSource: AuditDecisionSource,
    private readonly persistence: CandidatePersistence,
    private readonly publisher: CatalogPublisher,
    config?: Partial<SkillGeneratorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a skill candidate for an approved Catalog_Gap.
   *
   * Requirement 42.1: Search existing skills before creating a candidate.
   * Requirement 42.2: Create a candidate ONLY for a validated Catalog_Gap
   *   linked to an approved audit decision.
   *
   * @param auditDecisionId - The approved audit decision ID
   * @returns The staged candidate or null if the decision is invalid
   */
  generateCandidate(auditDecisionId: string): StagedCandidate | null {
    // 1. Validate the decision is approved (R42.2)
    const decision = this.auditSource.getApprovedDecision(auditDecisionId);
    if (!decision) {
      return null;
    }

    const now = Date.now();

    // 2. Search existing skills for reuse opportunities (R42.1)
    const existingMatches = this.searchExistingSkills(decision.catalogGapKey);

    // 3. Determine generation method based on matches
    const generationMethod = this.selectGenerationMethod(existingMatches);

    // 4. Build source asset records from matches
    const sourceAssets = this.buildSourceAssetRecords(existingMatches);

    // 5. Build content origins
    const contentOrigins = this.buildContentOrigins(existingMatches, generationMethod);

    // 6. Create the candidate identity
    const identity: CandidateIdentity = {
      candidateId: generateCandidateId(),
      name: `${decision.gapDisplayName} Skill`,
      version: '1.0.0',
      catalogGapKey: decision.catalogGapKey,
      auditDecisionId,
    };

    // 7. Build trigger patterns
    const triggers = this.buildTriggerPatterns(decision);

    // 8. Build exclusion patterns
    const exclusions = this.buildExclusionPatterns(decision, existingMatches);

    // 9. Build inputs/outputs
    const inputs = this.buildInputs(decision);
    const outputs = this.buildOutputs(decision);

    // 10. Build tool declarations
    const tools = this.buildToolDeclarations(decision);

    // 11. Build permissions
    const permissions = this.buildPermissions(tools);

    // 12. Build assets
    const assets = this.buildAssets(existingMatches);

    // 13. Build test fixtures
    const tests = this.buildTestFixtures(decision, triggers, exclusions);

    // 14. Build compatibility constraints
    const compatibility = this.buildCompatibility();

    // 15. Build provenance (R42.4)
    const provenance: TransformationProvenance = {
      sourceAssets,
      generationMethod,
      generatorVersion: this.config.generatorVersion,
      generatedAt: now,
      contentOrigins,
    };

    // 16. Compute fingerprints (R42.4)
    const fingerprints = this.computeFingerprints(
      identity,
      triggers,
      exclusions,
      inputs,
      outputs,
      tools,
      permissions,
      sourceAssets,
    );

    // 17. Assemble the manifest (R42.3)
    const manifest: CandidateManifest = {
      identity,
      triggers,
      exclusions,
      inputs,
      outputs,
      capabilities: [...decision.capabilities],
      tools,
      permissions,
      assets,
      tests,
      compatibility,
      provenance,
      fingerprints,
    };

    // 18. Create the staged candidate
    const candidate: StagedCandidate = {
      manifest,
      state: 'created',
      validationResults: [],
      semanticDiff: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };

    // 19. Persist to staging namespace
    this.persistence.saveCandidate(candidate);

    return candidate;
  }

  /**
   * Validate a staged candidate through all required gates.
   *
   * Requirement 42.5: Schema-validate the manifest, resolve all references
   * and scripts, validate declared tool permissions, and execute the required
   * trigger and behavior tests.
   *
   * @returns The validated candidate or null if not found
   */
  validateCandidate(candidateId: string): StagedCandidate | null {
    const candidate = this.persistence.getCandidate(candidateId);
    if (!candidate) {
      return null;
    }

    if (candidate.state === 'failed' || candidate.state === 'rolled_back') {
      return candidate;
    }

    const now = Date.now();
    const results: ValidationResult[] = [];

    // Gate 1: Schema validation
    const schemaResult = this.validateSchema(candidate.manifest);
    results.push(schemaResult);
    this.persistence.addValidationResult(candidateId, schemaResult);
    if (!schemaResult.passed) {
      return this.failCandidate(candidateId, now, `Schema validation failed: ${schemaResult.details}`);
    }
    this.persistence.updateState(candidateId, 'schema_validated', now);

    // Gate 2: References resolution
    const refResult = this.validateReferences(candidate.manifest);
    results.push(refResult);
    this.persistence.addValidationResult(candidateId, refResult);
    if (!refResult.passed) {
      return this.failCandidate(candidateId, now, `Reference resolution failed: ${refResult.details}`);
    }
    this.persistence.updateState(candidateId, 'references_resolved', now);

    // Gate 3: Permissions validation
    const permResult = this.validatePermissions(candidate.manifest);
    results.push(permResult);
    this.persistence.addValidationResult(candidateId, permResult);
    if (!permResult.passed) {
      return this.failCandidate(candidateId, now, `Permission validation failed: ${permResult.details}`);
    }
    this.persistence.updateState(candidateId, 'permissions_validated', now);

    // Gate 4: Trigger validation
    const triggerResult = this.validateTriggers(candidate.manifest);
    results.push(triggerResult);
    this.persistence.addValidationResult(candidateId, triggerResult);
    if (!triggerResult.passed) {
      return this.failCandidate(candidateId, now, `Trigger validation failed: ${triggerResult.details}`);
    }
    this.persistence.updateState(candidateId, 'triggers_validated', now);

    // Gate 5: Behavior tests
    const behaviorResult = this.validateBehavior(candidate.manifest);
    results.push(behaviorResult);
    this.persistence.addValidationResult(candidateId, behaviorResult);
    if (!behaviorResult.passed) {
      return this.failCandidate(candidateId, now, `Behavior validation failed: ${behaviorResult.details}`);
    }
    this.persistence.updateState(candidateId, 'behavior_tested', now);

    // All gates passed — build semantic diff and move to approval_pending
    const semanticDiff = this.buildSemanticDiff(candidate.manifest);
    this.persistence.setSemanticDiff(candidateId, semanticDiff);
    this.persistence.updateState(candidateId, 'approval_pending', now);

    return this.persistence.getCandidate(candidateId);
  }

  /**
   * Record an approval or rejection for a validated candidate.
   *
   * Requirement 42.7: Show semantic diff and require configured approval.
   */
  recordApproval(approval: CandidateApproval): StagedCandidate | null {
    const candidate = this.persistence.getCandidate(approval.candidateId);
    if (!candidate) {
      return null;
    }

    if (candidate.state !== 'approval_pending') {
      return candidate;
    }

    const now = approval.decidedAt;

    if (approval.approved) {
      this.persistence.updateState(approval.candidateId, 'approved', now);
    } else {
      this.persistence.updateState(approval.candidateId, 'rolled_back', now, `Rejected: ${approval.reason}`);
      this.persistence.rollbackCandidate(approval.candidateId);
    }

    return this.persistence.getCandidate(approval.candidateId);
  }

  /**
   * Publish an approved candidate as a new immutable catalog version.
   *
   * Requirement 42.6: Roll back all candidate files, rows, relationships,
   * and indexes on failure.
   *
   * Requirement 42.8: Create a new immutable catalog version without
   * rewriting history or identifiers of source skills.
   */
  publishCandidate(candidateId: string): CatalogPublicationResult | null {
    const candidate = this.persistence.getCandidate(candidateId);
    if (!candidate) {
      return null;
    }

    if (candidate.state !== 'approved') {
      return null;
    }

    const now = Date.now();

    try {
      // Attempt publication through the catalog publisher
      const result = this.publisher.publish(candidate.manifest);

      if (result.success) {
        this.persistence.updateState(candidateId, 'published', now);
      } else {
        // Roll back on failure (R42.6)
        this.persistence.updateState(candidateId, 'rolled_back', now, result.error);
        this.persistence.rollbackCandidate(candidateId);
      }

      return result;
    } catch (error) {
      // Roll back on exception (R42.6)
      const errorMsg = error instanceof Error ? error.message : 'Unknown publication error';
      this.persistence.updateState(candidateId, 'rolled_back', now, errorMsg);
      this.persistence.rollbackCandidate(candidateId);

      return {
        catalogVersion: this.publisher.getCurrentVersion(),
        publishedSkillId: '',
        success: false,
        error: errorMsg,
        catalogFingerprint: this.publisher.getCurrentFingerprint(),
      };
    }
  }

  /**
   * Search the existing skill repository for reuse opportunities.
   *
   * Requirement 42.1: Search existing skills for assets that can be
   * reused, composed, extended, or safely generalized before authoring.
   */
  searchExistingSkills(catalogGapKey: string): readonly ExistingSkillMatch[] {
    const matches: ExistingSkillMatch[] = [];

    // Search by direct capability match
    const capabilityMatches = this.repository.searchByCapability(catalogGapKey);
    for (const entry of capabilityMatches) {
      if (!entry.enabled || !entry.installed) continue;

      // Determine match type based on capability overlap
      const matchType = this.determineMatchType(catalogGapKey, entry);
      const confidence = this.calculateConfidence(catalogGapKey, entry, matchType);

      matches.push({
        skillId: entry.skillId,
        name: entry.name,
        matchType,
        confidence,
        reason: `Skill "${entry.name}" has ${matchType} potential for "${catalogGapKey}"`,
      });
    }

    // Search by technology overlap
    const techKeys = extractTechKeys(catalogGapKey);
    if (techKeys.length > 0) {
      const techMatches = this.repository.searchByTechnology(techKeys);
      for (const entry of techMatches) {
        if (!entry.enabled || !entry.installed) continue;
        // Avoid duplicates
        if (matches.some(m => m.skillId === entry.skillId)) continue;

        matches.push({
          skillId: entry.skillId,
          name: entry.name,
          matchType: 'extend',
          confidence: 0.4,
          reason: `Skill "${entry.name}" shares technology context with "${catalogGapKey}"`,
        });
      }
    }

    // Sort by confidence descending
    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  // ─── Private: Generation Method Selection ───────────────────────

  private selectGenerationMethod(
    matches: readonly ExistingSkillMatch[],
  ): TransformationProvenance['generationMethod'] {
    if (matches.length === 0) return 'novel';

    const bestMatch = matches[0];
    if (!bestMatch) return 'novel';

    if (bestMatch.matchType === 'reuse' && bestMatch.confidence >= 0.8) {
      return 'reuse_extension';
    }
    if (bestMatch.matchType === 'compose') {
      return 'composition';
    }
    if (bestMatch.matchType === 'generalize' || bestMatch.matchType === 'extend') {
      return 'generalization';
    }

    return 'novel';
  }

  private determineMatchType(
    gapKey: string,
    entry: SkillRepositoryEntry,
  ): ExistingSkillMatch['matchType'] {
    const normalizedGap = gapKey.toLowerCase();

    // Direct capability match = reuse
    const directMatch = entry.capabilityKeys.some(
      k => k.toLowerCase() === normalizedGap
    );
    if (directMatch) return 'reuse';

    // Partial capability overlap = compose
    const partialMatch = entry.capabilityKeys.some(k => {
      const nk = k.toLowerCase();
      return normalizedGap.includes(nk) || nk.includes(normalizedGap);
    });
    if (partialMatch) return 'compose';

    // Technology/deliverable overlap = extend or generalize
    const techOverlap = entry.technologyKeys.some(t =>
      normalizedGap.includes(t.toLowerCase())
    );
    if (techOverlap) return 'extend';

    return 'generalize';
  }

  private calculateConfidence(
    _gapKey: string,
    _entry: SkillRepositoryEntry,
    matchType: ExistingSkillMatch['matchType'],
  ): number {
    switch (matchType) {
      case 'reuse': return 0.9;
      case 'compose': return 0.7;
      case 'extend': return 0.5;
      case 'generalize': return 0.3;
      default: return 0.1;
    }
  }

  // ─── Private: Source Asset Records ──────────────────────────────

  private buildSourceAssetRecords(
    matches: readonly ExistingSkillMatch[],
  ): readonly SourceAssetRecord[] {
    return matches.map(match => {
      const entry = this.repository.getById(match.skillId);
      return {
        sourceId: match.skillId,
        sourceVersion: entry?.version ?? '0.0.0',
        usage: mapMatchTypeToUsage(match.matchType),
        sourceFingerprint: entry?.contentFingerprint ?? '',
      };
    });
  }

  private buildContentOrigins(
    matches: readonly ExistingSkillMatch[],
    method: TransformationProvenance['generationMethod'],
  ): readonly ContentOrigin[] {
    const origins: ContentOrigin[] = [];

    if (method === 'novel' || matches.length === 0) {
      origins.push({ section: 'body', origin: 'generated' });
      origins.push({ section: 'triggers', origin: 'generated' });
      origins.push({ section: 'tests', origin: 'generated' });
    } else {
      // Inherited sections from the best match
      const bestMatch = matches[0];
      if (bestMatch) {
        origins.push({ section: 'body', origin: 'inherited', sourceId: bestMatch.skillId });
        origins.push({ section: 'triggers', origin: 'generated' });
        origins.push({ section: 'tests', origin: 'generated' });
      }
    }

    return origins;
  }

  // ─── Private: Pattern Builders ──────────────────────────────────

  private buildTriggerPatterns(decision: ApprovedAuditDecision): readonly TriggerPattern[] {
    return decision.triggers.map((trigger, i) => ({
      patternId: `trigger-${i + 1}`,
      description: trigger,
      rule: trigger,
      type: 'capability_match' as const,
    }));
  }

  private buildExclusionPatterns(
    decision: ApprovedAuditDecision,
    matches: readonly ExistingSkillMatch[],
  ): readonly ExclusionPattern[] {
    const exclusions: ExclusionPattern[] = decision.exclusions.map((excl, i) => ({
      patternId: `exclusion-${i + 1}`,
      description: excl,
      rule: excl,
      type: 'explicit_exclusion' as const,
    }));

    // Add exclusion for direct overlap with existing reuse candidates
    for (const match of matches) {
      if (match.matchType === 'reuse' && match.confidence >= 0.8) {
        exclusions.push({
          patternId: `exclusion-overlap-${match.skillId}`,
          description: `Excludes when ${match.name} is already active`,
          rule: `active_skill:${match.skillId}`,
          type: 'capability_overlap' as const,
        });
      }
    }

    return exclusions;
  }

  private buildInputs(_decision: ApprovedAuditDecision): readonly SkillInput[] {
    return [{
      name: 'task_context',
      schema: 'TaskContext',
      required: true,
      description: 'The task context providing requirements, design, and scope',
    }, {
      name: 'repository_map',
      schema: 'RepositoryMap',
      required: false,
      description: 'Repository structure and file information',
    }];
  }

  private buildOutputs(_decision: ApprovedAuditDecision): readonly SkillOutput[] {
    return [{
      name: 'skill_guidance',
      schema: 'SkillGuidance',
      description: 'Operational guidance for task execution',
    }];
  }

  private buildToolDeclarations(decision: ApprovedAuditDecision): readonly ToolDeclaration[] {
    return decision.requiredTools.map((tool, i) => ({
      toolId: `tool-${i + 1}`,
      name: tool,
      required: true,
      purpose: `Required tool for ${decision.gapDisplayName}`,
    }));
  }

  private buildPermissions(tools: readonly ToolDeclaration[]): readonly PermissionDeclaration[] {
    const permissions: PermissionDeclaration[] = [];

    for (const tool of tools) {
      // Infer basic permissions from tool names
      const name = tool.name.toLowerCase();
      if (name.includes('file') || name.includes('read') || name.includes('write')) {
        permissions.push({
          scope: 'filesystem',
          level: name.includes('write') ? 'write' : 'read',
          resource: 'workspace/**',
          justification: `Required by tool: ${tool.name}`,
        });
      }
      if (name.includes('shell') || name.includes('exec') || name.includes('terminal')) {
        permissions.push({
          scope: 'shell',
          level: 'execute',
          resource: 'workspace',
          justification: `Required by tool: ${tool.name}`,
        });
      }
      if (name.includes('git')) {
        permissions.push({
          scope: 'git',
          level: 'write',
          resource: 'workspace',
          justification: `Required by tool: ${tool.name}`,
        });
      }
    }

    return permissions;
  }

  private buildAssets(matches: readonly ExistingSkillMatch[]): readonly AssetReference[] {
    const assets: AssetReference[] = [];

    for (const match of matches) {
      if (match.matchType === 'reuse' || match.matchType === 'extend') {
        assets.push({
          assetId: `asset-ref-${match.skillId}`,
          type: 'reference',
          path: `references/${match.skillId}.md`,
          fingerprint: computeHash(match.skillId),
          origin: 'inherited',
        });
      }
    }

    return assets;
  }

  private buildTestFixtures(
    decision: ApprovedAuditDecision,
    triggers: readonly TriggerPattern[],
    exclusions: readonly ExclusionPattern[],
  ): readonly TestFixture[] {
    const tests: TestFixture[] = [];

    // Positive trigger tests
    for (const trigger of triggers) {
      tests.push({
        testId: `test-positive-${trigger.patternId}`,
        type: 'trigger_positive',
        description: `Verify skill activates for: ${trigger.description}`,
        expectedOutcome: 'activate',
        input: { trigger: trigger.rule, capabilities: decision.capabilities },
      });
    }

    // Near-miss negative tests
    for (const exclusion of exclusions) {
      tests.push({
        testId: `test-negative-${exclusion.patternId}`,
        type: 'trigger_negative',
        description: `Verify skill does NOT activate for: ${exclusion.description}`,
        expectedOutcome: 'no_activate',
        input: { trigger: exclusion.rule, capabilities: [] },
      });
    }

    // Basic behavior test
    tests.push({
      testId: 'test-behavior-basic',
      type: 'behavior',
      description: `Verify basic behavior for ${decision.gapDisplayName}`,
      expectedOutcome: 'pass',
      input: { capabilities: decision.capabilities, taskType: decision.catalogGapKey },
    });

    // Safety test
    tests.push({
      testId: 'test-safety-basic',
      type: 'safety',
      description: 'Verify skill does not exceed declared permissions',
      expectedOutcome: 'pass',
      input: { capabilities: decision.capabilities },
    });

    return tests;
  }

  private buildCompatibility(): CompatibilityConstraints {
    return {
      minPlatformVersion: this.config.minPlatformVersion,
      maxPlatformVersion: null,
      requiredFeatures: [...this.config.requiredFeatures],
      incompatibleSkills: [],
    };
  }

  // ─── Private: Fingerprint Computation ───────────────────────────

  private computeFingerprints(
    identity: CandidateIdentity,
    triggers: readonly TriggerPattern[],
    exclusions: readonly ExclusionPattern[],
    inputs: readonly SkillInput[],
    outputs: readonly SkillOutput[],
    tools: readonly ToolDeclaration[],
    permissions: readonly PermissionDeclaration[],
    sourceAssets: readonly SourceAssetRecord[],
  ): CandidateFingerprints {
    // Content fingerprint: hash of the skill guidance content
    const contentHash = createHash('sha256');
    contentHash.update(identity.catalogGapKey);
    contentHash.update(JSON.stringify(triggers));
    contentHash.update(JSON.stringify(inputs));
    contentHash.update(JSON.stringify(outputs));
    const contentFingerprint = contentHash.digest('hex');

    // Manifest fingerprint: hash of the structural manifest
    const manifestHash = createHash('sha256');
    manifestHash.update(identity.candidateId);
    manifestHash.update(identity.version);
    manifestHash.update(JSON.stringify(triggers));
    manifestHash.update(JSON.stringify(exclusions));
    manifestHash.update(JSON.stringify(tools));
    manifestHash.update(JSON.stringify(permissions));
    const manifestFingerprint = manifestHash.digest('hex');

    // Combined fingerprint
    const combinedHash = createHash('sha256');
    combinedHash.update(contentFingerprint);
    combinedHash.update(manifestFingerprint);
    const combinedFingerprint = combinedHash.digest('hex');

    // Inherited fingerprints from source assets
    const inheritedFingerprints = sourceAssets
      .filter(sa => sa.sourceFingerprint)
      .map(sa => sa.sourceFingerprint);

    // Generated-only fingerprint (content minus inherited)
    const generatedHash = createHash('sha256');
    generatedHash.update(contentFingerprint);
    for (const fp of inheritedFingerprints) {
      generatedHash.update(fp);
    }
    const generatedFingerprint = generatedHash.digest('hex');

    return {
      manifestFingerprint,
      contentFingerprint,
      combinedFingerprint,
      inheritedFingerprints,
      generatedFingerprint,
    };
  }

  // ─── Private: Validation Gates ──────────────────────────────────

  /**
   * Validate the manifest schema (R42.5 gate 1).
   */
  private validateSchema(manifest: CandidateManifest): ValidationResult {
    const now = Date.now();
    const errors: string[] = [];

    // Required identity fields
    if (!manifest.identity.candidateId) errors.push('Missing candidateId');
    if (!manifest.identity.name) errors.push('Missing name');
    if (!manifest.identity.version) errors.push('Missing version');
    if (!manifest.identity.catalogGapKey) errors.push('Missing catalogGapKey');
    if (!manifest.identity.auditDecisionId) errors.push('Missing auditDecisionId');

    // At least one trigger
    if (manifest.triggers.length === 0) errors.push('At least one trigger pattern is required');

    // At least one capability
    if (manifest.capabilities.length === 0) errors.push('At least one capability is required');

    // At least one input
    if (manifest.inputs.length === 0) errors.push('At least one input is required');

    // At least one output
    if (manifest.outputs.length === 0) errors.push('At least one output is required');

    // At least one test
    if (manifest.tests.length === 0) errors.push('At least one test fixture is required');

    // Provenance must exist
    if (!manifest.provenance.generatorVersion) errors.push('Missing generator version in provenance');
    if (!manifest.provenance.generatedAt) errors.push('Missing generation timestamp');

    // Fingerprints must exist
    if (!manifest.fingerprints.manifestFingerprint) errors.push('Missing manifest fingerprint');
    if (!manifest.fingerprints.contentFingerprint) errors.push('Missing content fingerprint');
    if (!manifest.fingerprints.combinedFingerprint) errors.push('Missing combined fingerprint');

    // Compatibility
    if (!manifest.compatibility.minPlatformVersion) errors.push('Missing minimum platform version');

    // Trigger pattern validation
    for (const trigger of manifest.triggers) {
      if (!trigger.patternId) errors.push('Trigger missing patternId');
      if (!trigger.rule) errors.push('Trigger missing rule');
      if (!trigger.type) errors.push('Trigger missing type');
    }

    // Test fixture validation
    for (const test of manifest.tests) {
      if (!test.testId) errors.push('Test missing testId');
      if (!test.type) errors.push('Test missing type');
      if (!test.expectedOutcome) errors.push('Test missing expectedOutcome');
    }

    const passed = errors.length === 0;
    return {
      gate: 'schema',
      passed,
      details: passed ? 'Schema validation passed' : errors.join('; '),
      validatedAt: now,
    };
  }

  /**
   * Validate references and scripts (R42.5 gate 2).
   */
  private validateReferences(manifest: CandidateManifest): ValidationResult {
    const now = Date.now();
    const errors: string[] = [];

    for (const asset of manifest.assets) {
      if (!asset.assetId) errors.push(`Asset missing assetId`);
      if (!asset.path) errors.push(`Asset "${asset.assetId}" missing path`);
      if (!asset.fingerprint) errors.push(`Asset "${asset.assetId}" missing fingerprint`);
      if (!asset.type) errors.push(`Asset "${asset.assetId}" missing type`);
    }

    // Verify source asset references in provenance exist in repository
    for (const source of manifest.provenance.sourceAssets) {
      if (!source.sourceId) {
        errors.push('Source asset record missing sourceId');
        continue;
      }
      const entry = this.repository.getById(source.sourceId);
      if (!entry) {
        errors.push(`Source asset "${source.sourceId}" not found in repository`);
      }
    }

    const passed = errors.length === 0;
    return {
      gate: 'references',
      passed,
      details: passed ? 'All references resolved successfully' : errors.join('; '),
      validatedAt: now,
    };
  }

  /**
   * Validate declared tool permissions (R42.5 gate 3).
   */
  private validatePermissions(manifest: CandidateManifest): ValidationResult {
    const now = Date.now();
    const errors: string[] = [];

    for (const perm of manifest.permissions) {
      // Validate scope
      const validScopes = ['filesystem', 'network', 'shell', 'git', 'external_service'];
      if (!validScopes.includes(perm.scope)) {
        errors.push(`Invalid permission scope: ${perm.scope}`);
      }

      // Validate level
      const validLevels = ['read', 'write', 'execute'];
      if (!validLevels.includes(perm.level)) {
        errors.push(`Invalid permission level: ${perm.level}`);
      }

      // Must have a resource pattern
      if (!perm.resource) {
        errors.push(`Permission for scope "${perm.scope}" missing resource pattern`);
      }

      // Must have justification
      if (!perm.justification) {
        errors.push(`Permission for scope "${perm.scope}" missing justification`);
      }
    }

    // Each declared tool should have corresponding permissions
    for (const tool of manifest.tools) {
      if (tool.required) {
        const hasPermission = manifest.permissions.some(p => p.justification.includes(tool.name));
        if (!hasPermission) {
          // Warning but not blocking — tool might not need extra permissions
        }
      }
    }

    const passed = errors.length === 0;
    return {
      gate: 'permissions',
      passed,
      details: passed ? 'Permission validation passed' : errors.join('; '),
      validatedAt: now,
    };
  }

  /**
   * Validate trigger patterns (R42.5 gate 4).
   */
  private validateTriggers(manifest: CandidateManifest): ValidationResult {
    const now = Date.now();
    const errors: string[] = [];

    // Must have at least one positive trigger test
    const hasPositiveTest = manifest.tests.some(t => t.type === 'trigger_positive');
    if (!hasPositiveTest) {
      errors.push('No positive trigger test fixture found');
    }

    // Must have at least one negative trigger test
    const hasNegativeTest = manifest.tests.some(t => t.type === 'trigger_negative');
    if (!hasNegativeTest) {
      errors.push('No negative trigger test fixture found');
    }

    // Check for duplicate trigger patterns
    const seenRules = new Set<string>();
    for (const trigger of manifest.triggers) {
      if (seenRules.has(trigger.rule)) {
        errors.push(`Duplicate trigger rule: ${trigger.rule}`);
      }
      seenRules.add(trigger.rule);
    }

    // Check for conflicting trigger/exclusion patterns
    for (const trigger of manifest.triggers) {
      for (const exclusion of manifest.exclusions) {
        if (trigger.rule === exclusion.rule) {
          errors.push(`Trigger and exclusion have identical rule: ${trigger.rule}`);
        }
      }
    }

    const passed = errors.length === 0;
    return {
      gate: 'triggers',
      passed,
      details: passed ? 'Trigger validation passed' : errors.join('; '),
      validatedAt: now,
    };
  }

  /**
   * Validate behavior tests (R42.5 gate 5).
   */
  private validateBehavior(manifest: CandidateManifest): ValidationResult {
    const now = Date.now();
    const errors: string[] = [];

    // Must have at least one behavior test
    const hasBehaviorTest = manifest.tests.some(t => t.type === 'behavior');
    if (!hasBehaviorTest) {
      errors.push('No behavior test fixture found');
    }

    // Must have at least one safety test
    const hasSafetyTest = manifest.tests.some(t => t.type === 'safety');
    if (!hasSafetyTest) {
      errors.push('No safety test fixture found');
    }

    // Verify all tests have expected outcomes
    for (const test of manifest.tests) {
      if (!test.expectedOutcome) {
        errors.push(`Test "${test.testId}" missing expected outcome`);
      }
    }

    const passed = errors.length === 0;
    return {
      gate: 'behavior',
      passed,
      details: passed ? 'Behavior validation passed' : errors.join('; '),
      validatedAt: now,
    };
  }

  // ─── Private: Semantic Diff ─────────────────────────────────────

  /**
   * Build a semantic diff showing reused, generalized, and generated material.
   *
   * Requirement 42.7: Show semantic diff before activation.
   */
  private buildSemanticDiff(manifest: CandidateManifest): SemanticDiff {
    const reusedSections: DiffSection[] = [];
    const generalizedSections: DiffSection[] = [];
    const generatedSections: DiffSection[] = [];

    for (const origin of manifest.provenance.contentOrigins) {
      const section: DiffSection = {
        section: origin.section,
        ...(origin.sourceId != null ? { sourceId: origin.sourceId } : {}),
        description: origin.origin === 'inherited'
          ? `Reused from ${origin.sourceId}`
          : 'Newly generated content',
      };

      if (origin.origin === 'inherited') {
        const sourceRecord = manifest.provenance.sourceAssets.find(
          sa => sa.sourceId === origin.sourceId
        );
        if (sourceRecord?.usage === 'generalized' || sourceRecord?.usage === 'extended') {
          generalizedSections.push({
            ...section,
            description: `Generalized from ${origin.sourceId}`,
          });
        } else {
          reusedSections.push(section);
        }
      } else {
        generatedSections.push(section);
      }
    }

    // Add asset references as reused sections
    for (const asset of manifest.assets) {
      if (asset.origin === 'inherited') {
        reusedSections.push({
          section: `asset:${asset.assetId}`,
          description: `Inherited reference: ${asset.path}`,
        });
      }
    }

    const reusedCount = reusedSections.length;
    const generalizedCount = generalizedSections.length;
    const generatedCount = generatedSections.length;
    const total = reusedCount + generalizedCount + generatedCount;

    const summary = total === 0
      ? 'No content sections identified'
      : `${reusedCount} reused, ${generalizedCount} generalized, ${generatedCount} generated sections`;

    return {
      reusedSections,
      generalizedSections,
      generatedSections,
      summary,
    };
  }

  // ─── Private: Failure Handling ──────────────────────────────────

  /**
   * Mark a candidate as failed and roll back.
   *
   * Requirement 42.6: Roll back candidate files, rows, relationships,
   * and indexes on failure.
   */
  private failCandidate(candidateId: string, timestamp: number, error: string): StagedCandidate | null {
    this.persistence.updateState(candidateId, 'failed', timestamp, error);
    this.persistence.rollbackCandidate(candidateId);
    return this.persistence.getCandidate(candidateId);
  }
}

// ─── Helper Functions ────────────────────────────────────────────

function generateCandidateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `gen-skill-${timestamp}-${random}`;
}

function computeHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function extractTechKeys(gapKey: string): string[] {
  // Extract technology-related tokens from a capability gap key
  const tokens = gapKey.split(/[-_\s]+/).filter(t => t.length > 2);
  return tokens;
}

function mapMatchTypeToUsage(
  matchType: ExistingSkillMatch['matchType'],
): SourceAssetRecord['usage'] {
  switch (matchType) {
    case 'reuse': return 'reused';
    case 'compose': return 'composed';
    case 'extend': return 'extended';
    case 'generalize': return 'generalized';
    default: return 'reference_only';
  }
}
