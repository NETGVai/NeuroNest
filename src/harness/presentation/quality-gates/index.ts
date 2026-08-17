/**
 * UI Quality Gates
 *
 * Automated build/test gate that blocks publication of affected
 * Chat_Interface revisions on critical accessibility, stable-identity,
 * bounded-mount, durable-equivalence, lazy-cancellation, anchor, or
 * configured performance failures.
 *
 * Requirements: 46.13, 46.17, 47.13, 47.19
 */

export {
  UIQualityGate,
  DEFAULT_UI_QUALITY_GATE_CONFIG,
  checkAccessibilityQualityGate,
  checkStableIdentityGate,
  checkBoundedMountGate,
  checkDurableEquivalenceGate,
  checkLazyCancellationGate,
  checkAnchorGate,
  checkPerformanceQualityGate,
  evaluateUIQualityGate,
} from './ui-quality-gate.js';

export type {
  UIQualityGateKind,
  UIQualityGateResult,
  UIQualityGateConfig,
  UIQualityGateProviders,
  QualityGateEvidence,
  QualityGateViolation,
  ViolationSeverity,
  PublicationDecision,
  AccessibilityQualityConfig,
  StableIdentityQualityConfig,
  BoundedMountQualityConfig,
  DurableEquivalenceQualityConfig,
  LazyCancellationQualityConfig,
  AnchorQualityConfig,
  PerformanceQualityConfig,
  AccessibilityQualityCheckProvider,
  StableIdentityCheckProvider,
  BoundedMountCheckProvider,
  DurableEquivalenceCheckProvider,
  LazyCancellationCheckProvider,
  AnchorCheckProvider,
  PerformanceQualityCheckProvider,
} from './quality-gate-types.js';
