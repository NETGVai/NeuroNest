/**
 * Strangler Migration Module
 *
 * Provides compatibility adapters and shadow comparison infrastructure
 * for incremental migration from legacy timeline/session reducers to the
 * canonical Session_Log and Projection_Service architecture.
 *
 * Components:
 * - LegacySessionAdapter: reads legacy timeline inputs through a compatibility layer
 * - CanonicalEventWriter: writes durable mutations as canonical events + outbox records
 * - ShadowProjectionRunner: runs new projection beside the current reducer
 * - ParityDiagnostics: publishes redacted comparison diagnostics
 *
 * The migration does NOT change visible rendering. The legacy path remains
 * the authoritative source for display until parity is confirmed and the
 * legacy path is formally retired.
 *
 * Requirements: 1.3–1.5, 3.1–3.7, 29.5–29.8, 35.1–35.4
 */

export {
  LegacySessionAdapter,
  type LegacySessionAdapterConfig,
  type AdaptedEvent,
  type AdaptationStats,
} from './legacy-session-adapter.js';

export {
  CanonicalEventWriter,
  type CanonicalEventWriterConfig,
  type CanonicalWriteResult,
  type WriterStats,
} from './canonical-event-writer.js';

export {
  ShadowProjectionRunner,
  type ShadowProjectionRunnerConfig,
  type ParityComparisonResult,
  type ParityDivergence,
  type DivergenceKind,
} from './shadow-projection-runner.js';

export {
  ParityDiagnostics,
  type ParityDiagnosticsConfig,
  type ParityDiagnosticRecord,
  type RedactedDivergenceSummary,
  type ParityHealthReport,
  type MigrationPhase,
} from './parity-diagnostics.js';

export {
  ToolRowIslandAdapter,
  toolRowIsland,
  TurnStatusRowIslandAdapter,
  turnStatusRowIsland,
  RowIslandRegistry,
  rowIslandRegistry,
  type RowIslandDispatchInput,
  type RowIslandKind,
  type RowIslandOutput,
  type RowIsland,
  type ToolRowIslandInput,
  type TurnStatusRowIslandInput,
  type LegacyToolCardData,
  type LegacyTurnStatusData,
} from './row-islands/index.js';

export {
  ComposerGlobalsShim,
  type ComposerGlobalsShimConfig,
  type LegacyFileDescriptor,
  type SlashCommandDef,
  type SlashState,
  type HistoryEntry,
} from './composer-globals-shim.js';

export {
  KeyedWindowingAdapter,
  type KeyedWindowingAdapterConfig,
  type LegacyTimelineNode,
  type ReplacedBehavior,
  type KeyedRowState,
} from './keyed-windowing-adapter.js';

export {
  StreamingStateAdapter,
  type StreamingStateAdapterConfig,
  type StreamingAdapterStats,
  type StreamDelta,
  type StreamBlockKind,
  type DurablePartialOutputPayload,
  type TransientCacheKey,
  type TransientCacheEntry,
  type ProjectedPartialOutput,
} from './streaming-state-adapter.js';

export {
  RETIREMENT_MANIFEST,
  RetirementGate,
  DEFAULT_GATE_CONFIG,
  checkParityGate,
  checkAccessibilityGate,
  checkPerformanceGate,
  checkCompatibilityGate,
  evaluateGate,
  getEntriesByCategory,
  getEntriesByGate,
  getEntryById,
  getAllCategories,
  getAllEntryIds,
  type RetirementManifestEntry,
  type LegacyPathCategory,
  type GateConditionKind,
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
  type GateProviders,
} from './retirement/index.js';
