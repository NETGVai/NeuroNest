/**
 * Capability Auditor
 *
 * Analyzes current requirements, design, Tasks, Repository_Map, configured agents,
 * and one immutable authoritative catalog snapshot before proposing generation.
 *
 * Maps every capability to reuse, composition, extension/generalization, or an
 * evidenced Catalog_Gap. Rejects legacy keyword/startup mappings as proof of
 * coverage. Stales any plan when an input fingerprint changes. Persists audit
 * inputs, decisions, reviewer, outcome, and timestamps as linked Evidence.
 *
 * Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8
 */

import { createHash } from 'node:crypto';
import type {
  AuditedCapability,
  AuditEvidenceRecord,
  AuditInputFingerprint,
  AuditInputSet,
  AuditApprovalDecision,
  AuditState,
  CapabilityAuditResult,
  CapabilityDisposition,
  CapabilitySource,
  CatalogChangePreview,
  DispositionEvidence,
  ProposedAsset,
  RejectedLegacyMapping,
} from './types.js';
import type { AuthoritativeSkillCatalogSnapshot } from '../agent-skills/agent-skills-service.js';
import type { RepositoryMap } from '../repository-map/types.js';
import type { PlanningTask } from '../planning/types.js';

// ─── Input Source Abstractions ───────────────────────────────────

/**
 * Abstraction for reading audit inputs from the workspace.
 * Implementations connect to the actual planning, repository, and catalog services.
 */
export interface AuditInputProvider {
  /** Get fingerprinted requirements content */
  getRequirementsFingerprint(workspaceId: string): AuditInputFingerprint;
  /** Get fingerprinted design content */
  getDesignFingerprint(workspaceId: string): AuditInputFingerprint;
  /** Get fingerprinted task state */
  getTasksFingerprint(workspaceId: string): AuditInputFingerprint;
  /** Get fingerprinted repository map */
  getRepositoryMapFingerprint(workspaceId: string): AuditInputFingerprint;
  /** Get fingerprinted configured agents */
  getConfiguredAgentsFingerprint(workspaceId: string): AuditInputFingerprint;
  /** Get the immutable authoritative catalog snapshot */
  getCatalogSnapshot(): AuthoritativeSkillCatalogSnapshot;
  /** Get all tasks for the workspace */
  getTasks(workspaceId: string): readonly PlanningTask[];
  /** Get repository map (may be partial/stale) */
  getRepositoryMap(workspaceId: string): RepositoryMap | null;
  /** Get configured agent IDs and their capability keys */
  getConfiguredAgents(workspaceId: string): readonly ConfiguredAgent[];
  /** Get legacy keyword/startup mappings that bypass validation */
  getLegacyMappings(workspaceId: string): readonly LegacyMapping[];
  /** Get requirement-derived capability needs */
  getRequirementCapabilities(workspaceId: string): readonly CapabilitySource[];
  /** Get design-derived capability needs */
  getDesignCapabilities(workspaceId: string): readonly CapabilitySource[];
  /** Get task-derived capability needs */
  getTaskCapabilities(workspaceId: string): readonly CapabilitySource[];
}

/**
 * A configured agent with extracted capability keys.
 */
export interface ConfiguredAgent {
  readonly agentId: string;
  readonly name: string;
  readonly capabilityKeys: readonly string[];
  readonly enabled: boolean;
}

/**
 * A legacy keyword/startup mapping that bypasses authoritative validation.
 */
export interface LegacyMapping {
  readonly mappingId: string;
  readonly skillId: string;
  readonly keyword: string;
  readonly source: 'keyword_router' | 'startup_config';
}

// ─── Persistence Abstraction ─────────────────────────────────────

/**
 * Persistence interface for audit results and evidence.
 */
