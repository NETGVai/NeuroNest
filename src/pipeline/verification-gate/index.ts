/**
 * Verification Gate — multi-stage pipeline for validating agent-generated edits.
 *
 * Stage sequence: syntax → typecheck → lint → security → over-engineering-review → test-gap → test → gui-acceptance → smoke → before-merge
 * Scores: syntax=1, typecheck=2, lint=3, security=3, over-engineering-review=2, test-gap=3, test=4, gui-acceptance=4, smoke=5, before-merge=5 (max=32)
 *
 * Features:
 * - Sequential execution stopping at first failure
 * - 30-second total pipeline timeout for edits affecting <10 files
 * - Dependency-graph-based test selection (run only affected tests)
 * - Sandbox smoke-run with no network access and 10s timeout
 * - Exact line/column reporting for Tree-Sitter syntax errors
 * - GUI acceptance stage gated by `gui_acceptance` feature flag
 * - Before-merge gateway stage gated by `before_merge_gateway` feature flag
 */

export type {
  StageName,
  Diagnostic,
  StageResult,
  VerificationResult,
  FileChange,
  AgentEdit,
  ProjectContext,
  DependencyGraph,
  VerificationStage,
  VerificationPipelineConfig,
  VerificationPipeline,
} from './types';

export { STAGE_SCORES, STAGE_ORDER, MAX_SCORE } from './types';

export { VerificationGatePipeline, createVerificationPipeline, PipelineTimeoutError } from './pipeline';

export { SyntaxStage, DefaultTreeSitterParser } from './stages/syntax-stage';
export type { TreeSitterParser, ParseResult, SyntaxError } from './stages/syntax-stage';

export { TypecheckStage, DefaultTypeCheckRunner } from './stages/typecheck-stage';
export type { TypeCheckRunner } from './stages/typecheck-stage';

export { LintStage, DefaultLintRunner } from './stages/lint-stage';
export type { LintRunner } from './stages/lint-stage';

export { TestStage, DefaultTestRunner, selectAffectedTests } from './stages/test-stage';
export type { TestRunner, TestRunResult, FailedTest } from './stages/test-stage';

export { SmokeStage, DefaultSandboxRunner } from './stages/smoke-stage';
export type { SandboxRunner, SandboxConfig, SandboxRunResult } from './stages/smoke-stage';

export { SecurityStage } from './stages/security-stage';
export type { SecurityStageDeps, SecurityStageCallbackEngine, SecurityStageFirewallEngine } from './stages/security-stage';

export { OverEngineeringReviewStage } from '../over-engineering-review';
export type { BloatFinding, BloatTag, OverEngineeringReviewResult } from '../over-engineering-review';
export { OverEngineeringReview } from '../over-engineering-review';

export { TestGapDetectorStage } from './stages/test-gap-stage';
export type {
  UncoveredExport,
  GeneratedTest,
  TestGapResult,
  ExportType,
  RiskLevel,
  TestTemplate,
  DockerSandboxRunner,
  FeatureFlagChecker,
} from './stages/test-gap-stage';
export {
  extractExports,
  deriveTestFilePaths,
  isExportTested,
  isPureFunction,
  assessRisk,
  generatePropertyBasedTest,
  generateExampleBasedTest,
  DefaultDockerSandboxRunner,
  DefaultFeatureFlagChecker,
} from './stages/test-gap-stage';

export { GUIAcceptanceStage } from './stages/gui-acceptance-stage';

export { BeforeMergeStage } from './stages/before-merge-stage';
