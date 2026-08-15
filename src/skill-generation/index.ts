/**
 * Skill Generation Module
 *
 * Schema-driven skill generation pipeline that stages Generated_Skill_Candidates
 * without activation. Searches existing skills for reuse opportunities, creates
 * versioned inactive manifests, validates through multiple gates, and publishes
 * as immutable catalog versions.
 *
 * Requirements: 42.1, 42.2, 42.3, 42.4, 42.5, 42.6, 42.7, 42.8
 */

export { SkillGenerator } from './skill-generator.js';

export type {
  AuditDecisionSource,
  ApprovedAuditDecision,
  CandidatePersistence,
  CatalogPublisher,
  SkillGeneratorConfig,
  SkillRepository,
  SkillRepositoryEntry,
} from './skill-generator.js';

export type {
  AssetReference,
  CandidateApproval,
  CandidateFingerprints,
  CandidateIdentity,
  CandidateManifest,
  CandidateState,
  CatalogPublicationResult,
  CompatibilityConstraints,
  ContentOrigin,
  DiffSection,
  ExclusionPattern,
  ExistingSkillMatch,
  PermissionDeclaration,
  SemanticDiff,
  SkillInput,
  SkillOutput,
  SourceAssetRecord,
  StagedCandidate,
  TestFixture,
  ToolDeclaration,
  TransformationProvenance,
  TriggerPattern,
  ValidationGate,
  ValidationResult,
} from './types.js';
