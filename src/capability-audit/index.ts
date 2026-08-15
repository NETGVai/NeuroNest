/**
 * Capability Audit Module
 *
 * Project capability auditing and reuse-first generation planning.
 * Analyzes workspace inputs, maps capabilities to existing catalog assets,
 * identifies gaps, rejects legacy mappings, and produces approved generation plans.
 *
 * Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8
 */

export {
  CapabilityAuditor,
  computeCombinedFingerprint,
  normalizeCapabilityKey,
} from './capability-auditor.js';

export type {
  AuditInputProvider,
  AuditPersistence,
  ConfiguredAgent,
  LegacyMapping,
} from './capability-auditor.js';

export type {
  AuditedCapability,
  AuditEvidenceRecord,
  AuditInputFingerprint,
  AuditInputKind,
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
