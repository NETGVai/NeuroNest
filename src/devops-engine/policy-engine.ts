/**
 * Policy Engine — Fail-Closed Rule Evaluator
 *
 * Determines whether a tool invocation is allowed, denied, or requires human escalation.
 * All requests are denied by default (fail-closed); only explicit allow rules grant access.
 *
 * Evaluation precedence (lower priority number = higher precedence):
 * 1. Explicit deny rules
 * 2. Capability grant overrides (active grants can override denials)
 * 3. Environment-specific rules
 * 4. Base rules
 * 5. Default: deny (fail-closed)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { randomUUID } from 'crypto';
import type {
  PolicyRule,
  PolicyEvaluation,
  CapabilityGrant
} from './types';

/**
 * Categorizes policy rules into precedence tiers.
 * Tier ordering: deny (0) > grant-override (1) > environment-specific (2) > base (3)
 */
function getRuleTier(rule: PolicyRule): number {
  if (rule.action === 'deny') return 0;
  if (rule.conditions.environment) return 2;
  return 3;
}

/**
 * Checks whether a condition value matches the request value.
 * Supports both single string and array of strings in rule conditions.
 */
function matchesCondition(
  conditionValue: string | string[] | undefined,
  requestValue: string | undefined
): boolean {
  if (conditionValue === undefined) return true; // no condition → wildcard match
  if (requestValue === undefined) return false;
  if (Array.isArray(conditionValue)) {
    return conditionValue.includes(requestValue);
  }
  return conditionValue === requestValue;
}

/** Audit chain logging interface (optional dependency injection). */
export interface AuditLogger {
  logPolicyDecision(evaluation: PolicyEvaluation): void;
}

