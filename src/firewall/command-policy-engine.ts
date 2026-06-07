/**
 * Command Policy Engine
 * 
 * Three-tier command evaluation system extending the existing FirewallEngine.
 * Evaluates commands against policy rules in priority order: deny first,
 * then ask, then allow. Applies a configurable default action when no rule matches.
 * 
 * Loads rules from `.firewall-config.json` under the `commandPolicy` key,
 * supporting up to 200 rules across all tiers.
 * 
 * Emits events on EventBus for deny/ask actions.
 * Integrates with existing FirewallEngine as a pre-execution check.
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10
 */

import { readFileSync, existsSync } from 'node:fs';
import { EventBus } from '../events/event-bus.js';
import { logger } from '../utils/logger.js';
import { globMatch } from './glob-matcher.js';

/**
 * A single policy rule specifying a glob pattern and its tier.
 */
export interface PolicyRule {
  id: string;
  pattern: string;       // glob pattern
  tier: 'allow' | 'ask' | 'deny';
  reason?: string;
}

/**
 * Result of evaluating a command against the policy rules.
 */
export interface CommandPolicyResult {
  action: 'allow' | 'ask' | 'deny';
  matchedRule: PolicyRule | null;
  reason: string;
}

/**
 * The configurable default action when no rule matches.
 */
export type DefaultAction = 'allow' | 'ask' | 'deny';

/**
 * Event emitted when a command is denied or requires approval.
 */
export interface CommandPolicyEvent {
  command: string;
  action: 'deny' | 'ask';
  matchedRule: PolicyRule | null;
  reason: string;
  timestamp: number;
}

/**
 * Configuration structure for command policy in .firewall-config.json.
 */
export interface CommandPolicyConfig {
  defaultAction?: string;
  rules?: unknown[];
}

/**
 * Maximum number of rules that can be loaded.
 */
const MAX_RULES = 200;

/**
 * Valid tier values for policy rules.
 */
const VALID_TIERS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny']);

/**
 * Valid default action values.
 */
const VALID_DEFAULT_ACTIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny']);

/**
 * Options for creating a CommandPolicyEngine instance.
 */
export interface CommandPolicyEngineOptions {
  eventBus?: EventBus;
  defaultAction?: DefaultAction;
}

/**
 * Command Policy Engine
 * 
 * Evaluates shell commands against a three-tier allowlist/denylist
 * before execution. Integrates with the existing FirewallEngine as
 * a pre-execution check in the agent shell execution pipeline.
 */
export class CommandPolicyEngine {
  private rules: PolicyRule[] = [];
  private defaultAction: DefaultAction;
  private eventBus?: EventBus;

  constructor(options: CommandPolicyEngineOptions = {}) {
    this.eventBus = options.eventBus;
    this.defaultAction = options.defaultAction ?? 'ask';
  }

  /**
   * Evaluate a command against policy rules.
   * 
   * Priority order: deny rules first, then ask rules, then allow rules.
   * If no rule matches, the configured default action is applied.
   * 
   * Emits events on EventBus for deny/ask actions.
   */
  evaluate(command: string): CommandPolicyResult {
    // Separate rules by tier
    const denyRules = this.rules.filter(r => r.tier === 'deny');
    const askRules = this.rules.filter(r => r.tier === 'ask');
    const allowRules = this.rules.filter(r => r.tier === 'allow');

    // Evaluate deny rules first
    for (const rule of denyRules) {
      if (globMatch(rule.pattern, command)) {
        const result: CommandPolicyResult = {
          action: 'deny',
          matchedRule: rule,
          reason: rule.reason ?? `Command matched deny rule: ${rule.id}`,
        };
        this.emitPolicyEvent(command, result);
        return result;
      }
    }

    // Evaluate ask rules second
    for (const rule of askRules) {
      if (globMatch(rule.pattern, command)) {
        const result: CommandPolicyResult = {
          action: 'ask',
          matchedRule: rule,
          reason: rule.reason ?? `Command matched ask rule: ${rule.id}`,
        };
        this.emitPolicyEvent(command, result);
        return result;
      }
    }

    // Evaluate allow rules third
    for (const rule of allowRules) {
      if (globMatch(rule.pattern, command)) {
        const result: CommandPolicyResult = {
          action: 'allow',
          matchedRule: rule,
          reason: rule.reason ?? `Command matched allow rule: ${rule.id}`,
        };
        // No event emitted for allow actions
        return result;
      }
    }

    // No rule matched — apply default action
    const result: CommandPolicyResult = {
      action: this.defaultAction,
      matchedRule: null,
      reason: `No rule matched; applying default action: ${this.defaultAction}`,
    };

    // Emit event for deny/ask default actions
    if (this.defaultAction === 'deny' || this.defaultAction === 'ask') {
      this.emitPolicyEvent(command, result);
    }

    return result;
  }