export interface AuditPersistence {
  /** Save an audit result */
  saveAudit(audit: CapabilityAuditResult): void;
  /** Load the most recent non-stale audit for a workspace */
  getLatestAudit(workspaceId: string): CapabilityAuditResult | null;
  /** Load an audit by ID */
  getAuditById(auditId: string): CapabilityAuditResult | null;
  /** Update audit state */
  updateAuditState(auditId: string, state: AuditState, updatedAt: number): void;
  /** Save the approval decision */
  saveApprovalDecision(decision: AuditApprovalDecision): void;
  /** Save evidence record */
  saveEvidence(evidence: AuditEvidenceRecord): void;
}

// ─── Capability Auditor ──────────────────────────────────────────

/**
 * CapabilityAuditor performs project capability analysis.
 *
 * Core responsibilities:
 * 1. Collect and fingerprint all inputs (R41.1)
 * 2. Map capabilities to disposition (reuse/compose/extend/gap) (R41.2, R41.3)
 * 3. Reject legacy keyword/startup mappings (R41.8)
 * 4. Generate a diffable plan preview (R41.4, R41.5)
 * 5. Detect staleness via fingerprint changes (R41.6)
 * 6. Persist all decisions as Evidence (R41.7)
 */
export class CapabilityAuditor {
  constructor(
    private readonly inputProvider: AuditInputProvider,
    private readonly persistence: AuditPersistence,
  ) {}

  /**
   * Perform a full capability audit for the given workspace.
   * Returns the audit result in `pending_approval` state.
   *
   * Requirement 41.1: Analyze current requirements, design, tasks,
   * Repository_Map, configured agents, and one immutable catalog snapshot.
   */
  performAudit(workspaceId: string): CapabilityAuditResult {
    // 1. Collect all input fingerprints
    const inputs = this.collectInputFingerprints(workspaceId);
    const combinedFingerprint = computeCombinedFingerprint(inputs);

    // 2. Check if an existing non-stale audit exists with same fingerprint
    const existing = this.persistence.getLatestAudit(workspaceId);
    if (existing && existing.combinedInputFingerprint === combinedFingerprint && existing.state !== 'stale') {
      return existing;
    }

    // 3. Gather capability needs from all sources
    const requirementCapabilities = this.inputProvider.getRequirementCapabilities(workspaceId);
    const designCapabilities = this.inputProvider.getDesignCapabilities(workspaceId);
    const taskCapabilities = this.inputProvider.getTaskCapabilities(workspaceId);

    const allSources = [
      ...requirementCapabilities,
      ...designCapabilities,
      ...taskCapabilities,
    ];

    // 4. Get the catalog snapshot for resolution
    const catalogSnapshot = this.inputProvider.getCatalogSnapshot();
    const configuredAgents = this.inputProvider.getConfiguredAgents(workspaceId);
    const legacyMappings = this.inputProvider.getLegacyMappings(workspaceId);

    // 5. Classify each capability
    const capabilities = this.classifyCapabilities(
      allSources,
      catalogSnapshot,
      configuredAgents,
      legacyMappings,
    );

    // 6. Reject legacy mappings (R41.8)
    const rejectedLegacyMappings = this.identifyRejectedLegacyMappings(legacyMappings);

    // 7. Separate gaps from satisfied
    const catalogGaps = capabilities.filter(c => c.disposition === 'catalog_gap');
    const satisfiedCapabilities = capabilities.filter(c => c.disposition !== 'catalog_gap');

    // 8. Build generation plan for gaps (R41.4)
    const generationPlan = this.buildGenerationPlan(catalogGaps, catalogSnapshot);

    // 9. Create the audit result
    const auditId = generateId();
    const now = Date.now();

    const result: CapabilityAuditResult = {
      auditId,
      workspaceId,
      inputs,
      combinedInputFingerprint: combinedFingerprint,
      capabilities,
      catalogGaps,
      satisfiedCapabilities,
      rejectedLegacyMappings,
      generationPlan,
      state: 'pending_approval',
      createdAt: now,
      updatedAt: now,
    };

    // 10. Persist audit and evidence (R41.7)
    this.persistence.saveAudit(result);
    this.persistEvidence(result);

    return result;
  }

