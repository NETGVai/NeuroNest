/**
 * AI Security Rule Engine — Detection rules for AI/LLM-specific vulnerabilities.
 *
 * Evaluates code changes against rules covering 5 categories:
 * - secrets-in-prompts: API keys/tokens in prompt templates
 * - pii-leakage: PII passed directly to AI providers without redaction
 * - prompt-injection: User input concatenated into prompts without sanitization
 * - unvalidated-output: AI responses used in security-sensitive operations
 * - missing-rate-limit: AI endpoints without rate limiting (negation pattern)
 *
 * Complements the existing FirewallEngine by detecting AI-specific patterns
 * that the FirewallEngine's regex and semantic tiers do not cover.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigValidationError } from './errors.js';
import type { ThreatSeverity } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** Valid categories for AI security rules */
export type AISecurityRuleCategory =
  | 'secrets-in-prompts'
  | 'pii-leakage'
  | 'prompt-injection'
  | 'unvalidated-output'
  | 'missing-rate-limit';

/** Definition of a single AI security detection rule */
export interface AISecurityRule {
  id: string;
  name: string;
  category: AISecurityRuleCategory;
  severity: ThreatSeverity;
  pattern: string;
  negationPattern?: string;
  description: string;
  remediation: string;
  enabled: boolean;
  /** Confidence score 0.0–1.0 for findings from this rule. Defaults based on severity if absent. */
  confidence?: number;
}

/** A single finding produced by rule evaluation */
export interface AISecurityFinding {
  ruleId: string;
  ruleName: string;
  category: string;
  severity: ThreatSeverity;
  /** Confidence score 0.0–1.0. High-confidence issues route to auto-fix; ambiguous ones prompt user. */
  confidence: number;
  file: string;
  line: number;
  match: string;
  remediation: string;
}

/** Result of evaluating all rules against a file */
export interface AISecurityEvalResult {
  passed: boolean;
  findings: AISecurityFinding[];
  rulesEvaluated: number;
  latencyMs: number;
}

// ─── Constants ──────────────────────────────────────────────────

const RULES_FILENAME = '.neuronest-ai-security-rules.json';

const VALID_CATEGORIES: AISecurityRuleCategory[] = [
  'secrets-in-prompts',
  'pii-leakage',
  'prompt-injection',
  'unvalidated-output',
  'missing-rate-limit',
];

const VALID_SEVERITIES: ThreatSeverity[] = ['critical', 'high', 'medium', 'low'];

const REQUIRED_RULE_FIELDS: (keyof AISecurityRule)[] = [
  'id',
  'name',
  'category',
  'severity',
  'pattern',
  'description',
  'remediation',
  'enabled',
];

// ─── Built-in Default Rules ─────────────────────────────────────

