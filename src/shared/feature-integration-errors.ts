// Feature Integration error types
// Centralized error handling for all new feature modules

// ─── Error Categories ───────────────────────────────────────────

export type ErrorCategory =
  | 'artifact'
  | 'pipeline'
  | 'vision'
  | 'sandbox'
  | 'plugin'
  | 'benchmark'
  | 'infrastructure'
  // Superagent subsystem categories (Req 0.4)
  | 'feature-gate'
  | 'cost-tracking'
  | 'checkpoint'
  | 'vulnerability-blocking'
  | 'dependency-grounding'
  | 'memory-persistence'
  | 'lsp-intelligence'
  | 'worktree-isolation'
  | 'ast-locking'
  | 'credential-vault'
  | 'model-routing'
  | 'self-improvement'
  | 'trace-visualization'
  | 'parallel-agents'
  | 'supply-chain-detection'
  | 'specialist-roles'
  | 'completion-council'
  | 'provider-failover'
  | 'headless-mode'
  | 'provenance-tracking'
  | 'skill-creation'
  | 'scheduled-tasks'
  | 'remote-access'
  | 'voice-io'
  | 'kanban-board'
  | 'repo-readiness'
  | 'compliance-gates'
  | 'wasm-sandbox'
  | 'browser-automation'
  | 'backpropagation';

// ─── Feature Error ──────────────────────────────────────────────

export class FeatureError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    message: string;
    category: ErrorCategory;
    code: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'FeatureError';
    this.category = params.category;
    this.code = params.code;
    this.details = params.details;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, FeatureError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      code: this.code,
      details: this.details,
    };
  }
}