  /**
   * Check whether an existing audit is stale.
   * If any input fingerprint has changed, marks the audit stale.
   *
   * Requirement 41.6: Stale any plan when an input fingerprint changes.
   */
  checkStaleness(auditId: string, workspaceId: string): boolean {
    const audit = this.persistence.getAuditById(auditId);
    if (!audit) {
      return true;
    }

    if (audit.state === 'stale') {
      return true;
    }

    const currentInputs = this.collectInputFingerprints(workspaceId);
    const currentCombined = computeCombinedFingerprint(currentInputs);

    if (currentCombined !== audit.combinedInputFingerprint) {
      const now = Date.now();
      this.persistence.updateAuditState(auditId, 'stale', now);
      return true;
    }

    return false;
  }

  /**
   * Record an approval decision on an audit.
   *
   * Requirement 41.5: Require an approval decision from an authorized user.
   * Requirement 41.7: Persist reviewer identity, approval outcome, and timestamps.
   */
  recordApproval(decision: AuditApprovalDecision): CapabilityAuditResult | null {
    const audit = this.persistence.getAuditById(decision.auditId);
    if (!audit) {
      return null;
    }

    // Cannot approve a stale audit
    if (audit.state === 'stale') {
      return null;
    }

    const newState: AuditState = decision.approved ? 'approved' : 'rejected';
    this.persistence.updateAuditState(decision.auditId, newState, decision.decidedAt);
    this.persistence.saveApprovalDecision(decision);

    // Update evidence with reviewer info
    const evidence: AuditEvidenceRecord = {
      evidenceId: generateId(),
      auditId: decision.auditId,
      workspaceId: audit.workspaceId,
      inputFingerprints: audit.inputs,
      combinedInputFingerprint: audit.combinedInputFingerprint,
      gapDecisions: audit.catalogGaps,
      reviewerIdentity: decision.reviewerIdentity,
      approvalOutcome: decision.approved,
      createdAt: decision.decidedAt,
      updatedAt: decision.decidedAt,
    };
    this.persistence.saveEvidence(evidence);

    return {
      ...audit,
      state: newState,
      updatedAt: decision.decidedAt,
    };
  }

  /**
   * Collect fingerprints for all audit inputs.
   */
  private collectInputFingerprints(workspaceId: string): AuditInputSet {
    return {
      requirements: this.inputProvider.getRequirementsFingerprint(workspaceId),
      design: this.inputProvider.getDesignFingerprint(workspaceId),
      tasks: this.inputProvider.getTasksFingerprint(workspaceId),
      repositoryMap: this.inputProvider.getRepositoryMapFingerprint(workspaceId),
      configuredAgents: this.inputProvider.getConfiguredAgentsFingerprint(workspaceId),
      catalogSnapshot: {
        inputKind: 'catalog_snapshot',
        fingerprint: this.inputProvider.getCatalogSnapshot().fingerprint,
        timestamp: Date.now(),
      },
    };
  }

  /**
   * Classify every derived capability against the catalog and configured agents.
   *
   * Requirement 41.2: Map every required task capability to reuse, composition,
   * extension, or a typed Catalog_Gap with supporting evidence.
   *
   * Requirement 41.3: Select reuse, composition, or generalization before
   * creating a Generated_Skill_Candidate.
   *
   * Requirement 41.8: Legacy keyword/startup mappings are not evidence of
   * capability coverage.
   */
  private classifyCapabilities(
    sources: readonly CapabilitySource[],
    catalog: AuthoritativeSkillCatalogSnapshot,
    agents: readonly ConfiguredAgent[],
    legacyMappings: readonly LegacyMapping[],
  ): AuditedCapability[] {
    // Build a set of legacy-mapped skill IDs to reject
    const legacySkillIds = new Set(legacyMappings.map(m => m.skillId));

    // Deduplicate capabilities by key
    const capabilityMap = new Map<string, CapabilitySource[]>();
    for (const source of sources) {
      const key = normalizeCapabilityKey(source.description);
      const existing = capabilityMap.get(key) ?? [];
      existing.push(source);
      capabilityMap.set(key, existing);
    }

    const results: AuditedCapability[] = [];

    for (const [capKey, capSources] of capabilityMap) {
      if (capSources.length === 0) continue;
      const primarySource = capSources[0]!;

      const disposition = this.resolveDisposition(
        capKey,
        catalog,
        agents,
        legacySkillIds,
      );

      results.push({
        capabilityKey: capKey,
        displayName: primarySource.description,
        derivedFrom: primarySource,
        disposition: disposition.disposition,
        evidence: disposition.evidence,
        legacyMappingRejected: disposition.legacyRejected,
      });
    }

    return results;
  }

