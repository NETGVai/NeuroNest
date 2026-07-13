/**
 * Unified Security Gate Interface — a single contract for all security gates.
 *
 * Both FirewallEngine (content inspection) and ActionAnalyzer (action risk classification)
 * implement this interface so that the interactive pipeline has a
 * consistent, swap-safe contract. Concrete method name changes in underlying engines
 * cannot break enforcement when consumers depend only on this interface.
 *
 * Requirements: 24.1
 */

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of inspecting content through the security gate.
 * Maps naturally from FirewallEngine.evaluate() → EvalResult.
 */
export interface SecurityGateResult {
  /** Whether the content is allowed to proceed */
  allowed: boolean;
  /** Human-readable reason if content was blocked */
  reason?: string;
  /** All security findings detected during inspection */
  findings: SecurityFinding[];
}

/**
 * Risk classification result for an action.
 * Maps naturally from ActionAnalyzer's analysis results.
 */
export interface RiskClassification {
  /** Risk level assigned to the action */
  level: 'low' | 'medium' | 'high' | 'critical';
  /** Human-readable explanation of the classification */
  reason: string;
}

// ─── Supporting Types ───────────────────────────────────────────

/**
 * A single security finding from content inspection.
 * Provides enough context for downstream consumers (self-healing loop,
 * remediation bridge) to act on the finding.
 */
export interface SecurityFinding {
  /** Rule or pattern that triggered the finding */
  ruleId: string;
  /** Severity of the finding */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Category of the finding (e.g., 'injection', 'secrets', 'unsafe-command') */
  category: string;
  /** Description of what was detected */
  message: string;
  /** The matched content (truncated for safety) */
  match?: string;
}

// ─── Interface ──────────────────────────────────────────────────

/**
 * Unified security gate contract.
 *
 * Implementations:
 * - FirewallEngine: maps evaluate() → inspect()
 * - ActionAnalyzer (EnsembleSecurityAnalyzer): maps analyze() → classify()
 *
 * Consumers depend on this interface, not on concrete class methods, ensuring
 * enforcement cannot silently fail open due to method renames or refactors.
 */
export interface SecurityGate {
  /**
   * Inspect content for security threats (prompt injection, secrets, policy violations).
   * Used primarily by FirewallEngine to scan inbound messages and tool arguments.
   *
   * @param content - The content to inspect (user message, tool args, file content)
   * @returns Promise resolving to inspection result with findings
   */
  inspect(content: string): Promise<SecurityGateResult>;

  /**
   * Classify the risk level of an action before execution.
   * Used primarily by ActionAnalyzer to evaluate shell commands, file ops, etc.
   *
   * @param action - The action string to classify (command, file path, etc.)
   * @returns Promise resolving to risk classification with reason
   */
  classify(action: string): Promise<RiskClassification>;
}
