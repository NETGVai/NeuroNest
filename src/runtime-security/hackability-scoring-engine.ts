/**
 * Hackability Scoring Engine — computes a 0–100 exploitability score
 * for AI-generated code changes.
 *
 * Produces per-file scores with breakdown by category:
 * - Injection risk (SQL injection, command injection, XSS)
 * - Secrets exposure (hardcoded keys, passwords, tokens)
 * - Authentication weakness (weak auth patterns)
 * - Data validation (missing input validation)
 * - AI-specific risk (unsafe AI patterns)
 *
 * Integrates with existing FirewallEngine and SecurityScanner findings
 * as input signals. Emits warning/blocking events via CallbackEngine.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.1, 8.3, 8.5, 8.7
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigValidationError, LatencyBudgetExceededError } from './errors.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface HackabilityScoreBreakdown {
  injectionRisk: number;          // 0–100
  secretsExposure: number;        // 0–100
  authenticationWeakness: number; // 0–100
  dataValidation: number;         // 0–100
  aiSpecificRisk: number;         // 0–100
}

export interface HackabilityScoreResult {
  filePath: string;
  score: number;                  // 0–100 aggregate
  breakdown: HackabilityScoreBreakdown;
  contributingFactors: string[];
  latencyMs: number;
  inputSignals: {
    firewallFindings: number;
    scannerFindings: number;
  };
}

export interface HackabilityScoringConfig {
  weights: HackabilityScoreBreakdown;  // category weights (must sum to 100)
  criticalThreshold: number;            // default 75
  warningThreshold: number;             // default 40
  maxLatencyMs: number;                 // default 500
}

// ─── Callback Engine Interface ──────────────────────────────────

/** Minimal interface for the CallbackEngine dependency */
export interface CallbackEngineInterface {
  emit: (event: string, context: unknown) => void;
}

// ─── Firewall Engine Interface ──────────────────────────────────

/** Minimal interface for FirewallEngine dependency */
export interface FirewallEngineInterface {
  evaluate: (input: string) => { events: Array<{ ruleId: string; category: string }> };
}

// ─── Security Scanner Interface ─────────────────────────────────

/** Minimal interface for SecurityScanner dependency */
export interface SecurityScannerInterface {
  scanFile: (filePath: string, projectRoot: string, tier: string) => Array<{ ruleId: string; category: string }>;
}

// ─── Detection Patterns ─────────────────────────────────────────

interface DetectionPattern {
  pattern: RegExp;
  factor: string;
  score: number; // contribution to category score (0–100 partial)
}