  /**
   * Resolve how a single capability is best satisfied.
   * Precedence: reuse > composition > extension > catalog_gap.
   * Legacy mappings are explicitly rejected (R41.8).
   */
  private resolveDisposition(
    capabilityKey: string,
    catalog: AuthoritativeSkillCatalogSnapshot,
    agents: readonly ConfiguredAgent[],
    legacySkillIds: ReadonlySet<string>,
  ): { disposition: CapabilityDisposition; evidence: DispositionEvidence[]; legacyRejected: boolean } {
    const evidence: DispositionEvidence[] = [];
    let legacyRejected = false;

    // 1. Check for direct catalog skill match (reuse)
    const directMatch = this.findDirectCatalogMatch(capabilityKey, catalog, legacySkillIds);
    if (directMatch) {
      if (directMatch.isLegacy) {
        // Legacy mapping found but rejected — not valid evidence
        legacyRejected = true;
      } else {
        evidence.push(...directMatch.evidence);
        return { disposition: 'reuse', evidence, legacyRejected };
      }
    }

    // 2. Check for agent coverage (reuse via agent)
    const agentMatch = this.findAgentCoverage(capabilityKey, agents);
    if (agentMatch) {
      evidence.push(...agentMatch);
      return { disposition: 'reuse', evidence, legacyRejected };
    }

    // 3. Check for composition (multiple skills combining)
    const compositionMatch = this.findCompositionMatch(capabilityKey, catalog, legacySkillIds);
    if (compositionMatch) {
      evidence.push(...compositionMatch);
      return { disposition: 'composition', evidence, legacyRejected };
    }

    // 4. Check for extension/generalization candidates
    const extensionMatch = this.findExtensionMatch(capabilityKey, catalog, legacySkillIds);
    if (extensionMatch) {
      evidence.push(...extensionMatch);
      return { disposition: 'extension', evidence, legacyRejected };
    }

    // 5. Catalog gap — no existing capability satisfies the need
    return { disposition: 'catalog_gap', evidence, legacyRejected };
  }

  /**
   * Search catalog for a direct match (enabled, installed, compatible skill).
   * Skips legacy-mapped skills and continues searching for valid matches.
   * Returns the first non-legacy match as reuse evidence, or reports the
   * legacy match if no valid alternative exists.
   */
  private findDirectCatalogMatch(
    capabilityKey: string,
    catalog: AuthoritativeSkillCatalogSnapshot,
    legacySkillIds: ReadonlySet<string>,
  ): { evidence: DispositionEvidence[]; isLegacy: boolean } | null {
    const normalizedKey = capabilityKey.toLowerCase();
    let legacyMatch: { evidence: DispositionEvidence[]; isLegacy: boolean } | null = null;

    for (const entry of catalog.entries) {
      if (!entry.enabled || !entry.installed) continue;

      const matchesCapability = entry.capabilityKeys.some(
        k => k.toLowerCase() === normalizedKey
      );

      if (matchesCapability) {
        const isLegacy = legacySkillIds.has(entry.skillId);
        if (!isLegacy) {
          // Found a valid non-legacy match — use it
          return {
            isLegacy: false,
            evidence: [{
              sourceKind: 'catalog_skill',
              sourceId: entry.skillId,
              reason: `Skill "${entry.name}" provides capability "${capabilityKey}" directly`,
              coverageLevel: 'full',
            }],
          };
        }
        // Record legacy match in case no valid alternative is found
        if (!legacyMatch) {
          legacyMatch = {
            isLegacy: true,
            evidence: [{
              sourceKind: 'catalog_skill',
              sourceId: entry.skillId,
              reason: `Skill "${entry.name}" provides capability "${capabilityKey}" directly (legacy mapping — rejected)`,
              coverageLevel: 'full',
            }],
          };
        }
      }
    }

    return legacyMatch;
  }