  /**
   * Load rules from a .firewall-config.json file.
   * 
   * Reads the `commandPolicy` key from the config file.
   * Supports up to 200 rules across all tiers.
   * Invalid rules are skipped with a warning logged.
   * If the file is malformed, uses an empty rule set (default action applies).
   */
  loadRules(configPath: string): void {
    if (!existsSync(configPath)) {
      logger.warn('[CommandPolicyEngine] Config file not found, using empty rule set', { configPath });
      this.rules = [];
      return;
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(configPath, 'utf8');
    } catch (error) {
      logger.error('[CommandPolicyEngine] Failed to read config file', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.rules = [];
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fileContent);
    } catch (error) {
      logger.error('[CommandPolicyEngine] Config file contains malformed JSON', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.rules = [];
      return;
    }

    const commandPolicy = parsed.commandPolicy as CommandPolicyConfig | undefined;
    if (!commandPolicy) {
      logger.warn('[CommandPolicyEngine] No commandPolicy key found in config', { configPath });
      this.rules = [];
      return;
    }

    // Load default action
    if (commandPolicy.defaultAction && typeof commandPolicy.defaultAction === 'string') {
      if (VALID_DEFAULT_ACTIONS.has(commandPolicy.defaultAction)) {
        this.defaultAction = commandPolicy.defaultAction as DefaultAction;
      } else {
        logger.warn('[CommandPolicyEngine] Invalid defaultAction in config, keeping current default', {
          value: commandPolicy.defaultAction,
        });
      }
    }

    // Load rules
    if (!Array.isArray(commandPolicy.rules)) {
      logger.warn('[CommandPolicyEngine] commandPolicy.rules is not an array, using empty rule set');
      this.rules = [];
      return;
    }

    const validRules: PolicyRule[] = [];
    const rawRules = commandPolicy.rules;

    // Enforce max rules limit
    if (rawRules.length > MAX_RULES) {
      logger.warn('[CommandPolicyEngine] Rule limit exceeded, loading first 200 rules', {
        total: rawRules.length,
        max: MAX_RULES,
      });
    }

    const rulesToProcess = rawRules.slice(0, MAX_RULES);

    for (let i = 0; i < rulesToProcess.length; i++) {
      const raw = rulesToProcess[i];
      const rule = this.validateRule(raw, i);
      if (rule) {
        validRules.push(rule);
      }
    }

    this.rules = validRules;
    logger.info('[CommandPolicyEngine] Rules loaded', {
      configPath,
      totalRules: this.rules.length,
      denyRules: this.rules.filter(r => r.tier === 'deny').length,
      askRules: this.rules.filter(r => r.tier === 'ask').length,
      allowRules: this.rules.filter(r => r.tier === 'allow').length,
    });
  }

  /**
   * Get all loaded policy rules.
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Get the current default action.
   */
  getDefaultAction(): DefaultAction {
    return this.defaultAction;
  }

  /**
   * Validate a raw rule object and return a PolicyRule if valid.
   */
  private validateRule(raw: unknown, index: number): PolicyRule | null {
    if (!raw || typeof raw !== 'object') {
      logger.warn('[CommandPolicyEngine] Invalid rule at index, skipping', { index });
      return null;
    }

    const obj = raw as Record<string, unknown>;

    // Validate id
    if (typeof obj.id !== 'string' || obj.id.trim() === '') {
      logger.warn('[CommandPolicyEngine] Rule missing valid id, skipping', { index });
      return null;
    }

    // Validate pattern
    if (typeof obj.pattern !== 'string' || obj.pattern.trim() === '') {
      logger.warn('[CommandPolicyEngine] Rule missing valid pattern, skipping', { index, id: obj.id });
      return null;
    }

    // Validate tier
    if (typeof obj.tier !== 'string' || !VALID_TIERS.has(obj.tier)) {
      logger.warn('[CommandPolicyEngine] Rule has invalid tier, skipping', { index, id: obj.id, tier: obj.tier });
      return null;
    }

    // Validate optional reason
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;

    return {
      id: obj.id,
      pattern: obj.pattern,
      tier: obj.tier as 'allow' | 'ask' | 'deny',
      reason,
    };
  }

  /**
   * Emit a policy event on the EventBus for deny/ask actions.
   */
  private emitPolicyEvent(command: string, result: CommandPolicyResult): void {
    if (!this.eventBus) {
      return;
    }

    if (result.action !== 'deny' && result.action !== 'ask') {
      return;
    }

    const eventData: CommandPolicyEvent = {
      command,
      action: result.action,
      matchedRule: result.matchedRule,
      reason: result.reason,
      timestamp: Date.now(),
    };

    this.eventBus.publish('guardrail.command-policy', {
      type: `command_${result.action}`,
      data: eventData,
    }).catch((err) => {
      logger.error('[CommandPolicyEngine] Failed to emit policy event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