const DEFAULT_RULES: AISecurityRule[] = [
  {
    id: 'ai-sec-001',
    name: 'API key in prompt template',
    category: 'secrets-in-prompts',
    severity: 'critical',
    pattern: '(openai|anthropic|cohere|azure).*[\'"]sk-[a-zA-Z0-9]{20,}[\'"]',
    description: 'Detects API keys hardcoded in AI provider prompt templates or configuration',
    remediation: 'Use environment variables or a credential vault for API keys. Never hardcode secrets in source.',
    enabled: true,
  },
  {
    id: 'ai-sec-002',
    name: 'Token or password in LLM call',
    category: 'secrets-in-prompts',
    severity: 'high',
    pattern: '(prompt|message|system_prompt|user_message).*[\'"][A-Za-z0-9+/=]{32,}[\'"]',
    description: 'Detects tokens or encoded secrets embedded in prompt strings passed to LLM APIs',
    remediation: 'Remove secrets from prompt content. Use secret references or environment variables instead.',
    enabled: true,
  },
  {
    id: 'ai-sec-003',
    name: 'PII in AI provider call',
    category: 'pii-leakage',
    severity: 'high',
    pattern: '(email|phone|ssn|social_security|creditCard|credit_card)\\s*[,)]\\s*(openai|anthropic|llm|ai|chat|completion)',
    description: 'Detects PII variables being passed directly to external AI provider API calls without redaction',
    remediation: 'Redact or anonymize PII data before sending to AI providers. Use the redaction pipeline.',
    enabled: true,
  },
  {
    id: 'ai-sec-004',
    name: 'Email/phone pattern in prompt',
    category: 'pii-leakage',
    severity: 'medium',
    pattern: '(prompt|message|content).*\\$\\{.*(email|phone|ssn|password|api_key).*\\}',
    description: 'Detects PII fields interpolated into prompt template strings',
    remediation: 'Remove PII from prompts or apply redaction before interpolation.',
    enabled: true,
  },
  {
    id: 'ai-sec-005',
    name: 'User input concatenated into prompt',
    category: 'prompt-injection',
    severity: 'high',
    pattern: '\\+\\s*(userInput|user_input|req\\.body|req\\.query|req\\.params)',
    description: 'Detects user input being concatenated directly into prompt strings without sanitization',
    remediation: 'Sanitize and validate user input before including in prompts. Use parameterized prompt templates.',
    enabled: true,
  },
  {
    id: 'ai-sec-006',
    name: 'User input interpolated into prompt',
    category: 'prompt-injection',
    severity: 'high',
    pattern: '(prompt|system_prompt|message).*\\$\\{.*(user|input|query|request|body).*\\}',
    description: 'Detects user-controlled variables interpolated into prompt template strings',
    remediation: 'Use parameterized prompt templates with input validation and sanitization.',
    enabled: true,
  },
  {
    id: 'ai-sec-007',
    name: 'AI output in exec/eval/SQL',
    category: 'unvalidated-output',
    severity: 'critical',
    pattern: '(exec|eval|execSync|query|execute|run)\\s*\\(\\s*(aiResponse|llmOutput|completion|response\\.text|result\\.content|ai_result)',
    description: 'Detects AI/LLM API responses used directly in security-sensitive operations (exec, eval, SQL)',
    remediation: 'Validate and sanitize AI output before using in exec, eval, SQL, or file system operations.',
    enabled: true,
  },
  {
    id: 'ai-sec-008',
    name: 'AI output in file system operation',
    category: 'unvalidated-output',
    severity: 'high',
    pattern: '(writeFile|readFile|unlink|mkdir|fs\\.)\\s*\\(\\s*(aiResponse|llmOutput|completion|response\\.text|result\\.content|ai_result)',
    description: 'Detects AI/LLM responses used directly in file system operations without validation',
    remediation: 'Validate AI output paths and content before file system operations. Use allowlists for paths.',
    enabled: true,
  },
  {
    id: 'ai-sec-009',
    name: 'AI endpoint without rate limit',
    category: 'missing-rate-limit',
    severity: 'medium',
    pattern: '(app\\.(get|post|put|patch|delete)|router\\.(get|post|put|patch|delete)).*\\/.*(ai|llm|chat|completion|prompt)',
    negationPattern: '(rateLimit|rateLimiter|throttle|RateLimit|rate_limit)',
    description: 'Detects AI-facing HTTP endpoints defined without rate limiting middleware',
    remediation: 'Add rate limiting middleware to AI-facing endpoints to prevent abuse and cost overruns.',
    enabled: true,
  },
];

// ─── Validation Helpers ─────────────────────────────────────────

/**
 * Validate a single rule definition.
 * Throws ConfigValidationError on invalid rules.
 */
function validateRule(rule: unknown, index: number): AISecurityRule {
  if (typeof rule !== 'object' || rule === null) {
    throw new ConfigValidationError(
      `Rule at index ${index} must be an object`,
      'ai_security_rules',
      `rules[${index}]`,
    );
  }

  const ruleObj = rule as Record<string, unknown>;

  // Check required fields
  for (const field of REQUIRED_RULE_FIELDS) {
    if (!(field in ruleObj) || ruleObj[field] === undefined || ruleObj[field] === null) {
      throw new ConfigValidationError(
        `Rule at index ${index} is missing required field '${field}'`,
        'ai_security_rules',
        `rules[${index}].${field}`,
      );
    }
  }

  // Validate string fields
  const stringFields: (keyof AISecurityRule)[] = ['id', 'name', 'pattern', 'description', 'remediation'];
  for (const field of stringFields) {
    if (typeof ruleObj[field] !== 'string' || (ruleObj[field] as string).trim() === '') {
      throw new ConfigValidationError(
        `Rule at index ${index} field '${field}' must be a non-empty string`,
        'ai_security_rules',
        `rules[${index}].${field}`,
      );
    }
  }

  // Validate category enum
  if (!VALID_CATEGORIES.includes(ruleObj['category'] as AISecurityRuleCategory)) {
    throw new ConfigValidationError(
      `Rule at index ${index} has invalid category '${ruleObj['category']}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      'ai_security_rules',
      `rules[${index}].category`,
    );
  }

  // Validate severity enum
  if (!VALID_SEVERITIES.includes(ruleObj['severity'] as ThreatSeverity)) {
    throw new ConfigValidationError(
      `Rule at index ${index} has invalid severity '${ruleObj['severity']}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      'ai_security_rules',
      `rules[${index}].severity`,
    );
  }

  // Validate enabled is boolean
  if (typeof ruleObj['enabled'] !== 'boolean') {
    throw new ConfigValidationError(
      `Rule at index ${index} field 'enabled' must be a boolean`,
      'ai_security_rules',
      `rules[${index}].enabled`,
    );
  }

  // Validate regex pattern
  try {
    new RegExp(ruleObj['pattern'] as string);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    throw new ConfigValidationError(
      `Rule at index ${index} has invalid regex pattern '${ruleObj['pattern']}': ${errMsg}`,
      'ai_security_rules',
      `rules[${index}].pattern`,
    );
  }

  // Validate negationPattern if present
  if ('negationPattern' in ruleObj && ruleObj['negationPattern'] !== undefined) {
    if (typeof ruleObj['negationPattern'] !== 'string') {
      throw new ConfigValidationError(
        `Rule at index ${index} field 'negationPattern' must be a string`,
        'ai_security_rules',
        `rules[${index}].negationPattern`,
      );
    }
    try {
      new RegExp(ruleObj['negationPattern'] as string);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new ConfigValidationError(
        `Rule at index ${index} has invalid negationPattern regex '${ruleObj['negationPattern']}': ${errMsg}`,
        'ai_security_rules',
        `rules[${index}].negationPattern`,
      );
    }
  }

  return ruleObj as unknown as AISecurityRule;
}