  /**
   * Search configured agents for capability coverage.
   */
  private findAgentCoverage(
    capabilityKey: string,
    agents: readonly ConfiguredAgent[],
  ): DispositionEvidence[] | null {
    const normalizedKey = capabilityKey.toLowerCase();

    for (const agent of agents) {
      if (!agent.enabled) continue;

      const matches = agent.capabilityKeys.some(
        k => k.toLowerCase() === normalizedKey
      );

      if (matches) {
        return [{
          sourceKind: 'agent_definition',
          sourceId: agent.agentId,
          reason: `Agent "${agent.name}" provides capability "${capabilityKey}"`,
          coverageLevel: 'full',
        }];
      }
    }

    return null;
  }

  /**
   * Search for skills that could be composed to cover a capability.
   * Composition requires at least two partial-coverage skills that together
   * provide full coverage.
   */
  private findCompositionMatch(
    capabilityKey: string,
    catalog: AuthoritativeSkillCatalogSnapshot,
    legacySkillIds: ReadonlySet<string>,
  ): DispositionEvidence[] | null {
    const normalizedKey = capabilityKey.toLowerCase();
    const partials: DispositionEvidence[] = [];

    for (const entry of catalog.entries) {
      if (!entry.enabled || !entry.installed) continue;
      if (legacySkillIds.has(entry.skillId)) continue;

      // Check if this skill partially covers the capability
      const partialMatch = entry.capabilityKeys.some(k => {
        const normalized = k.toLowerCase();
        return normalizedKey.includes(normalized) || normalized.includes(normalizedKey);
      });

      if (partialMatch) {
        partials.push({
          sourceKind: 'catalog_skill',
          sourceId: entry.skillId,
          reason: `Skill "${entry.name}" partially covers "${capabilityKey}"`,
          coverageLevel: 'partial',
        });
      }
    }

    // Composition requires at least two partial matches
    if (partials.length >= 2) {
      return partials;
    }

    return null;
  }

  /**
   * Search for skills that could be extended or generalized.
   * Extension candidates are skills in the same category or with
   * overlapping technology/deliverable keys.
   */
  private findExtensionMatch(
    capabilityKey: string,
    catalog: AuthoritativeSkillCatalogSnapshot,
    legacySkillIds: ReadonlySet<string>,
  ): DispositionEvidence[] | null {
    const normalizedKey = capabilityKey.toLowerCase();
    const candidates: DispositionEvidence[] = [];

    for (const entry of catalog.entries) {
      if (!entry.enabled || !entry.installed) continue;
      if (legacySkillIds.has(entry.skillId)) continue;

      // Check technology or deliverable overlap
      const techOverlap = entry.technologyKeys.some(t =>
        normalizedKey.includes(t.toLowerCase())
      );
      const deliverableOverlap = entry.deliverableKeys.some(d =>
        normalizedKey.includes(d.toLowerCase())
      );

      if (techOverlap || deliverableOverlap) {
        candidates.push({
          sourceKind: 'catalog_skill',
          sourceId: entry.skillId,
          reason: `Skill "${entry.name}" shares technology/deliverable context with "${capabilityKey}" and may be extended`,
          coverageLevel: 'partial',
        });
      }
    }

    // Return the first valid extension candidate
    if (candidates.length > 0) {
      return [candidates[0]!];
    }

    return null;
  }

