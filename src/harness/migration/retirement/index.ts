/**
 * Retirement Module
 *
 * Provides automated gates that must pass before legacy mutation and
 * DOM-global paths can be removed. The module includes:
 *
 * - RetirementManifest: catalogs each legacy path with its replacement
 * - RetirementGate: enforces parity, accessibility, performance, and
 *   compatibility checks before allowing legacy path removal
 * - Gate check implementations for each condition type
 * - Types and interfaces for gate configuration and results
 *
 * The actual removal is gated — this module creates the gates and the
 * manifest, not the mass deletion itself.
 *
 * Requirements: 1.1–1.6, 13.8, 35.12–35.13, 45.15, 47.13, 47.19
 */

export {
  RETIREMENT_MANIFEST,
  getEntriesByCategory,
  getEntriesByGate,
  getEntryById,
  getAllCategories,
  getAllEntryIds,
  type RetirementManifestEntry,
  type LegacyPathCategory,
  type GateConditionKind,
} from './retirement-manifest.js';

export {
  type GateCheckResult,
  type GateEvidence,
  type RetirementGateConfig,
  type ParityGateConfig,
  type AccessibilityGateConfig,
  type PerformanceGateConfig,
  type CompatibilityGateConfig,
  type ParityCheckProvider,
  type AccessibilityCheckProvider,
  type PerformanceCheckProvider,
  type CompatibilityCheckProvider,
  type AccessibilityViolation,
  type CompatibilityIssue,
  type PathRetirementEvaluation,
  type RetirementReport,
} from './retirement-gate-types.js';

export {
  RetirementGate,
  DEFAULT_GATE_CONFIG,
  checkParityGate,
  checkAccessibilityGate,
  checkPerformanceGate,
  checkCompatibilityGate,
  evaluateGate,
  type GateProviders,
} from './retirement-gate.js';
