/**
 * Attribution module — source-bearing privacy, truthful reliability,
 * and always-on attribution for the editor-chat-enhancement.
 *
 * Requirements: 25.7, 25.8, 25.9, 25.10, 25.12, 26.1, 26.2, 26.3, 26.4, 26.5,
 *              26.6, 26.7, 26.8, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7
 */

export { AttributionService } from './attribution-service';
export { ReliabilityService } from './reliability-service';
export { PrivacyReliabilityIntegration } from './privacy-reliability-integration';
export type {
  AccuracyQualifier,
  Attribution,
  AttributedClaim,
  ProvenanceStatus,
  ReliabilityClass,
  SourceProvenance,
  VerificationEvidence,
} from './types';
export type {
  ActorAttribution,
  AuthoritativeSource,
  AuthoritativeStatusSnapshot,
  DiagnosticExport,
  ExportRedactionPolicy,
  FailureClass,
  FailurePhase,
  IncompleteTransaction,
  MigrationDefaults,
  RetryAttempt,
  SanitizationResult,
  SessionInspectionRecord,
  SourceFreeMetric,
  StructuredFailure,
  TraceRetentionConfig,
} from './privacy-reliability-integration';