/**
 * Validate an array of rules.
 */
function validateRules(rules: unknown[]): AISecurityRule[] {
  return rules.map((rule, index) => validateRule(rule, index));
}

// ─── Confidence Derivation ──────────────────────────────────────

/**
 * Derive a default confidence score from the finding severity.
 * Used when the rule does not specify an explicit confidence value.
 * Critical rules are high-confidence (0.85), high (0.75), medium (0.6), low (0.4).
 */
function deriveConfidenceFromSeverity(severity: ThreatSeverity): number {
  switch (severity) {
    case 'critical': return 0.85;
    case 'high': return 0.75;
    case 'medium': return 0.6;
    case 'low': return 0.4;
    default: return 0.5;
  }
}

// ─── CallbackEngine / FirewallEngine Interfaces ─────────────────

/** Minimal interface for CallbackEngine dependency */
export interface AIRuleCallbackEngine {
  emit: (event: string, context: unknown) => void;
}

/** Minimal interface for FirewallEngine dependency */
export interface AIRuleFirewallEngine {
  coveredCategories?: () => string[];
}

// ─── AISecurityRuleEngine Class ─────────────────────────────────

/**
 * AI Security Rule Engine.
 *
 * Evaluates code against AI/LLM-specific security rules covering 5 categories.
 * Complements FirewallEngine by detecting patterns specific to AI integration
 * that traditional scanners miss.
 */
export class AISecurityRuleEngine {
  private readonly rules: AISecurityRule[];
  private readonly callbackEngine: AIRuleCallbackEngine;
  private readonly firewall: AIRuleFirewallEngine | null;

  constructor(
    rules: AISecurityRule[],
    callbackEngine: AIRuleCallbackEngine,
    firewall: AIRuleFirewallEngine | null,
  ) {
    this.rules = rules;
    this.callbackEngine = callbackEngine;
    this.firewall = firewall;
  }