export interface PolicyEngineOptions {
  auditLogger?: AuditLogger;
}

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private registeredTools: Set<string> = new Set();
  private allowedContexts: Set<string> = new Set();
  private mappedAgents: Set<string> = new Set();
  private auditLogger: AuditLogger | null;

  constructor(options: PolicyEngineOptions = {}) {
    this.auditLogger = options.auditLogger ?? null;
  }

  /**
   * Register a tool name as known to the system.
   * Unregistered tools are always denied.
   */
  registerTool(toolName: string): void {
    this.registeredTools.add(toolName);
  }

  /**
   * Register multiple tools at once.
   */
  registerTools(toolNames: string[]): void {
    for (const name of toolNames) {
      this.registeredTools.add(name);
    }
  }

  /**
   * Add a target context to the allowlist.
   * Requests targeting unlisted contexts are denied.
   */
  addAllowedContext(context: string): void {
    this.allowedContexts.add(context);
  }

  /**
   * Add multiple allowed contexts at once.
   */
  addAllowedContexts(contexts: string[]): void {
    for (const ctx of contexts) {
      this.allowedContexts.add(ctx);
    }
  }

  /**
   * Map an agent identity as recognized.
   * Requests from unmapped agents are denied.
   */
  mapAgent(agentId: string): void {
    this.mappedAgents.add(agentId);
  }

  /**
   * Map multiple agent identities at once.
   */
  mapAgents(agentIds: string[]): void {
    for (const id of agentIds) {
      this.mappedAgents.add(id);
    }
  }

  /**
   * Check if a tool is registered in the known tool set.
   */
  isToolRegistered(toolName: string): boolean {
    return this.registeredTools.has(toolName);
  }

  /**
   * Add a policy rule to the engine.
   * Rules are maintained sorted by priority (lower number = higher precedence).
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get all rules in precedence order (sorted by priority ascending).
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate a tool invocation request against the policy engine.
   *
   * This method is synchronous — it does not await audit logging.
   * On any internal error during evaluation, returns deny with error reason.
   */
  evaluate(request: {
    toolName: string;
    agentId: string;
    arguments: Record<string, unknown>;
    targetContext?: string;
    activeGrants?: CapabilityGrant[];
  }): PolicyEvaluation {
    const correlationId = randomUUID();
    const timestamp = Date.now();

    try {
      // 1. Default-deny: Unregistered tool
      if (!this.registeredTools.has(request.toolName)) {
        const evaluation: PolicyEvaluation = {
          decision: 'deny',
          matchedRule: null,
          correlationId,
          timestamp,
          reason: `Tool '${request.toolName}' is not registered in the known tool set`
        };
        this.logDecision(evaluation);
        return evaluation;
      }

      // 2. Default-deny: Unlisted target context
      if (
        request.targetContext !== undefined &&
        !this.allowedContexts.has(request.targetContext)
      ) {
        const evaluation: PolicyEvaluation = {
          decision: 'deny',
          matchedRule: null,
          correlationId,
          timestamp,
          reason: `Target context '${request.targetContext}' is not in the configured allowlist`
        };
        this.logDecision(evaluation);
        return evaluation;
      }

      // 3. Default-deny: Unmapped agent identity
      if (!this.mappedAgents.has(request.agentId)) {
        const evaluation: PolicyEvaluation = {
          decision: 'deny',
          matchedRule: null,
          correlationId,
          timestamp,
          reason: `Agent '${request.agentId}' is not mapped to a recognized identity`
        };
        this.logDecision(evaluation);
        return evaluation;
      }

      // 4. Evaluate rules in precedence order
      // Phase A: Explicit deny rules (tier 0)
      const denyRules = this.rules.filter((r) => getRuleTier(r) === 0);
      for (const rule of denyRules) {
        if (this.ruleMatchesRequest(rule, request)) {
          const evaluation: PolicyEvaluation = {
            decision: rule.action,
            matchedRule: rule.id,
            correlationId,
            timestamp,
            reason: `Matched explicit deny rule '${rule.id}'`
          };
          this.logDecision(evaluation);
          return evaluation;
        }
      }

      // Phase B: Capability grant overrides (tier 1)
      // Active grants can override denials and allow the request
      if (request.activeGrants && request.activeGrants.length > 0) {
        const activeGrant = request.activeGrants.find(
          (grant) =>
            grant.status === 'active' &&
            grant.expiresAt > timestamp &&
            grant.remainingExecutions > 0
        );
        if (activeGrant) {
          const evaluation: PolicyEvaluation = {
            decision: 'allow',
            matchedRule: `grant:${activeGrant.id}`,
            correlationId,
            timestamp,
            reason: `Allowed by active capability grant '${activeGrant.id}'`
          };
          this.logDecision(evaluation);
          return evaluation;
        }
      }

      // Phase C: Environment-specific rules (tier 2)
      const envRules = this.rules.filter((r) => getRuleTier(r) === 2);
      for (const rule of envRules) {
        if (this.ruleMatchesRequest(rule, request)) {
          const evaluation: PolicyEvaluation = {
            decision: rule.action,
            matchedRule: rule.id,
            correlationId,
            timestamp,
            reason: `Matched environment-specific rule '${rule.id}'`
          };
          this.logDecision(evaluation);
          return evaluation;
        }
      }

      // Phase D: Base rules (tier 3)
      const baseRules = this.rules.filter((r) => getRuleTier(r) === 3);
      for (const rule of baseRules) {
        if (this.ruleMatchesRequest(rule, request)) {
          const evaluation: PolicyEvaluation = {
            decision: rule.action,
            matchedRule: rule.id,
            correlationId,
            timestamp,
            reason: `Matched base rule '${rule.id}'`
          };
          this.logDecision(evaluation);
          return evaluation;
        }
      }

      // 5. Default-deny: No matching rule found (fail-closed)
      const evaluation: PolicyEvaluation = {
        decision: 'deny',
        matchedRule: null,
        correlationId,
        timestamp,
        reason: 'No matching policy rule found (default deny — fail-closed)'
      };
      this.logDecision(evaluation);
      return evaluation;
    } catch (error) {
      // On any internal error during evaluation, deny the request
      // regardless of logging availability (Requirement 6.4)
      const evaluation: PolicyEvaluation = {
        decision: 'deny',
        matchedRule: null,
        correlationId,
        timestamp,
        reason: `Internal evaluation error: ${error instanceof Error ? error.message : String(error)}`
      };
      // Attempt to log, but do not let logging failure override the denial
      try {
        this.logDecision(evaluation);
      } catch {
        // Logging failure does not override the denial
      }
      return evaluation;
    }
  }

  /**
   * Check if a rule's conditions match a given request.
   */
  private ruleMatchesRequest(
    rule: PolicyRule,
    request: {
      toolName: string;
      agentId: string;
      arguments: Record<string, unknown>;
      targetContext?: string;
    }
  ): boolean {
    const { conditions } = rule;

    if (!matchesCondition(conditions.toolName, request.toolName)) return false;
    if (!matchesCondition(conditions.agentId, request.agentId)) return false;
    if (!matchesCondition(conditions.targetContext, request.targetContext)) return false;

    return true;
  }

  /**
   * Log a policy evaluation decision to the Audit Chain.
   * This is a fire-and-forget operation; logging failures do not affect the decision.
   */
  private logDecision(evaluation: PolicyEvaluation): void {
    if (this.auditLogger) {
      this.auditLogger.logPolicyDecision(evaluation);
    }
  }
}
