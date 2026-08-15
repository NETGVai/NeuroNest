/**
 * Capability Audit Types
 *
 * Type definitions for the project capability auditor that analyzes
 * requirements, design, tasks, repository map, configured agents,
 * and immutable catalog snapshots before proposing skill generation.
 *
 * Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8
 */

// ─── Capability Classification ───────────────────────────────────

/**
 * How an identified capability is satisfied.
 * - reuse: an existing agent/skill covers the need directly
 * - composition: multiple existing skills combine to cover the need
 * - extension: an existing skill can be extended/generalized
 * - catalog_gap: no existing compatible capability satisfies the need
 */
export type CapabilityDisposition =
  | 'reuse'
  | 'composition'
  | 'extension'
  | 'catalog_gap';

/**
 * Evidence supporting a capability disposition decision.
 */
export interface DispositionEvidence {
  /** The type of evidence source */
  readonly sourceKind: 'catalog_skill' | 'agent_definition' | 'taxonomy_mapping' | 'repository_asset';
  /** Stable identifier of the source asset */
  readonly sourceId: string;
  /** Human-readable description of why this source supports the disposition */
  readonly reason: string;
  /** Whether the source fully covers or partially covers the capability */
  readonly coverageLevel: 'full' | 'partial';
}

/**
 * A single capability identified during the audit, with its classification.
 */
export interface AuditedCapability {
  /** The canonical capability key */
  readonly capabilityKey: string;
  /** Human-readable name */
  readonly displayName: string;
  /** Where the capability was derived from (task, requirement, design) */
  readonly derivedFrom: CapabilitySource;
  /** How the capability should be satisfied */
  readonly disposition: CapabilityDisposition;
  /** Evidence supporting the disposition decision */
  readonly evidence: readonly DispositionEvidence[];
  /** Whether this was flagged as using a legacy keyword/startup mapping */
  readonly legacyMappingRejected: boolean;
}

/**
 * Source from which a capability need was derived.
 */
export interface CapabilitySource {
  readonly kind: 'requirement' | 'design_node' | 'task' | 'repository_map';
  readonly entityId: string;
  readonly description: string;
}

// ─── Audit Inputs ────────────────────────────────────────────────

/**
 * A fingerprinted input to the capability audit.
 * Any change to a fingerprint invalidates the current audit.
 */
export interface AuditInputFingerprint {
  readonly inputKind: AuditInputKind;
  readonly fingerprint: string;
  readonly timestamp: number;
}

export type AuditInputKind =
  | 'requirements'
  | 'design'
  | 'tasks'
  | 'repository_map'
  | 'configured_agents'
  | 'catalog_snapshot';

/**
 * Complete set of input fingerprints for an audit.
 */
export interface AuditInputSet {
  readonly requirements: AuditInputFingerprint;
  readonly design: AuditInputFingerprint;
  readonly tasks: AuditInputFingerprint;
  readonly repositoryMap: AuditInputFingerprint;
  readonly configuredAgents: AuditInputFingerprint;
  readonly catalogSnapshot: AuditInputFingerprint;
}

// ─── Generation Plan ─────────────────────────────────────────────

/**
 * A proposed asset in the generation plan.
 */
export interface ProposedAsset {
  /** Descriptive name for the proposed skill/agent */
  readonly name: string;
  /** The catalog gap this addresses */
  readonly catalogGapKey: string;
  /** Source assets being reused, composed, or extended */
  readonly sourceAssets: readonly string[];
  /** Capabilities this asset would cover */
  readonly capabilities: readonly string[];
  /** Proposed trigger patterns */
  readonly triggers: readonly string[];
  /** Proposed exclusion patterns */
  readonly exclusions: readonly string[];
  /** Tools the asset would require */
  readonly requiredTools: readonly string[];
  /** Evaluation strategy summary */
  readonly evaluationStrategy: string;
  /** Identified risks */
  readonly risks: readonly string[];
  /** Predicted catalog changes */
  readonly catalogChanges: readonly CatalogChangePreview[];
}

/**
 * Preview of a catalog change that the generation plan would produce.
 */
export interface CatalogChangePreview {
  readonly changeKind: 'add_skill' | 'update_skill' | 'add_relationship' | 'add_alias';
  readonly targetId: string;
  readonly description: string;
}

// ─── Audit Result and Plan ───────────────────────────────────────

/** Audit lifecycle state */
export type AuditState = 'analyzing' | 'pending_approval' | 'approved' | 'rejected' | 'stale';

/**
 * The complete result of a capability audit.
 */
export interface CapabilityAuditResult {
  /** Unique audit identifier */
  readonly auditId: string;
  /** Workspace this audit covers */
  readonly workspaceId: string;
  /** All input fingerprints at the time of the audit */
  readonly inputs: AuditInputSet;
  /** Combined fingerprint of all inputs (used for staleness detection) */
  readonly combinedInputFingerprint: string;
  /** Every capability identified and classified */
  readonly capabilities: readonly AuditedCapability[];
  /** Capabilities that map to catalog gaps */
  readonly catalogGaps: readonly AuditedCapability[];
  /** Capabilities satisfied by reuse/composition/extension */
  readonly satisfiedCapabilities: readonly AuditedCapability[];
  /** Legacy mappings that were rejected */
  readonly rejectedLegacyMappings: readonly RejectedLegacyMapping[];
  /** The proposed generation plan (empty if no gaps) */
  readonly generationPlan: readonly ProposedAsset[];
  /** Current state of this audit */
  readonly state: AuditState;
  /** Timestamp of audit creation */
  readonly createdAt: number;
  /** Timestamp of last state change */
  readonly updatedAt: number;
}

/**
 * A legacy keyword/startup mapping that was explicitly rejected.
 */
export interface RejectedLegacyMapping {
  /** The mapping source identifier */
  readonly mappingId: string;
  /** What the legacy mapping claimed to cover */
  readonly claimedCapability: string;
  /** Why it was rejected */
  readonly rejectionReason: string;
}

// ─── Approval Decision ───────────────────────────────────────────

/**
 * An approval or rejection decision on an audit and its generation plan.
 */
export interface AuditApprovalDecision {
  /** The audit being decided */
  readonly auditId: string;
  /** Whether the plan is approved for execution */
  readonly approved: boolean;
  /** Identity of the reviewer making the decision */
  readonly reviewerIdentity: string;
  /** Reason for the decision */
  readonly reason: string;
  /** Timestamp of the decision */
  readonly decidedAt: number;
}

// ─── Evidence Record ─────────────────────────────────────────────

/**
 * A persisted evidence record for the audit.
 * Links the audit to the project and planned assets.
 */
export interface AuditEvidenceRecord {
  /** Evidence envelope id */
  readonly evidenceId: string;
  /** The audit this evidence is for */
  readonly auditId: string;
  /** Workspace id */
  readonly workspaceId: string;
  /** Input snapshot fingerprints at evidence creation */
  readonly inputFingerprints: AuditInputSet;
  /** The combined fingerprint */
  readonly combinedInputFingerprint: string;
  /** Capability gap decisions */
  readonly gapDecisions: readonly AuditedCapability[];
  /** Reviewer identity (null if not yet approved) */
  readonly reviewerIdentity: string | null;
  /** Approval outcome (null if not yet decided) */
  readonly approvalOutcome: boolean | null;
  /** Timestamp when evidence was created */
  readonly createdAt: number;
  /** Timestamp of the last update */
  readonly updatedAt: number;
}