const INJECTION_PATTERNS: DetectionPattern[] = [
  { pattern: /(?:execute|exec|query)\s*\(\s*['"`].*\$\{/gi, factor: 'SQL injection via template literal', score: 40 },
  { pattern: /(?:execute|exec|query)\s*\(\s*(?:['"`]?\s*\+)/gi, factor: 'SQL injection via concatenation', score: 40 },
  { pattern: /\beval\s*\(/gi, factor: 'eval() usage', score: 35 },
  { pattern: /new\s+Function\s*\(/gi, factor: 'new Function() usage', score: 35 },
  { pattern: /(?:exec|spawn|execSync|spawnSync)\s*\(\s*(?:['"`]?\s*\+|\$\{|`)/gi, factor: 'Command injection via dynamic input', score: 45 },
  { pattern: /innerHTML\s*=\s*(?!['"`]\s*$)/gi, factor: 'XSS via innerHTML assignment', score: 30 },
  { pattern: /document\.write\s*\(/gi, factor: 'XSS via document.write', score: 30 },
  { pattern: /\.html\s*\(\s*(?:['"`]?\s*\+|\$\{)/gi, factor: 'XSS via .html() with dynamic content', score: 25 },
];

const SECRETS_PATTERNS: DetectionPattern[] = [
  { pattern: /(?:api[_-]?key|apikey|api_secret)\s*[=:]\s*['"][a-zA-Z0-9_\-]{20,}['"]/gi, factor: 'Hardcoded API key', score: 50 },
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{4,}['"]/gi, factor: 'Hardcoded password', score: 45 },
  { pattern: /(?:secret|token)\s*[=:]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi, factor: 'Hardcoded secret/token', score: 45 },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, factor: 'Embedded private key', score: 60 },
  { pattern: /AKIA[0-9A-Z]{16}/g, factor: 'AWS access key', score: 55 },
  { pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g, factor: 'GitHub token', score: 50 },
];

const AUTH_WEAKNESS_PATTERNS: DetectionPattern[] = [
  { pattern: /(?:jwt|token)\.verify\s*\(\s*[^,]+,\s*['"][^'"]{1,10}['"]/gi, factor: 'Weak JWT secret (short key)', score: 40 },
  { pattern: /(?:algorithm|alg)\s*[=:]\s*['"]none['"]/gi, factor: 'JWT algorithm none', score: 50 },
  { pattern: /(?:bcrypt|argon2|scrypt|pbkdf2).*rounds?\s*[=:]\s*[0-3]\b/gi, factor: 'Low hash rounds', score: 35 },
  { pattern: /(?:session|cookie).*(?:secure\s*[=:]\s*false|httpOnly\s*[=:]\s*false)/gi, factor: 'Insecure session/cookie config', score: 30 },
  { pattern: /(?:cors|access-control).*origin\s*[=:]\s*['"][*'"]/gi, factor: 'Permissive CORS origin', score: 25 },
  { pattern: /(?:auth|authenticate|login).*(?:skip|bypass|disable)/gi, factor: 'Auth bypass pattern', score: 45 },
];

const DATA_VALIDATION_PATTERNS: DetectionPattern[] = [
  { pattern: /req\.(?:body|query|params)\.[a-zA-Z]+(?!\s*(?:\?\.|&&|!=|!==|\|\||;))/gi, factor: 'Unvalidated request input', score: 20 },
  { pattern: /JSON\.parse\s*\(\s*(?:req|request|body|input)/gi, factor: 'Unvalidated JSON parse from request', score: 30 },
  { pattern: /parseInt\s*\(\s*(?:req|request|input)/gi, factor: 'Unvalidated numeric parse from input', score: 20 },
  { pattern: /(?:readFile|readFileSync)\s*\(\s*(?:req|request|input|user)/gi, factor: 'File read with user input path', score: 40 },
  { pattern: /(?:redirect|location)\s*[=:]\s*(?:req|request|input|user)/gi, factor: 'Open redirect from user input', score: 35 },
];

const AI_SPECIFIC_PATTERNS: DetectionPattern[] = [
  { pattern: /(?:openai|anthropic|cohere|ai|llm|gpt|claude).*(?:api[_-]?key|secret|token)\s*[=:]\s*['"][^'"]+['"]/gi, factor: 'AI API key hardcoded', score: 50 },
  { pattern: /(?:prompt|system_message|instructions)\s*[=:]\s*.*\$\{.*(?:user|input|req)/gi, factor: 'Prompt injection via user input interpolation', score: 45 },
  { pattern: /(?:response|completion|result)\s*\.\s*(?:data|text|content).*(?:exec|eval|query|spawn)/gi, factor: 'Unvalidated AI output in sensitive operation', score: 40 },
  { pattern: /(?:email|phone|ssn|address|name)\s*.*(?:openai|anthropic|cohere|ai|llm|completion)/gi, factor: 'PII sent to AI provider without redaction', score: 35 },
  { pattern: /(?:chat|completion|generate).*(?:fetch|axios|http).*(?!.*rateLimit|!.*throttle)/gi, factor: 'AI endpoint without rate limiting', score: 25 },
];

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_CONFIG: HackabilityScoringConfig = {
  weights: {
    injectionRisk: 20,
    secretsExposure: 20,
    authenticationWeakness: 20,
    dataValidation: 20,
    aiSpecificRisk: 20,
  },
  criticalThreshold: 75,
  warningThreshold: 40,
  maxLatencyMs: 500,
};

// ─── HackabilityScoringEngine ───────────────────────────────────

export class HackabilityScoringEngine {
  private config: HackabilityScoringConfig;
  private callbackEngine: CallbackEngineInterface;
  private firewall: FirewallEngineInterface | null;
  private securityScanner: SecurityScannerInterface | null;

  constructor(
    config: HackabilityScoringConfig,
    callbackEngine: CallbackEngineInterface,
    firewall: FirewallEngineInterface | null,
    securityScanner: SecurityScannerInterface | null,
  ) {
    this.config = config;
    this.callbackEngine = callbackEngine;
    this.firewall = firewall;
    this.securityScanner = securityScanner;
  }

  /**
   * Compute hackability score for a single file's content.
   * Incorporates existing FirewallEngine/SecurityScanner findings as input signals.
   * Emits warning/blocking events via CallbackEngine.
   * Enforces maxLatencyMs budget.
   */
  async scoreFile(
    filePath: string,
    content: string,
    sessionId: string,
  ): Promise<HackabilityScoreResult> {
    const startTime = Date.now();

    // Gather input signals from existing security infrastructure
    const inputSignals = this.gatherInputSignals(filePath, content);

    // Compute per-category scores via pattern analysis
    const breakdown = this.computeBreakdown(content, inputSignals);

    // Compute weighted aggregate score
    const score = this.computeAggregateScore(breakdown);

    // Gather contributing factors
    const contributingFactors = this.gatherContributingFactors(content);

    const latencyMs = Date.now() - startTime;

    // Enforce latency budget
    if (latencyMs > this.config.maxLatencyMs) {
      throw new LatencyBudgetExceededError(
        'HackabilityScoringEngine',
        this.config.maxLatencyMs,
        latencyMs,
      );
    }

    const result: HackabilityScoreResult = {
      filePath,
      score,
      breakdown,
      contributingFactors,
      latencyMs,
      inputSignals,
    };

    // Emit events based on thresholds
    this.emitThresholdEvents(result, sessionId);

    return result;
  }

  /**
   * Compute scores for multiple files (batch operation after code generation).
   */
  async scoreFiles(
    files: Array<{ path: string; content: string }>,
    sessionId: string,
  ): Promise<HackabilityScoreResult[]> {
    const results: HackabilityScoreResult[] = [];
    for (const file of files) {
      const result = await this.scoreFile(file.path, file.content, sessionId);
      results.push(result);
    }
    return results;
  }

  /**
   * Load and validate config from .neuronest-hackability.json.
   * Returns default config if file doesn't exist.
   * Throws ConfigValidationError on malformed config.
   */
  static loadConfig(projectRoot: string): HackabilityScoringConfig {
    const configPath = join(projectRoot, '.neuronest-hackability.json');

    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } };
    }

    let rawContent: string;
    try {
      rawContent = readFileSync(configPath, 'utf-8');
    } catch (err) {
      throw new ConfigValidationError(
        `Failed to read config file: ${err instanceof Error ? err.message : String(err)}`,
        'HackabilityScoringEngine',
        'file',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new ConfigValidationError(
        'Config file contains invalid JSON',
        'HackabilityScoringEngine',
        'json',
      );
    }

    return HackabilityScoringEngine.validateConfig(parsed);
  }

  /**
   * Serialize config to JSON (for round-trip validation).
   */
  static serializeConfig(config: HackabilityScoringConfig): string {
    return JSON.stringify(config);
  }

  /**
   * Parse config from JSON string (for round-trip validation).
   * Validates the parsed result.
   */
  static parseConfig(json: string): HackabilityScoringConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ConfigValidationError(
        'Invalid JSON string',
        'HackabilityScoringEngine',
        'json',
      );
    }
    return HackabilityScoringEngine.validateConfig(parsed);
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Validate a parsed config object and return a typed config or throw.
   */
  private static validateConfig(parsed: unknown): HackabilityScoringConfig {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigValidationError(
        'Config must be a JSON object',
        'HackabilityScoringEngine',
        'root',
      );
    }

    const obj = parsed as Record<string, unknown>;

    // Validate weights
    const rawWeights = obj['weights'];
    if (!rawWeights || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
      throw new ConfigValidationError(
        'Config is missing required field "weights" or it is not an object',
        'HackabilityScoringEngine',
        'weights',
      );
    }

    const weights = rawWeights as Record<string, unknown>;
    const weightFields: (keyof HackabilityScoreBreakdown)[] = [
      'injectionRisk',
      'secretsExposure',
      'authenticationWeakness',
      'dataValidation',
      'aiSpecificRisk',
    ];

    for (const field of weightFields) {
      const val = weights[field];
      if (typeof val !== 'number' || !isFinite(val)) {
        throw new ConfigValidationError(
          `Invalid value for weights.${field}: must be a finite number`,
          'HackabilityScoringEngine',
          `weights.${field}`,
        );
      }
      if (val < 0) {
        throw new ConfigValidationError(
          `Invalid value for weights.${field}: must be non-negative`,
          'HackabilityScoringEngine',
          `weights.${field}`,
        );
      }
    }

    const weightSum = weightFields.reduce(
      (sum, f) => sum + (weights[f] as number),
      0,
    );
    if (weightSum !== 100) {
      throw new ConfigValidationError(
        `Weights must sum to 100, but sum is ${weightSum}`,
        'HackabilityScoringEngine',
        'weights',
      );
    }

    // Validate thresholds
    const criticalThreshold = obj['criticalThreshold'];
    if (typeof criticalThreshold !== 'number' || !isFinite(criticalThreshold)) {
      throw new ConfigValidationError(
        'Config is missing required field "criticalThreshold" or it is not a valid number',
        'HackabilityScoringEngine',
        'criticalThreshold',
      );
    }
    if (criticalThreshold < 0 || criticalThreshold > 100) {
      throw new ConfigValidationError(
        'criticalThreshold must be between 0 and 100',
        'HackabilityScoringEngine',
        'criticalThreshold',
      );
    }

    const warningThreshold = obj['warningThreshold'];
    if (typeof warningThreshold !== 'number' || !isFinite(warningThreshold)) {
      throw new ConfigValidationError(
        'Config is missing required field "warningThreshold" or it is not a valid number',
        'HackabilityScoringEngine',
        'warningThreshold',
      );
    }
    if (warningThreshold < 0 || warningThreshold > 100) {
      throw new ConfigValidationError(
        'warningThreshold must be between 0 and 100',
        'HackabilityScoringEngine',
        'warningThreshold',
      );
    }

    // Validate maxLatencyMs
    const maxLatencyMs = obj['maxLatencyMs'];
    if (typeof maxLatencyMs !== 'number' || !isFinite(maxLatencyMs)) {
      throw new ConfigValidationError(
        'Config is missing required field "maxLatencyMs" or it is not a valid number',
        'HackabilityScoringEngine',
        'maxLatencyMs',
      );
    }
    if (maxLatencyMs <= 0) {
      throw new ConfigValidationError(
        'maxLatencyMs must be a positive number',
        'HackabilityScoringEngine',
        'maxLatencyMs',
      );
    }

    return {
      weights: {
        injectionRisk: weights['injectionRisk'] as number,
        secretsExposure: weights['secretsExposure'] as number,
        authenticationWeakness: weights['authenticationWeakness'] as number,
        dataValidation: weights['dataValidation'] as number,
        aiSpecificRisk: weights['aiSpecificRisk'] as number,
      },
      criticalThreshold,
      warningThreshold,
      maxLatencyMs,
    };
  }

  /**
   * Gather input signals from FirewallEngine and SecurityScanner.
   */
  private gatherInputSignals(
    filePath: string,
    content: string,
  ): { firewallFindings: number; scannerFindings: number } {
    let firewallFindings = 0;
    let scannerFindings = 0;

    if (this.firewall) {
      try {
        const result = this.firewall.evaluate(content);
        firewallFindings = result.events.length;
      } catch {
        // Graceful degradation — continue without firewall signals
      }
    }

    if (this.securityScanner) {
      try {
        const findings = this.securityScanner.scanFile(filePath, '.', 'extended');
        scannerFindings = findings.length;
      } catch {
        // Graceful degradation — continue without scanner signals
      }
    }

    return { firewallFindings, scannerFindings };
  }

  /**
   * Compute per-category breakdown scores using pattern matching.
   * Input signals from firewall/scanner boost relevant category scores.
   */
  private computeBreakdown(
    content: string,
    inputSignals: { firewallFindings: number; scannerFindings: number },
  ): HackabilityScoreBreakdown {
    const injectionRisk = this.computeCategoryScore(content, INJECTION_PATTERNS, inputSignals.firewallFindings);
    const secretsExposure = this.computeCategoryScore(content, SECRETS_PATTERNS, inputSignals.scannerFindings);
    const authenticationWeakness = this.computeCategoryScore(content, AUTH_WEAKNESS_PATTERNS, 0);
    const dataValidation = this.computeCategoryScore(content, DATA_VALIDATION_PATTERNS, 0);
    const aiSpecificRisk = this.computeCategoryScore(content, AI_SPECIFIC_PATTERNS, 0);

    return {
      injectionRisk,
      secretsExposure,
      authenticationWeakness,
      dataValidation,
      aiSpecificRisk,
    };
  }

  /**
   * Score a single category by running patterns against content.
   * Returns a clamped 0–100 value.
   */
  private computeCategoryScore(
    content: string,
    patterns: DetectionPattern[],
    externalSignalBoost: number,
  ): number {
    let totalScore = 0;

    for (const { pattern, score } of patterns) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        // Diminishing returns: first match full score, additional matches add less
        totalScore += score + Math.min((matches.length - 1) * 5, 20);
      }
    }

    // External signals from firewall/scanner boost the score
    if (externalSignalBoost > 0) {
      totalScore += Math.min(externalSignalBoost * 10, 30);
    }

    // Clamp to 0–100
    return Math.min(Math.max(Math.round(totalScore), 0), 100);
  }

  /**
   * Compute the weighted aggregate score from breakdown values.
   * Formula: sum(category * weight) / 100, clamped to 0–100 integer.
   */
  private computeAggregateScore(breakdown: HackabilityScoreBreakdown): number {
    const { weights } = this.config;
    const raw =
      (breakdown.injectionRisk * weights.injectionRisk +
        breakdown.secretsExposure * weights.secretsExposure +
        breakdown.authenticationWeakness * weights.authenticationWeakness +
        breakdown.dataValidation * weights.dataValidation +
        breakdown.aiSpecificRisk * weights.aiSpecificRisk) /
      100;

    return Math.min(Math.max(Math.round(raw), 0), 100);
  }

  /**
   * Gather human-readable contributing factors from detected patterns.
   */
  private gatherContributingFactors(content: string): string[] {
    const factors: string[] = [];
    const allPatterns = [
      ...INJECTION_PATTERNS,
      ...SECRETS_PATTERNS,
      ...AUTH_WEAKNESS_PATTERNS,
      ...DATA_VALIDATION_PATTERNS,
      ...AI_SPECIFIC_PATTERNS,
    ];

    for (const { pattern, factor } of allPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        factors.push(factor);
      }
    }

    return factors;
  }

  /**
   * Emit warning and/or blocking events based on score thresholds.
   * Warning is ALWAYS emitted when blocking is emitted (per requirement 2.4).
   */
  private emitThresholdEvents(
    result: HackabilityScoreResult,
    sessionId: string,
  ): void {
    const { score, filePath, breakdown, contributingFactors } = result;

    if (score > this.config.warningThreshold) {
      this.callbackEngine.emit('security-score-computed', {
        type: 'warning',
        subsystem: 'hackability_scoring',
        filePath,
        score,
        breakdown,
        contributingFactors,
        sessionId,
      });
    }

    if (score > this.config.criticalThreshold) {
      this.callbackEngine.emit('security-write-blocked', {
        type: 'blocking',
        subsystem: 'hackability_scoring',
        filePath,
        score,
        breakdown,
        contributingFactors,
        sessionId,
      });
    }
  }
}
