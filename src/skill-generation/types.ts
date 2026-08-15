/**
 * Skill Generation Types
 *
 * Type definitions for the schema-driven skill generation pipeline
 * that stages Generated_Skill_Candidates without activation.
 *
 * Requirements: 42.1, 42.2, 42.3, 42.4, 42.5, 42.6, 42.7, 42.8
 */

// ─── Candidate Identity ──────────────────────────────────────────

/**
 * Stable identity for a Generated_Skill_Candidate.
 */
export interface CandidateIdentity {
  /** Unique candidate ID (generated at creation) */
  readonly candidateId: string;
  /** Human-readable name */
  readonly name: string;
  /** Semantic version for the candidate */
  readonly version: string;
  /** The catalog gap this candidate addresses */
  readonly catalogGapKey: string;
  /** Linked audit decision ID that approved generation */
  readonly auditDecisionId: string;
}

// ─── Candidate Manifest ──────────────────────────────────────────

/**
 * A complete versioned manifest for a Generated_Skill_Candidate.
 *
 * Requirement 42.3: EVERY candidate SHALL have a versioned manifest
 * containing all required fields.
 */
export interface CandidateManifest {
  /** Candidate identity */
  readonly identity: CandidateIdentity;
  /** Trigger patterns that activate this skill */
  readonly triggers: readonly TriggerPattern[];
  /** Exclusion patterns that prevent activation */
  readonly exclusions: readonly ExclusionPattern[];
  /** Declared inputs consumed by the skill */
  readonly inputs: readonly SkillInput[];
  /** Declared outputs produced by the skill */
  readonly outputs: readonly SkillOutput[];
  /** Capability keys this skill covers */
  readonly capabilities: readonly string[];
  /** Tools required by this skill */
  readonly tools: readonly ToolDeclaration[];
  /** Permissions required */
  readonly permissions: readonly PermissionDeclaration[];
  /** Referenced assets (Level 3 references, scripts) */
  readonly assets: readonly AssetReference[];
  /** Test fixtures for validation */
  readonly tests: readonly TestFixture[];
  /** Compatibility constraints */
  readonly compatibility: CompatibilityConstraints;
  /** Transformation provenance linking to source */
  readonly provenance: TransformationProvenance;
  /** Content fingerprints */
  readonly fingerprints: CandidateFingerprints;
}

// ─── Trigger and Exclusion Patterns ──────────────────────────────

export interface TriggerPattern {
  /** Pattern identifier */
  readonly patternId: string;
  /** Human-readable description */
  readonly description: string;
  /** Pattern matching rule */
  readonly rule: string;
  /** Pattern type */
  readonly type: 'task_type' | 'capability_match' | 'context_match' | 'explicit_assignment';
}

export interface ExclusionPattern {
  /** Pattern identifier */
  readonly patternId: string;
  /** Human-readable description */
  readonly description: string;
  /** Pattern matching rule */
  readonly rule: string;
  /** Pattern type */
  readonly type: 'conflict' | 'scope_mismatch' | 'capability_overlap' | 'explicit_exclusion';
}

// ─── Inputs and Outputs ──────────────────────────────────────────

export interface SkillInput {
  /** Input name */
  readonly name: string;
  /** Expected type/schema */
  readonly schema: string;
  /** Whether this input is required */
  readonly required: boolean;
  /** Description */
  readonly description: string;
}

export interface SkillOutput {
  /** Output name */
  readonly name: string;
  /** Produced type/schema */
  readonly schema: string;
  /** Description */
  readonly description: string;
}

// ─── Tools and Permissions ───────────────────────────────────────

export interface ToolDeclaration {
  /** Tool identifier */
  readonly toolId: string;
  /** Tool name */
  readonly name: string;
  /** Whether this tool is required or optional */
  readonly required: boolean;
  /** Usage description */
  readonly purpose: string;
}

export interface PermissionDeclaration {
  /** Permission scope */
  readonly scope: 'filesystem' | 'network' | 'shell' | 'git' | 'external_service';
  /** Permission level */
  readonly level: 'read' | 'write' | 'execute';
  /** Resource pattern */
  readonly resource: string;
  /** Justification */
  readonly justification: string;
}

// ─── Assets ──────────────────────────────────────────────────────

export interface AssetReference {
  /** Asset identifier */
  readonly assetId: string;
  /** Asset type */
  readonly type: 'reference' | 'script' | 'template' | 'example';
  /** Relative path within the candidate staging area */
  readonly path: string;
  /** Content fingerprint */
  readonly fingerprint: string;
  /** Whether this is inherited from a source skill or newly generated */
  readonly origin: 'inherited' | 'generated';
}

// ─── Tests ───────────────────────────────────────────────────────

export interface TestFixture {
  /** Test identifier */
  readonly testId: string;
  /** Test type */
  readonly type: 'trigger_positive' | 'trigger_negative' | 'behavior' | 'safety';
  /** Test description */
  readonly description: string;
  /** Expected outcome */
  readonly expectedOutcome: 'activate' | 'no_activate' | 'pass' | 'fail';
  /** Test input data */
  readonly input: Record<string, unknown>;
}

// ─── Compatibility ───────────────────────────────────────────────

export interface CompatibilityConstraints {
  /** Minimum platform version */
  readonly minPlatformVersion: string;
  /** Maximum platform version (null = no upper bound) */
  readonly maxPlatformVersion: string | null;
  /** Required catalog features */
  readonly requiredFeatures: readonly string[];
  /** Incompatible skill IDs */
  readonly incompatibleSkills: readonly string[];
}

// ─── Provenance ──────────────────────────────────────────────────