  /**
   * Evaluate code content against all enabled AI security rules.
   * Skips categories already covered by FirewallEngine.
   * Returns passing result when no AI-specific risks detected.
   */
  evaluate(filePath: string, content: string, sessionId: string): AISecurityEvalResult {
    const startTime = performance.now();
    const findings: AISecurityFinding[] = [];

    // Determine categories covered by FirewallEngine
    const coveredCategories = this.firewall?.coveredCategories?.() ?? [];

    // Split content into lines for line number tracking
    const lines = content.split('\n');

    let rulesEvaluated = 0;

    for (const rule of this.rules) {
      if (!rule.enabled) {
        continue;
      }

      // Skip if FirewallEngine already covers this category
      if (coveredCategories.includes(rule.category)) {
        continue;
      }

      rulesEvaluated++;

      if (rule.negationPattern) {
        // Negation pattern: finding is triggered if the negationPattern is ABSENT
        // but the main pattern matches (i.e., an endpoint exists but lacks rate limiting)
        const mainRegex = new RegExp(rule.pattern, 'g');
        const negationRegex = new RegExp(rule.negationPattern);

        // Check if the main pattern matches anywhere in the content
        const hasMainPattern = mainRegex.test(content);

        if (hasMainPattern) {
          // Check if the negation pattern is absent from the entire content
          const hasNegation = negationRegex.test(content);

          if (!hasNegation) {
            // Find the line where the main pattern matches for reporting
            const mainRegexForLine = new RegExp(rule.pattern);
            for (let i = 0; i < lines.length; i++) {
              const lineMatch = mainRegexForLine.exec(lines[i]);
              if (lineMatch) {
                findings.push({
                  ruleId: rule.id,
                  ruleName: rule.name,
                  category: rule.category,
                  severity: rule.severity,
                  confidence: rule.confidence ?? deriveConfidenceFromSeverity(rule.severity),
                  file: filePath,
                  line: i + 1,
                  match: lineMatch[0],
                  remediation: rule.remediation,
                });
                break; // One finding per negation rule
              }
            }
          }
        }
      } else {
        // Standard pattern: finding triggered when pattern matches content
        const regex = new RegExp(rule.pattern, 'g');

        for (let i = 0; i < lines.length; i++) {
          const lineMatch = regex.exec(lines[i]);
          if (lineMatch) {
            findings.push({
              ruleId: rule.id,
              ruleName: rule.name,
              category: rule.category,
              severity: rule.severity,
              confidence: rule.confidence ?? deriveConfidenceFromSeverity(rule.severity),
              file: filePath,
              line: i + 1,
              match: lineMatch[0],
              remediation: rule.remediation,
            });
          }
          // Reset regex lastIndex for line-by-line scanning
          regex.lastIndex = 0;
        }
      }
    }

    const latencyMs = performance.now() - startTime;

    // Emit finding events via CallbackEngine
    if (findings.length > 0) {
      this.callbackEngine.emit('security-ai-rule-finding', {
        subsystem: 'ai_security_rules',
        sessionId,
        filePath,
        findings,
        severity: findings[0].severity, // highest severity finding first
      });
    }

    return {
      passed: findings.length === 0,
      findings,
      rulesEvaluated,
      latencyMs,
    };
  }

  /**
   * Load and validate custom rules from .neuronest-ai-security-rules.json.
   * Returns built-in default rules if file doesn't exist.
   * Throws ConfigValidationError on invalid regex patterns or missing required fields.
   */
  static loadRules(projectRoot: string): AISecurityRule[] {
    const rulesFilePath = path.join(projectRoot, RULES_FILENAME);

    if (!fs.existsSync(rulesFilePath)) {
      return [...DEFAULT_RULES];
    }

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(rulesFilePath, 'utf-8');
    } catch (e) {
      throw new ConfigValidationError(
        `Failed to read AI security rules file: ${e instanceof Error ? e.message : String(e)}`,
        'ai_security_rules',
        'file',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      throw new ConfigValidationError(
        `Failed to parse AI security rules JSON: ${e instanceof Error ? e.message : String(e)}`,
        'ai_security_rules',
        'json',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigValidationError(
        'AI security rules file must contain a JSON object',
        'ai_security_rules',
        'root',
      );
    }

    const parsedObj = parsed as Record<string, unknown>;

    if (!Array.isArray(parsedObj['rules'])) {
      throw new ConfigValidationError(
        'AI security rules file must contain a "rules" array',
        'ai_security_rules',
        'rules',
      );
    }

    return validateRules(parsedObj['rules']);
  }

  /**
   * Serialize rules to JSON with proper formatting (for round-trip validation).
   */
  static serializeRules(rules: AISecurityRule[]): string {
    return JSON.stringify({ rules }, null, 2);
  }

  /**
   * Parse rules from JSON string with validation (for round-trip validation).
   * Throws ConfigValidationError on invalid rules.
   */
  static parseRules(json: string): AISecurityRule[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new ConfigValidationError(
        `Failed to parse AI security rules JSON: ${e instanceof Error ? e.message : String(e)}`,
        'ai_security_rules',
        'json',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigValidationError(
        'AI security rules must be a JSON object with a "rules" array',
        'ai_security_rules',
        'root',
      );
    }

    const parsedObj = parsed as Record<string, unknown>;

    if (!Array.isArray(parsedObj['rules'])) {
      throw new ConfigValidationError(
        'AI security rules must contain a "rules" array',
        'ai_security_rules',
        'rules',
      );
    }

    return validateRules(parsedObj['rules']);
  }

  /**
   * Get the built-in default rules.
   */
  static getDefaultRules(): AISecurityRule[] {
    return [...DEFAULT_RULES];
  }
}
