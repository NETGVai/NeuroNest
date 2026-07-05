// ─── Harness Layer ──────────────────────────────────────────────
// Permission patterns, standing context, memory discipline, hooks,
// verifier subagent, MCP scoping, GOAL.md/PLAN.md, progress hash,
// and context budget enforcement.

export { StandingContext } from './standing-context';
export type { LoadResult, ValidateResult } from './standing-context';

export {
  PermissionPatternEngine,
  parsePattern,
  globToRegex,
  matchesPattern,
} from './permission-pattern-engine.js';
export type {
  PermissionPattern,
  PermissionConfig,
  PatternDecision,
  HierarchyLevel,
} from './permission-pattern-engine.js';

export { MemoryVault } from './memory-vault.js';
export type {
  MemoryEntry,
  ReadResult,
  CompactResult,
  CompactionLog,
} from './memory-vault.js';

export {
  ContextBudgetEnforcer,
  estimateTokens,
  DEFAULT_BUDGET_CONFIG,
} from './context-budget';
export type {
  ContextBudgetConfig,
  BudgetedContext,
} from './context-budget';

export { GoalPlanManager } from './goal-plan-manager';
export type {
  GoalMdContent,
  PlanStep,
  PlanMdContent,
  PlanUpdatePayload,
} from './goal-plan-manager';

export { McpScopingEngine } from './mcp-scoping';
export type {
  McpServerConfig,
  McpToolCallLogEntry,
  HookLike,
} from './mcp-scoping';

export { VerifierSubagent, SHORTCUT_CATALOG } from './verifier-subagent';
export type {
  VerifierInput,
  ShortcutDetection,
  VerifierResult,
  VerifyArrayOnlyResult,
  VerifierDispatchLog,
  ShortcutId,
} from './verifier-subagent';

export { HookEngine } from './hook-engine';
export type {
  HookEvent,
  HookDefinition,
  HookResult,
  PermissionPatternEngineLike as HookPermissionEngineLike,
} from './hook-engine';

export { ProgressHasher } from './progress-hash';
export type { ProgressHashInput } from './progress-hash';

export { SkillLoadingDiscipline } from './skill-loading';
export type {
  SkillHeader,
  SkillRegistration,
  LoadingViolation,
} from './skill-loading';
