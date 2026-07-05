// ─── Loop Engine Entry Point ────────────────────────────────────
// Public API surface for the Loop Engine subsystem.
// Re-exports from all submodules and provides a factory function
// that wires all components together with full dependency injection.
//
// Requirements: 6.1, 6.5, 15.1

// ─── Core Types ─────────────────────────────────────────────────

export type LoopState =
  | 'IDLE'
  | 'PLANNING_PASS'
  | 'EXECUTING_PASS'
  | 'VERIFYING'
  | 'APPLYING_FEEDBACK'
  | 'SUCCEEDED'
  | 'NO_OP'
  | 'AWAITING_APPROVAL'
  | 'BLOCKED'
  | 'LIMIT_EXHAUSTED'
  | 'STALLED';

export type TerminalState = 'SUCCEEDED' | 'NO_OP' | 'BLOCKED' | 'LIMIT_EXHAUSTED' | 'STALLED';

// ─── Verify Check Types ─────────────────────────────────────────

export interface VerifyCheckCommand {
  type: 'command';
  command: string;
  expectedExitCode: number;
}

export interface VerifyCheckMetric {
  type: 'metric';
  metricName: string;
  comparator: 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
  target: number;
}

export interface VerifyCheckFile {
  type: 'file';
  filePath: string;
  assertion: 'exists' | 'validJson' | 'nonEmpty';
}

export interface VerifyCheckLlmJudge {
  type: 'llmJudge';
  rubric: string;
  threshold: number;
}

export type VerifyCheck =
  | VerifyCheckCommand
  | VerifyCheckMetric
  | VerifyCheckFile
  | VerifyCheckLlmJudge;

// ─── Stop Conditions ────────────────────────────────────────────

export interface StopConditions {
  maxPasses: number;
  maxCostUsd: number;
  maxWallClockMin: number;
  noProgressPasses: number;
  approvalBoundaries: number[];
}

// ─── Scope Constraints ──────────────────────────────────────────

export type SecurityPolicy = 'standard' | 'strict' | 'enterprise';

export interface ScopeConstraints {
  allowedPaths: string[];
  allowedTools: string[];
  securityPolicy: SecurityPolicy;
}

// ─── LoopSpec ───────────────────────────────────────────────────

export interface LoopSpec {
  id: string;
  version: string;
  name: string;
  useWhen: string;
  goal: string;
  passAction: string;
  verify: VerifyCheck[];
  feedback: string;
  stop: StopConditions;
  scope: ScopeConstraints;
  notes?: string;
  source: string;
  catalogRef?: string;
}

// ─── Loop Run Context ───────────────────────────────────────────

export interface LoopRunContext {
  runId: string;
  spec: LoopSpec;
  sessionId: string;
  passesCompleted: number;
  cumulativeCostUsd: number;
  startedAt: Date;
  progressHashes: string[];
  verifyPassCounts: number[];
}

// ─── Pass Result ────────────────────────────────────────────────

export interface VerifyResult {
  checkId: string;
  passed: boolean;
  output: string;
}

export interface PassEvidence {
  type: 'file' | 'inline';
  ref: string;
}

export interface PassResult {
  passNumber: number;
  actionSummary: string;
  toolsUsed: string[];
  verifyResults: VerifyResult[];
  evidence: PassEvidence[];
  costUsd: number;
  securityScanId?: string;
  progressHash: string;
  startedAt: string;
  endedAt: string;
}

// ─── Loop Receipt ───────────────────────────────────────────────

export interface LoopReceipt {
  specId: string;
  specVersion: string;
  passes: PassResult[];
  totalCostUsd: number;
  totalPasses: number;
  finalStatus: TerminalState;
  stopReason: string;
  startedAt: string;
  endedAt: string;
}

// ─── Loop Runner Dependencies ───────────────────────────────────

export interface SwarmCoordinatorLike {
  execute(task: string, sessionId: string): Promise<unknown>;
}

export interface FirewallEngineLike {
  inspect(content: string): Promise<{ blocked: boolean; reason?: string }>;
}

export interface ActionAnalyzerLike {
  classify(action: string): Promise<{ risk: 'LOW' | 'MEDIUM' | 'HIGH' }>;
}

export interface EditLockManagerLike {
  setAllowedPaths(paths: string[]): void;
  checkPath(path: string): boolean;
}