/**
 * Transformation provenance for a generated skill.
 *
 * Requirement 42.4: Preserve source asset identities and versions,
 * distinguish inherited from generated content, and record fingerprints.
 */
export interface TransformationProvenance {
  /** Source asset identifiers that contributed to this candidate */
  readonly sourceAssets: readonly SourceAssetRecord[];
  /** Generation method used */
  readonly generationMethod: 'reuse_extension' | 'composition' | 'generalization' | 'novel';
  /** Generator version */
  readonly generatorVersion: string;
  /** Timestamp of generation */
  readonly generatedAt: number;
  /** Distinguishes inherited vs generated content sections */
  readonly contentOrigins: readonly ContentOrigin[];
}

export interface SourceAssetRecord {
  /** Source skill/asset ID */
  readonly sourceId: string;
  /** Source version at generation time */
  readonly sourceVersion: string;
  /** How this source was used */
  readonly usage: 'reused' | 'composed' | 'extended' | 'generalized' | 'reference_only';
  /** Source content fingerprint at time of use */
  readonly sourceFingerprint: string;
}

export interface ContentOrigin {
  /** Section/region identifier */
  readonly section: string;
  /** Whether this section is inherited or generated */
  readonly origin: 'inherited' | 'generated';
  /** Source asset ID if inherited */
  readonly sourceId?: string;
}

// ─── Fingerprints ────────────────────────────────────────────────

/**
 * Requirement 42.4: Record canonical content and manifest fingerprints.
 */
export interface CandidateFingerprints {
  /** Fingerprint of the full manifest (excluding this field) */
  readonly manifestFingerprint: string;
  /** Fingerprint of the skill content/body */
  readonly contentFingerprint: string;
  /** Combined fingerprint */
  readonly combinedFingerprint: string;
  /** Inherited fingerprints from source assets */
  readonly inheritedFingerprints: readonly string[];
  /** Fingerprint of newly generated content only */
  readonly generatedFingerprint: string;
}

// ─── Staging State ───────────────────────────────────────────────

/**
 * Lifecycle state of a Generated_Skill_Candidate in staging.
 */
export type CandidateState =
  | 'created'
  | 'schema_validated'
  | 'references_resolved'
  | 'permissions_validated'
  | 'triggers_validated'
  | 'behavior_tested'
  | 'approval_pending'
  | 'approved'
  | 'published'
  | 'rolled_back'
  | 'failed';

/**
 * A staged candidate with its full lifecycle state.
 */
export interface StagedCandidate {
  /** The candidate manifest */
  readonly manifest: CandidateManifest;
  /** Current lifecycle state */
  readonly state: CandidateState;
  /** Validation results from each gate */
  readonly validationResults: readonly ValidationResult[];
  /** Semantic diff summary for approval */
  readonly semanticDiff: SemanticDiff | null;
  /** Timestamp of creation */
  readonly createdAt: number;
  /** Timestamp of last state change */
  readonly updatedAt: number;
  /** Error details if failed or rolled back */
  readonly error: string | null;
}

// ─── Validation ──────────────────────────────────────────────────

export interface ValidationResult {
  /** What was validated */
  readonly gate: ValidationGate;
  /** Whether validation passed */
  readonly passed: boolean;
  /** Validation details */
  readonly details: string;
  /** Timestamp */
  readonly validatedAt: number;
}

export type ValidationGate =
  | 'schema'
  | 'references'
  | 'scripts'
  | 'permissions'
  | 'triggers'
  | 'behavior'
  | 'safety'
  | 'provenance'
  | 'duplicates';

// ─── Semantic Diff ───────────────────────────────────────────────

/**
 * Requirement 42.7: Show a semantic diff of reused, generalized,
 * and newly generated material.
 */
export interface SemanticDiff {
  /** Sections reused from existing skills */
  readonly reusedSections: readonly DiffSection[];
  /** Sections generalized/extended from existing skills */
  readonly generalizedSections: readonly DiffSection[];
  /** Entirely new generated sections */
  readonly generatedSections: readonly DiffSection[];
  /** Summary of changes */
  readonly summary: string;
}

export interface DiffSection {
  /** Section name/path */
  readonly section: string;
  /** Source asset if applicable */
  readonly sourceId?: string;
  /** Brief description of what changed */
  readonly description: string;
}

// ─── Catalog Publication ─────────────────────────────────────────

/**
 * Requirement 42.8: Create a new immutable catalog version
 * without rewriting history.
 */
export interface CatalogPublicationResult {
  /** New catalog version created */
  readonly catalogVersion: number;
  /** Skill ID in the catalog */
  readonly publishedSkillId: string;
  /** Whether publication succeeded */
  readonly success: boolean;
  /** Error if failed */
  readonly error?: string;
  /** Fingerprint of the new catalog state */
  readonly catalogFingerprint: string;
}

// ─── Approval ────────────────────────────────────────────────────

export interface CandidateApproval {
  /** Candidate ID */
  readonly candidateId: string;
  /** Reviewer identity */
  readonly reviewerIdentity: string;
  /** Whether approved */
  readonly approved: boolean;
  /** Reason/notes */
  readonly reason: string;
  /** Timestamp */
  readonly decidedAt: number;
}

// ─── Search Result ───────────────────────────────────────────────

export interface ExistingSkillMatch {
  /** Matched skill ID */
  readonly skillId: string;
  /** Matched skill name */
  readonly name: string;
  /** How the skill can be used */
  readonly matchType: 'reuse' | 'compose' | 'extend' | 'generalize';
  /** Confidence score (0-1) */
  readonly confidence: number;
  /** Reason for match */
  readonly reason: string;
}