  /**
   * Build the generation plan for identified catalog gaps.
   *
   * Requirement 41.4: Identify proposed assets, source assets, capability coverage,
   * triggers, exclusions, dependencies, expected tools, evaluation strategy, risks,
   * and predicted catalog changes.
   */
  private buildGenerationPlan(
    gaps: readonly AuditedCapability[],
    catalog: AuthoritativeSkillCatalogSnapshot,
  ): ProposedAsset[] {
    return gaps.map(gap => {
      const sourceAssets = this.findRelatedAssets(gap.capabilityKey, catalog);
      const catalogChanges: CatalogChangePreview[] = [{
        changeKind: 'add_skill',
        targetId: `generated:${gap.capabilityKey}`,
        description: `New skill for capability "${gap.displayName}"`,
      }];

      return {
        name: `${gap.displayName} Skill`,
        catalogGapKey: gap.capabilityKey,
        sourceAssets,
        capabilities: [gap.capabilityKey],
        triggers: [`task requires ${gap.capabilityKey}`],
        exclusions: [],
        requiredTools: [],
        evaluationStrategy: 'Positive trigger cases, near-miss negative cases, and baseline comparison',
        risks: ['New skill requires evaluation before activation'],
        catalogChanges,
      };
    });
  }

  /**
   * Find related catalog assets that may serve as sources for generation.
   */
  private findRelatedAssets(
    capabilityKey: string,
    catalog: AuthoritativeSkillCatalogSnapshot,
  ): string[] {
    const normalized = capabilityKey.toLowerCase();
    const related: string[] = [];

    for (const entry of catalog.entries) {
      if (!entry.enabled || !entry.installed) continue;

      const hasOverlap = [
        ...entry.capabilityKeys,
        ...entry.technologyKeys,
        ...entry.deliverableKeys,
      ].some(k => {
        const nk = k.toLowerCase();
        return normalized.includes(nk) || nk.includes(normalized);
      });

      if (hasOverlap) {
        related.push(entry.skillId);
      }
    }

    return related;
  }

  /**
   * Identify and document legacy keyword/startup mappings that are rejected.
   *
   * Requirement 41.8: SHALL NOT treat legacy keyword-only one-skill routing
   * or startup mappings as evidence of coverage.
   */
  private identifyRejectedLegacyMappings(
    legacyMappings: readonly LegacyMapping[],
  ): RejectedLegacyMapping[] {
    return legacyMappings.map(mapping => ({
      mappingId: mapping.mappingId,
      claimedCapability: mapping.keyword,
      rejectionReason: `Legacy ${mapping.source} mapping "${mapping.keyword}" → skill "${mapping.skillId}" bypasses authoritative validation and is not accepted as capability coverage evidence`,
    }));
  }

  /**
   * Persist the audit result as linked Evidence.
   *
   * Requirement 41.7: Persist audit inputs, snapshot fingerprints, gap decisions,
   * reviewer identity, approval outcome, and timestamps.
   */
  private persistEvidence(audit: CapabilityAuditResult): void {
    const evidence: AuditEvidenceRecord = {
      evidenceId: generateId(),
      auditId: audit.auditId,
      workspaceId: audit.workspaceId,
      inputFingerprints: audit.inputs,
      combinedInputFingerprint: audit.combinedInputFingerprint,
      gapDecisions: audit.catalogGaps,
      reviewerIdentity: null,
      approvalOutcome: null,
      createdAt: audit.createdAt,
      updatedAt: audit.updatedAt,
    };

    this.persistence.saveEvidence(evidence);
  }
}

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Compute a combined fingerprint from all input fingerprints.
 * A change to any input invalidates the entire audit.
 */
export function computeCombinedFingerprint(inputs: AuditInputSet): string {
  const hash = createHash('sha256');
  hash.update(inputs.requirements.fingerprint);
  hash.update(inputs.design.fingerprint);
  hash.update(inputs.tasks.fingerprint);
  hash.update(inputs.repositoryMap.fingerprint);
  hash.update(inputs.configuredAgents.fingerprint);
  hash.update(inputs.catalogSnapshot.fingerprint);
  return hash.digest('hex');
}

/**
 * Normalize a capability key for consistent matching.
 */
export function normalizeCapabilityKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a unique identifier for audit entities.
 */
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `audit-${timestamp}-${random}`;
}
