// ─── Security Enforcement Per Pass ──────────────────────────────
// Enforces the full security stack before each pass execution:
// Firewall Engine, Action Security Analyzer, EditLock, and tool allowlists.
//
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.5

import type {
  LoopState,
  LoopSpec,
  LoopRunnerDeps,
} from '../index';

// ─── Security Decision Types ────────────────────────────────────

export type SecurityDecision =
  | { allowed: true }
  | { allowed: false; reason: string; nextState: LoopState };

// ─── Security Enforcer ─────────────────────────────────────────

/**
 * SecurityEnforcer orchestrates per-pass security checks before execution.
 * It coordinates the Firewall Engine, Action Security Analyzer, and EditLock
 * to ensure no pass bypasses existing security controls.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class SecurityEnforcer {
  /**
   * Enforces all security checks before a pass transitions to EXECUTING_PASS.
   *
   * Order of operations:
   * 1. Firewall Engine inspection — blocks malicious content (REQ 5.1)
   * 2. Action Security Analyzer — classifies risk, pauses on HIGH (REQ 5.2, 5.3)
   * 3. EditLock constraint — restricts file writes to allowedPaths (REQ 5.4)
   * 4. Tool allowlist validation — restricts tools to allowedTools (REQ 5.5)
   *
   * @param actionPlan - The planned action content for this pass
   * @param spec - The LoopSpec defining scope constraints
   * @param deps - Injected dependencies providing access to security subsystems
   * @returns SecurityDecision indicating whether execution may proceed
   */
  async enforceBeforeExecution(
    actionPlan: string,
    spec: LoopSpec,
    deps: LoopRunnerDeps,
  ): Promise<SecurityDecision> {
    // ─── Step 1: Firewall Engine inspection (REQ 5.1) ─────────
    const firewallResult = await deps.firewallEngine.inspect(actionPlan);
    if (firewallResult.blocked) {
      return {
        allowed: false,
        reason: firewallResult.reason ?? 'firewall_blocked',
        nextState: 'BLOCKED',
      };
    }

    // ─── Step 2: Action Security Analyzer classification (REQ 5.2, 5.3) ───
    const riskResult = await deps.actionAnalyzer.classify(actionPlan);
    if (riskResult.risk === 'HIGH') {
      return {
        allowed: false,
        reason: `Action classified as HIGH risk: requires approval`,
        nextState: 'AWAITING_APPROVAL',
      };
    }

    // ─── Step 3: EditLock constraint (REQ 5.4) ────────────────
    // Configure the EditLock manager with the spec's allowedPaths for this pass
    deps.editLockManager.setAllowedPaths(spec.scope.allowedPaths);

    // ─── Step 4: Tool allowlist validation (REQ 5.5) ──────────
    // Extract tool references from the action plan and validate against allowedTools
    const toolViolation = this.validateToolUsage(actionPlan, spec.scope.allowedTools);
    if (toolViolation) {
      return {
        allowed: false,
        reason: toolViolation,
        nextState: 'BLOCKED',
      };
    }

    return { allowed: true };
  }

  /**
   * Validates that any tool references in the action plan are within
   * the spec's allowedTools list.
   *
   * Tool references are detected by matching patterns like "tool:toolName"
   * or "[toolName]" in the action plan text.
   *
   * @param actionPlan - The action plan text to scan for tool references
   * @param allowedTools - The list of permitted tool identifiers
   * @returns A rejection reason string if a disallowed tool is found, or null if all tools are allowed
   */
  validateToolUsage(actionPlan: string, allowedTools: string[]): string | null {
    const referencedTools = this.extractToolReferences(actionPlan);

    for (const tool of referencedTools) {
      if (!allowedTools.includes(tool)) {
        return `Tool '${tool}' is not in scope.allowedTools: [${allowedTools.join(', ')}]`;
      }
    }

    return null;
  }

  /**
   * Extracts tool identifiers referenced in an action plan string.
   * Looks for patterns:
   * - "tool:identifier" (colon-delimited)
   * - "[identifier]" (bracket-delimited, common in action plans)
   *
   * @param actionPlan - The action plan text to parse
   * @returns Array of unique tool identifiers found
   */
  extractToolReferences(actionPlan: string): string[] {
    const tools = new Set<string>();

    // Match "tool:<identifier>" pattern
    const toolColonPattern = /\btool:([a-zA-Z0-9_-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = toolColonPattern.exec(actionPlan)) !== null) {
      const captured = match[1];
      if (captured) tools.add(captured);
    }

    // Match "[identifier]" bracket pattern for tool references
    const bracketPattern = /\[([a-zA-Z0-9_-]+)\]/g;
    while ((match = bracketPattern.exec(actionPlan)) !== null) {
      const captured = match[1];
      if (captured) tools.add(captured);
    }

    return Array.from(tools);
  }
}
