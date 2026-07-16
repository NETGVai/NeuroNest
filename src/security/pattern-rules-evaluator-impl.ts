/**
 * PatternRulesEvaluator implementation backed by PermissionPatternEngine.
 *
 * This bridges the PermissionPatternEngine (with its pattern hierarchy including
 * per-agent patterns) to the AuthorizationPipeline's PatternRulesEvaluator interface.
 *
 * The evaluator:
 *   1. Extracts the tool name and args from the ToolCall
 *   2. Extracts the agentId from the ToolContext
 *   3. Delegates to PermissionPatternEngine.evaluate(toolName, args, agentId)
 *   4. Maps the PatternDecision to a StageResult
 *
 * Requirements: 10.4, 10.5, 10.11
 */

import type { ToolCall, ToolContext } from '../shared/types.js';
import type { PatternRulesEvaluator } from './authorization-pipeline.js';
import { PermissionPatternEngine, type PatternDecision } from './permission-pattern-engine.js';
import { loadAgentPatternsIntoEngine } from './agent-permission-patterns.js';

/** Internal stage result from the authorization pipeline */
type StageResult =
  | { verdict: 'deny'; reason: string }
  | { verdict: 'allow'; reason: string }
  | { verdict: 'ask'; reason: string }
  | { verdict: 'pass' };

/**
 * Concrete implementation of PatternRulesEvaluator backed by
 * PermissionPatternEngine with per-agent pattern support.
 *
 * Instantiated with a workspace path and automatically loads per-agent
 * patterns from the AGENT_TOOL_PERMISSIONS registry.
 */
export class PatternRulesEvaluatorImpl implements PatternRulesEvaluator {
  private readonly engine: PermissionPatternEngine;

  constructor(workspacePath: string, options?: { loadAgentPatterns?: boolean }) {
    this.engine = new PermissionPatternEngine(workspacePath);

    // Load per-agent patterns by default (opt-out via options for testing)
    if (options?.loadAgentPatterns !== false) {
      loadAgentPatternsIntoEngine(this.engine);
    }
  }

  /**
   * Get the underlying engine for advanced configuration
   * (managed patterns, never-touch rules, loop state, etc.)
   */
  getEngine(): PermissionPatternEngine {
    return this.engine;
  }

  /**
   * Evaluate a tool call against pattern rules.
   *
   * Maps PermissionPatternEngine decisions:
   *   - 'deny'     → StageResult { verdict: 'deny', reason }
   *   - 'allow'    → StageResult { verdict: 'allow', reason }
   *   - 'no-match' → StageResult { verdict: 'pass' } (decline to decide)
   */
  evaluate(call: ToolCall, ctx: ToolContext): StageResult {
    const toolName = call.name;
    const args = this.normalizeArgs(call);
    const agentId = ctx.agentId;

    const decision: PatternDecision = this.engine.evaluate(toolName, args, agentId);

    switch (decision) {
      case 'deny':
        return {
          verdict: 'deny',
          reason: `Pattern rule denied: ${toolName}(${this.truncateArgs(args)}) for agent '${agentId}'`,
        };

      case 'allow':
        return {
          verdict: 'allow',
          reason: `Pattern rule allowed: ${toolName}(${this.truncateArgs(args)}) for agent '${agentId}'`,
        };

      case 'no-match':
        // No pattern matched — decline to decide, pass to next stage
        return { verdict: 'pass' };
    }
  }

  /**
   * Normalize tool call arguments into a string representation
   * suitable for pattern matching.
   */
  private normalizeArgs(call: ToolCall): string {
    try {
      const args = typeof call.arguments === 'string'
        ? JSON.parse(call.arguments)
        : call.arguments;

      // For file operations, use the path as the match target
      if (args?.path) return String(args.path);
      if (args?.filePath) return String(args.filePath);
      if (args?.file) return String(args.file);

      // For command operations, use the command string
      if (args?.command) return String(args.command);
      if (args?.cmd) return String(args.cmd);

      // Default: serialize top-level arg values
      if (typeof args === 'object' && args !== null) {
        const values = Object.values(args).filter((v) => typeof v === 'string');
        return values.join(':') || '*';
      }

      return String(args ?? '*');
    } catch {
      // If args parsing fails, use wildcard (matches everything)
      return call.arguments || '*';
    }
  }

  /**
   * Truncate args for display in reason strings (avoid huge log entries).
   */
  private truncateArgs(args: string): string {
    if (args.length <= 80) return args;
    return args.slice(0, 77) + '...';
  }
}
