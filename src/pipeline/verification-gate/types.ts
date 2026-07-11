/**
 * Type definitions for the Verification Gate pipeline.
 * Defines interfaces for stages, results, edits, and project context.
 */

// ─── Core Types ─────────────────────────────────────────────────

export type StageName = 'syntax' | 'typecheck' | 'lint' | 'security' | 'test' | 'smoke';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface StageResult {
  stageName: StageName;
  passed: boolean;
  diagnostics: Diagnostic[];
  durationMs: number;
}

export interface VerificationResult {
  totalScore: number;
  maxScore: number; // always 18
  stages: StageResult[];
  accepted: boolean;
  failedAt?: StageName;
  totalDurationMs: number;
}

// ─── Agent Edit ─────────────────────────────────────────────────

export interface FileChange {
  filePath: string;
  content: string;
  originalContent?: string;
}

export interface AgentEdit {
  id: string;
  taskId: string;
  changes: FileChange[];
  description?: string;
}

// ─── Project Context ────────────────────────────────────────────

export interface ProjectContext {
  rootDir: string;
  tsconfigPath: string;
  eslintConfigPath?: string;
  testCommand?: string;
  dependencyGraph?: DependencyGraph;
}

export interface DependencyGraph {
  /** Maps a file path to the set of files that depend on it (reverse deps) */
  dependents: Map<string, Set<string>>;
  /** Maps a file path to its direct dependencies */
  dependencies: Map<string, Set<string>>;
}

// ─── Stage Interface ────────────────────────────────────────────

export interface VerificationStage {
  name: StageName;
  score: number;
  execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult>;
}

// ─── Pipeline Interface ─────────────────────────────────────────

export interface VerificationPipelineConfig {
  /** Total pipeline timeout in ms (default: 30000 for <10 files) */
  timeoutMs: number;
  /** Maximum files before relaxing the timeout */
  maxFilesForTimeout: number;
  /** Stages to run in sequence */
  stages: VerificationStage[];
}

export interface VerificationPipeline {
  run(edit: AgentEdit, context: ProjectContext): Promise<VerificationResult>;
}

// ─── Stage Scores ───────────────────────────────────────────────

export const STAGE_SCORES: Record<StageName, number> = {
  syntax: 1,
  typecheck: 2,
  lint: 3,
  security: 3,
  test: 4,
  smoke: 5,
};

export const STAGE_ORDER: StageName[] = ['syntax', 'typecheck', 'lint', 'security', 'test', 'smoke'];

export const MAX_SCORE = 18; // 1 + 2 + 3 + 3 + 4 + 5