export interface EventBusLike {
  publish(topic: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CheckpointServiceLike {
  save(key: string, state: unknown): Promise<void>;
  restore(key: string): Promise<unknown | null>;
}

export interface CostTrackingServiceLike {
  addCost(sessionId: string, costUsd: number): void;
  getCumulativeCost(sessionId: string): number;
  isBudgetExceeded(sessionId: string): boolean;
}

export interface PermissionPatternEngineLike {
  evaluate(toolName: string, args: string): 'allow' | 'deny' | 'no-match';
}

export interface VerifierSubagentLike {
  verify(input: {
    goalMd: string;
    diff: string;
    testOutput: string;
    lintOutput: string;
  }): Promise<{
    passes: boolean;
    failures: Array<{ line: number; reason: string }>;
    shortcutsDetected: Array<{ id: string; line?: number; reason: string }>;
    contextTokensUsed: number;
  }>;
}

export interface HookEngineLike {
  evaluatePreToolUse(toolName: string, args: string): Promise<string | null>;
  executePostToolUse(toolName: string, args: string): Promise<unknown[]>;
  executeStopHooks(): Promise<unknown[]>;
}

export interface ContextBudgetEnforcerLike {
  assembleBudgetedContext(
    neuronestMd: string,
    goalMd: string,
    planMd: string,
    memoryContent: string,
  ): {
    neuronestMd: string;
    goalMd: string;
    planMd: string;
    memoryContent: string;
    totalTokens: number;
    truncated: boolean;
    truncationLog: string[];
  };
}

export interface GoalMdContentLike {
  goal: string;
  doneWhen: Array<{ command: string; expectedExitCode: number }>;
  neverTouch: string[];
  stopIf: string[];
}

export interface PlanStepLike {
  id: number;
  description: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed';
  triedHistory: string[];
  next?: string;
}

export interface PlanMdContentLike {
  steps: PlanStepLike[];
  status: 'active' | 'done' | 'blocked';
}

export interface GoalPlanManagerLike {
  initialize(spec: LoopSpec): Promise<void>;
  readGoal(): Promise<GoalMdContentLike>;
  readPlan(): Promise<PlanMdContentLike>;
  updatePlan(updates: {
    steps?: Array<Partial<PlanStepLike> & { id: number }>;
    status?: 'active' | 'done' | 'blocked';
  }): Promise<void>;
  evaluateStopIf(goalMd: GoalMdContentLike): string | null;
  compileNeverTouch(neverTouch: string[]): string[];
}

export interface ProgressHasherLike {
  compute(input: {
    planMdStepStatuses: string;
    verifierVerdict: string;
    touchedFilesHash: string;
  }): string;
  computeTreeHash(paths: string[]): Promise<string>;
}

export interface LoopStorageLike {
  saveSpec(spec: LoopSpec): Promise<void>;
  getSpec(id: string): Promise<unknown | null>;
  listSpecs(): Promise<unknown[]>;
  deleteSpec(id: string): Promise<boolean>;
  createRun(run: unknown): Promise<void>;
  updateRun(id: string, updates: unknown): Promise<void>;
  getRun(id: string): Promise<unknown | null>;
  getRunningRuns(): Promise<unknown[]>;
  createPass(pass: unknown): Promise<void>;
  updatePass(id: string, updates: unknown): Promise<void>;
  getPassesForRun(runId: string): Promise<unknown[]>;
  deleteIncompletePass(runId: string, passNumber: number): Promise<void>;
  writeReceipt(runId: string, receiptJson: string): Promise<void>;
  getReceipt(runId: string): Promise<string | null>;
}

export interface LoopRunnerDeps {
  swarmCoordinator: SwarmCoordinatorLike;
  firewallEngine: FirewallEngineLike;
  actionAnalyzer: ActionAnalyzerLike;
  editLockManager: EditLockManagerLike;
  eventBus: EventBusLike;
  checkpointService: CheckpointServiceLike;
  costTracker: CostTrackingServiceLike;
  permissionPatternEngine: PermissionPatternEngineLike;
  verifierSubagent: VerifierSubagentLike;
  hookEngine: HookEngineLike;
  contextBudgetEnforcer: ContextBudgetEnforcerLike;
  goalPlanManager: GoalPlanManagerLike;
  progressHasher: ProgressHasherLike;
  loopStorage: LoopStorageLike;
}

// ─── Valid State Transitions ────────────────────────────────────

export const VALID_TRANSITIONS: Record<LoopState, LoopState[]> = {
  IDLE: ['PLANNING_PASS'],
  PLANNING_PASS: ['EXECUTING_PASS', 'AWAITING_APPROVAL', 'BLOCKED', 'LIMIT_EXHAUSTED'],
  EXECUTING_PASS: ['VERIFYING', 'AWAITING_APPROVAL', 'BLOCKED', 'NO_OP'],
  VERIFYING: ['SUCCEEDED', 'APPLYING_FEEDBACK', 'AWAITING_APPROVAL', 'BLOCKED', 'STALLED'],
  APPLYING_FEEDBACK: ['PLANNING_PASS', 'BLOCKED'],
  AWAITING_APPROVAL: ['PLANNING_PASS', 'SUCCEEDED', 'LIMIT_EXHAUSTED', 'BLOCKED'],
  SUCCEEDED: [],
  NO_OP: [],
  BLOCKED: [],
  LIMIT_EXHAUSTED: [],
  STALLED: [],
};

// ─── Debrief Types ──────────────────────────────────────────────

export type FailureClassification =
  | 'loop-design'
  | 'execution-tool-failure'
  | 'environment-problem'
  | 'goal-ambiguity';

export type Confidence = 'high' | 'medium' | 'low';

export interface DebriefResult {
  classification: FailureClassification;
  confidence: Confidence;
  recommendation: {
    section: 'goal' | 'verify' | 'feedback' | 'stop' | 'scope';
    changes: string;
    fieldCount: number;
  };
  evidenceSummary: string;
}

// ─── Doctor Types ───────────────────────────────────────────────

export interface DoctorFinding {
  severity: 'error' | 'warning';
  field: string;
  message: string;
  repair?: Partial<LoopSpec>;
}

// ─── Storage Row Types ──────────────────────────────────────────

export interface LoopSpecRow {
  id: string;
  version: string;
  json: string;
  source: string;
  catalog_ref: string | null;
  created_at: string;
}

export interface LoopRunRow {
  id: string;
  spec_id: string;
  spec_version: string;
  session_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stop_reason: string | null;
  passes_completed: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  receipt_json: string | null;
}

export interface LoopPassRow {
  id: string;
  run_id: string;
  pass_number: number;
  action_summary: string | null;
  verify_results_json: string | null;
  evidence_json: string | null;
  cost_usd: number;
  security_scan_id: string | null;
  started_at: string;
  ended_at: string | null;
}

// ─── Catalog Types ──────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  version: string;
  name: string;
  spec: unknown;
}

// ─── Scheduler Types ────────────────────────────────────────────

export type SchedulerPlatform = 'macos' | 'linux' | 'windows';

export interface ScheduleConfig {
  specId: string;
  intervalMinutes: number;
  goalMdVersion: string;
  messagingChannel?: { type: 'slack' | 'telegram'; webhookUrl: string };
}

// ═══════════════════════════════════════════════════════════════════
// Re-exports from submodules
// ═══════════════════════════════════════════════════════════════════

// ─── Schema ─────────────────────────────────────────────────────
export {
  VerifyCheckSchema,
  StopSchema,
  ScopeSchema,
  LoopSpecSchema,
  validateLoopSpec,
} from './schema/loop-spec';

// ─── Runner ─────────────────────────────────────────────────────
export { LoopRunner } from './runner/loop-runner';
export { SecurityPolicyEnforcer } from './runner/security-policy';
export type { PolicyConstraints } from './runner/security-policy';
export { SecurityEnforcer } from './runner/security-enforcement';
export type { SecurityDecision } from './runner/security-enforcement';
export { LoopEventEmitter, LOOP_EVENT_TOPICS } from './runner/event-emitter';
export type { LoopEventEmitterDeps } from './runner/event-emitter';
export { CrashRecoveryManager } from './runner/crash-recovery';
export type { LoopCheckpointState, ResumeContext, CrashRecoveryManagerDeps } from './runner/crash-recovery';
export { LoopCostTracker } from './runner/cost-tracking';
export type { LoopCostTrackerDeps } from './runner/cost-tracking';

// ─── Storage ────────────────────────────────────────────────────
export { LoopStorage } from './storage/loop-storage';

// ─── Harness ────────────────────────────────────────────────────
export { StandingContext } from './harness/standing-context';
export type { LoadResult, ValidateResult } from './harness/standing-context';

export {
  PermissionPatternEngine,
  parsePattern,
  globToRegex,
  matchesPattern,
} from './harness/permission-pattern-engine';
export type {
  PermissionPattern,
  PermissionConfig,
  PatternDecision,
  HierarchyLevel,
} from './harness/permission-pattern-engine';

export { MemoryVault } from './harness/memory-vault';
export type {
  MemoryEntry,
  ReadResult,
  CompactResult,
  CompactionLog,
} from './harness/memory-vault';

export {
  ContextBudgetEnforcer,
  estimateTokens,
  DEFAULT_BUDGET_CONFIG,
} from './harness/context-budget';
export type {
  ContextBudgetConfig,
  BudgetedContext,
} from './harness/context-budget';

export { GoalPlanManager } from './harness/goal-plan-manager';
export type {
  GoalMdContent,
  PlanStep,
  PlanMdContent,
  PlanUpdatePayload,
} from './harness/goal-plan-manager';

export { McpScopingEngine } from './harness/mcp-scoping';
export type {
  McpServerConfig,
  McpToolCallLogEntry,
  HookLike,
} from './harness/mcp-scoping';

export { VerifierSubagent, SHORTCUT_CATALOG } from './harness/verifier-subagent';
export type {
  VerifierInput,
  ShortcutDetection,
  VerifierResult,
  VerifyArrayOnlyResult,
  VerifierDispatchLog,
  ShortcutId,
} from './harness/verifier-subagent';

export { HookEngine } from './harness/hook-engine';
export type {
  HookEvent,
  HookDefinition,
  HookResult,
  PermissionPatternEngineLike as HookPermissionEngineLike,
} from './harness/hook-engine';

export { ProgressHasher } from './harness/progress-hash';
export type { ProgressHashInput } from './harness/progress-hash';

export { SkillLoadingDiscipline } from './harness/skill-loading';
export type {
  SkillHeader,
  SkillRegistration,
  LoadingViolation,
} from './harness/skill-loading';

// ─── Receipt ────────────────────────────────────────────────────
export { ReceiptGenerator } from './receipt/receipt-generator';

// ─── Debrief ────────────────────────────────────────────────────
export { DebriefAgent, DEBRIEF_EVENT_TOPIC } from './debrief/debrief-agent';
export type { DebriefAgentDeps } from './debrief/debrief-agent';

// ─── Doctor ─────────────────────────────────────────────────────
export { LoopDoctor } from './doctor/loop-doctor';

// ─── Catalog ────────────────────────────────────────────────────
export { LoopCraftFlow } from './catalog/loop-craft';
export type { QAQuestion, QAFlowState } from './catalog/loop-craft';

export { CatalogImporter, CatalogFetchError } from './catalog/catalog-importer';
export type { ImportResult } from './catalog/catalog-importer';

export {
  registerBuiltinLoops,
  BUILTIN_LOOPS,
  TYPE_CLEAN_LOOP,
  TEST_REPAIR_LOOP,
  DOCS_CURRENT_LOOP,
  BUILTIN_TYPE_CLEAN_ID,
  BUILTIN_TEST_REPAIR_ID,
  BUILTIN_DOCS_CURRENT_ID,
} from './catalog/builtin-loops';

// ─── Scheduler ──────────────────────────────────────────────────
export { LoopScheduler } from './scheduler/loop-scheduler';
export type { FeatureGateCheckLike, KillSwitchLike, LoopSchedulerDeps } from './scheduler/loop-scheduler';

// ─── IPC ────────────────────────────────────────────────────────
export {
  registerLoopIpcHandlers,
  LoopsListRequestSchema,
  LoopsCraftRequestSchema,
  LoopsAuditRequestSchema,
  LoopsRunRequestSchema,
  LoopsApproveRequestSchema,
  LoopsStopRequestSchema,
  LoopsRunStatusRequestSchema,
  LoopsReceiptRequestSchema,
  LoopsListResponseSchema,
  LoopsCraftResponseSchema,
  LoopsAuditResponseSchema,
  LoopsRunResponseSchema,
  LoopsApproveResponseSchema,
  LoopsStopResponseSchema,
  LoopsRunStatusResponseSchema,
  LoopsReceiptResponseSchema,
} from './ipc/loop-ipc-handlers';

export type {
  LoopRunnerLike,
  LoopDoctorLike,
  ReceiptGeneratorLike,
  IPCRegistryLike,
  LoopIpcDeps,
} from './ipc/loop-ipc-handlers';

// ═══════════════════════════════════════════════════════════════════
// Factory: createLoopEngine
// ═══════════════════════════════════════════════════════════════════

// Import concrete classes used in the factory function.
// These are imported directly (not re-exported) to avoid circular deps.
import { LoopRunner as _LoopRunner } from './runner/loop-runner';
import { LoopStorage as _LoopStorage } from './storage/loop-storage';
import { ReceiptGenerator as _ReceiptGenerator } from './receipt/receipt-generator';
import { DebriefAgent as _DebriefAgent } from './debrief/debrief-agent';
import { LoopDoctor as _LoopDoctor } from './doctor/loop-doctor';
import { CatalogImporter as _CatalogImporter } from './catalog/catalog-importer';
import { LoopScheduler as _LoopScheduler } from './scheduler/loop-scheduler';
import type { FeatureGateCheckLike as _FeatureGateCheckLike, KillSwitchLike as _KillSwitchLike } from './scheduler/loop-scheduler';
import { PermissionPatternEngine as _PermissionPatternEngine } from './harness/permission-pattern-engine';
import { HookEngine as _HookEngine } from './harness/hook-engine';
import { VerifierSubagent as _VerifierSubagent } from './harness/verifier-subagent';
import { ContextBudgetEnforcer as _ContextBudgetEnforcer, DEFAULT_BUDGET_CONFIG as _DEFAULT_BUDGET_CONFIG } from './harness/context-budget';
import { GoalPlanManager as _GoalPlanManager } from './harness/goal-plan-manager';
import { ProgressHasher as _ProgressHasher } from './harness/progress-hash';
import { McpScopingEngine as _McpScopingEngine } from './harness/mcp-scoping';
import { SkillLoadingDiscipline as _SkillLoadingDiscipline } from './harness/skill-loading';
import { MemoryVault as _MemoryVault } from './harness/memory-vault';
import { StandingContext as _StandingContext } from './harness/standing-context';
import { registerLoopIpcHandlers as _registerLoopIpcHandlers } from './ipc/loop-ipc-handlers';
import type { IPCRegistryLike as _IPCRegistryLike } from './ipc/loop-ipc-handlers';
import { registerBuiltinLoops as _registerBuiltinLoops } from './catalog/builtin-loops';
import type Database from 'better-sqlite3';

/**
 * Infrastructure dependencies required to create the Loop Engine.
 * These are existing services provided by the NeuroNest application.
 */
export interface LoopEngineInfrastructureDeps {
  // ── Existing Infrastructure ──
  swarmCoordinator: SwarmCoordinatorLike;
  firewallEngine: FirewallEngineLike;
  actionAnalyzer: ActionAnalyzerLike;
  editLockManager: EditLockManagerLike;
  eventBus: EventBusLike;
  checkpointService: CheckpointServiceLike;
  costTracker: CostTrackingServiceLike;
  featureGate: _FeatureGateCheckLike;

