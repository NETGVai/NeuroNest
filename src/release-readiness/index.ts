/**
 * Release readiness module — generates authoritative Production_Readiness_Reports
 * for Release_Candidates using revision-bound Evidence, staleness detection,
 * waiver enforcement, documentation validation, and shortest-path readiness projection.
 *
 * Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.8, 40.9, 40.10, 40.11
 */

export * from './types';
export {
  ReleaseReadinessService,
  StaleEvidenceError,
  MandatoryGateBlockedError,
  InvalidWaiverError,
  ALL_GATE_CATEGORIES,
  MANDATORY_CATEGORIES,
  type EvidenceProvider,
  type PlanningProvider,
  type RequirementCoverage,
  type TaskCoverage,
  type DesignDecisionStatus,
  type DocumentationValidator,
  type DocumentationProvider,
} from './release-readiness-service';