  // ── Database ──
  database: Database.Database;

  // ── Workspace context ──
  workspacePath: string;

  // ── Session provider ──
  getSessionId: () => string;

  // ── IPC registry ──
  ipcRegistry: _IPCRegistryLike;

  // ── Optional overrides (for testing or custom configuration) ──
  tokenBudget?: number;
  executablePath?: string;
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * The fully-wired Loop Engine instance returned by createLoopEngine.
 */
export interface LoopEngineInstance {
  /** The main loop runner state machine */
  runner: _LoopRunner;
  /** Loop storage data access layer */
  storage: _LoopStorage;
  /** Receipt generator for loop run receipts */
  receiptGenerator: _ReceiptGenerator;
  /** Debrief agent for failure analysis */
  debriefAgent: _DebriefAgent;
  /** Loop doctor for spec audit */
  loopDoctor: _LoopDoctor;
  /** Catalog importer */
  catalogImporter: _CatalogImporter;
  /** Loop scheduler */
  scheduler: _LoopScheduler;

  // ── Harness components ──
  permissionPatternEngine: _PermissionPatternEngine;
  hookEngine: _HookEngine;
  verifierSubagent: _VerifierSubagent;
  contextBudgetEnforcer: _ContextBudgetEnforcer;
  goalPlanManager: _GoalPlanManager;
  progressHasher: _ProgressHasher;
  mcpScopingEngine: _McpScopingEngine;
  skillLoadingDiscipline: _SkillLoadingDiscipline;
  memoryVault: _MemoryVault;
  standingContext: _StandingContext;
}

/**
 * Factory function that creates a fully-wired Loop Engine instance.
 *
 * Wires all harness components (PermissionPatternEngine, HookEngine,
 * VerifierSubagent, ContextBudgetEnforcer, GoalPlanManager, ProgressHasher,
 * McpScopingEngine, SkillLoadingDiscipline, MemoryVault, StandingContext)
 * and existing infrastructure (SwarmCoordinator, FirewallEngine,
 * ActionSecurityAnalyzer, EditLockManager, EventBus, CheckpointService,
 * CostTrackingService, FeatureGateSystem).
 *
 * Registers IPC handlers and builtin loops at startup.
 *
 * Requirements: 6.1, 6.5, 15.1
 */
export async function createLoopEngine(
  deps: LoopEngineInfrastructureDeps,
): Promise<LoopEngineInstance> {
  // ── 1. Create Storage Layer ───────────────────────────────────
  const storage = new _LoopStorage(deps.database);

  // ── 2. Create Harness Components ─────────────────────────────
  const standingContext = new _StandingContext(deps.workspacePath);
  const permissionPatternEngine = new _PermissionPatternEngine(deps.workspacePath);
  const memoryVault = new _MemoryVault(deps.workspacePath, deps.tokenBudget ?? 2048);
  const contextBudgetEnforcer = new _ContextBudgetEnforcer(_DEFAULT_BUDGET_CONFIG);
  const goalPlanManager = new _GoalPlanManager(deps.workspacePath);
  const progressHasher = new _ProgressHasher();
  const verifierSubagent = new _VerifierSubagent();
  const mcpScopingEngine = new _McpScopingEngine(deps.workspacePath);
  const skillLoadingDiscipline = new _SkillLoadingDiscipline([]);

  const hookEngine = new _HookEngine([], permissionPatternEngine);

  // ── 3. Create Loop Runner with Full Dependency Injection ──────
  const runnerDeps: LoopRunnerDeps = {
    swarmCoordinator: deps.swarmCoordinator,
    firewallEngine: deps.firewallEngine,
    actionAnalyzer: deps.actionAnalyzer,
    editLockManager: deps.editLockManager,
    eventBus: deps.eventBus,
    checkpointService: deps.checkpointService,
    costTracker: deps.costTracker,
    permissionPatternEngine,
    verifierSubagent,
    hookEngine,
    contextBudgetEnforcer,
    goalPlanManager,
    progressHasher,
    loopStorage: storage,
  };

  const runner = new _LoopRunner(runnerDeps);

  // ── 4. Create Support Services ────────────────────────────────
  const receiptGenerator = new _ReceiptGenerator();
  const debriefAgent = new _DebriefAgent({
    eventBus: deps.eventBus,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  const loopDoctor = new _LoopDoctor();
  const catalogImporter = new _CatalogImporter(
    deps.firewallEngine,
    loopDoctor,
    storage,
  );

  const killSwitch: _KillSwitchLike = {
    async isOperational() {
      return true;
    },
  };

  const scheduler = new _LoopScheduler({
    featureGate: deps.featureGate,
    killSwitch,
    workspacePath: deps.workspacePath,
    ...(deps.executablePath !== undefined ? { executablePath: deps.executablePath } : {}),
  });

  // ── 5. Register IPC Handlers ──────────────────────────────────
  _registerLoopIpcHandlers({
    registry: deps.ipcRegistry,
    loopRunner: runner,
    loopStorage: storage,
    loopDoctor,
    receiptGenerator,
    getSessionId: deps.getSessionId,
  });

  // ── 6. Register Builtin Loops ─────────────────────────────────
  if (deps.featureGate.isEnabled('loops_enabled')) {
    await _registerBuiltinLoops(storage);
  }

  // ── 7. Return Public API Surface ──────────────────────────────
  return {
    runner,
    storage,
    receiptGenerator,
    debriefAgent,
    loopDoctor,
    catalogImporter,
    scheduler,
    permissionPatternEngine,
    hookEngine,
    verifierSubagent,
    contextBudgetEnforcer,
    goalPlanManager,
    progressHasher,
    mcpScopingEngine,
    skillLoadingDiscipline,
    memoryVault,
    standingContext,
  };
}
