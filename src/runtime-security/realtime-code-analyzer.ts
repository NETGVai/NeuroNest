/**
 * Real-time Code Analyzer — Intercepts file writes for inline security analysis.
 *
 * Performs pattern-based vulnerability detection on code before it is written to disk,
 * coordinating with FirewallEngine to skip already-cleared categories and respecting
 * a 200ms latency budget.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ThreatSeverity, SecurityLifecycleEvent } from './types.js';
import { ConfigValidationError, LatencyBudgetExceededError } from './errors.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface RealtimeAnalysisFinding {
  id: string;
  severity: ThreatSeverity;
  /** Confidence score 0.0–1.0. High-confidence issues route to auto-fix; ambiguous ones prompt user. */
  confidence: number;
  category: string;
  message: string;
  file: string;
  line: number;
  remediation: string;
  blockedWrite: boolean;
}

export interface RealtimeAnalysisResult {
  passed: boolean;
  findings: RealtimeAnalysisFinding[];
  latencyMs: number;
  timedOut: boolean;
  firewallCategoriesSkipped: string[];
}

// ─── Internal Types ─────────────────────────────────────────────

interface VulnerabilityPattern {
  id: string;
  category: string;
  severity: ThreatSeverity;
  pattern: RegExp;
  message: string;
  remediation: string;
  /** Confidence score 0.0–1.0 for findings from this pattern */
  confidence: number;
  /** FirewallEngine categories that cover this pattern */
  coveredByFirewallCategories: string[];
}

/**
 * External pattern format as stored in `.neuronest/security-patterns.json`.
 * Pattern field is a regex string (not a RegExp object).
 */
export interface ExternalVulnerabilityPattern {
  pattern: string;
  category: string;
  severity: string;
  remediation: string;
  blockedWrite?: boolean;
  /** Optional id (auto-generated if not provided) */
  id?: string;
  /** Optional message (defaults to category description) */
  message?: string;
  /** Optional confidence score 0.0–1.0 (defaults to 0.7) */
  confidence?: number;
  /** Optional firewall categories this pattern is covered by */
  coveredByFirewallCategories?: string[];
}

/** Filename for external vulnerability patterns */
const PATTERNS_FILENAME = 'security-patterns.json';
/** Directory for NeuroNest project-level configuration */
const CONFIG_DIR = '.neuronest';

interface CallbackEngine {
  emit: (event: string, context: unknown) => void;
  on?: (event: string, handler: Function) => void;
  off?: (event: string, handler: Function) => void;
}

interface FirewallInterface {
  evaluate?: (content: string) => { passed: boolean; categories?: string[] };
}

// ─── Vulnerability Patterns ─────────────────────────────────────

const VULNERABILITY_PATTERNS: VulnerabilityPattern[] = [
  // SQL Injection
  {
    id: 'sql-injection-concat',
    category: 'sql-injection',
    severity: 'critical',
    pattern: /(?:execute|query|exec|raw)\s*\(\s*[`"'].*\$\{.*\}.*[`"']\s*\)|(?:execute|query|exec|raw)\s*\(\s*.*\+\s*(?:req\.|input|user|params|query|body)/gi,
    message: 'Potential SQL injection via string concatenation or template literal',
    remediation: 'Use parameterized queries or prepared statements instead of string concatenation',
    confidence: 0.85,
    coveredByFirewallCategories: [],
  },
  {
    id: 'sql-injection-format',
    category: 'sql-injection',
    severity: 'critical',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\s+.*(?:\+\s*(?:req\.|input|user|params)|`\s*\$\{(?:req\.|input|user|params))/gi,
    message: 'SQL statement constructed with user input',
    remediation: 'Use parameterized queries with placeholders ($1, ?, :param) instead of string interpolation',
    confidence: 0.9,
    coveredByFirewallCategories: [],
  },
  // XSS
  {
    id: 'xss-innerhtml',
    category: 'xss',
    severity: 'high',
    pattern: /\.innerHTML\s*=\s*(?!['"`]\s*['"`])/g,
    message: 'Direct innerHTML assignment may enable XSS attacks',
    remediation: 'Use textContent, innerText, or a sanitization library like DOMPurify before setting innerHTML',
    confidence: 0.75,
    coveredByFirewallCategories: [],
  },
  {
    id: 'xss-document-write',
    category: 'xss',
    severity: 'high',
    pattern: /document\.write\s*\(/g,
    message: 'document.write can be exploited for XSS',
    remediation: 'Use DOM manipulation methods (createElement, appendChild) instead of document.write',
    confidence: 0.8,
    coveredByFirewallCategories: [],
  },
  // Command Injection
  {
    id: 'command-injection-exec',
    category: 'command-injection',
    severity: 'critical',
    pattern: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:`[^`]*\$\{|[^,)]*\+\s*(?:req\.|input|user|params|query|body|args))/gi,
    message: 'Potential command injection via unsanitized input in shell execution',
    remediation: 'Use parameterized command arrays (spawn with args array) or validate/sanitize input before shell execution',
    confidence: 0.85,
    coveredByFirewallCategories: ['unsafe-command'],
  },
  {
    id: 'command-injection-shell',
    category: 'command-injection',
    severity: 'critical',
    pattern: /child_process.*(?:exec|execSync)\s*\(\s*(?:.*\+|.*\$\{)/g,
    message: 'Shell command constructed with dynamic input',
    remediation: 'Use execFile or spawn with argument arrays instead of exec with string concatenation',
    confidence: 0.85,
    coveredByFirewallCategories: ['unsafe-command'],
  },
  // Path Traversal
  {
    id: 'path-traversal-join',
    category: 'path-traversal',
    severity: 'high',
    pattern: /(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream|createWriteStream|access|stat|unlink)\s*\(\s*(?:.*\+\s*(?:req\.|input|user|params|query|body)|`[^`]*\$\{(?:req\.|input|user|params|query|body))/gi,
    message: 'File system operation with unsanitized user input may allow path traversal',
    remediation: 'Validate and normalize paths using path.resolve() and verify they stay within allowed directories',
    confidence: 0.8,
    coveredByFirewallCategories: [],
  },
  {
    id: 'path-traversal-dotdot',
    category: 'path-traversal',
    severity: 'medium',
    pattern: /(?:path\.join|path\.resolve)\s*\([^)]*(?:req\.|input|user|params|query|body)/gi,
    message: 'Path constructed with user input without traversal validation',
    remediation: 'After constructing the path, verify it starts with the expected base directory using path.relative()',
    confidence: 0.6,
    coveredByFirewallCategories: [],
  },
  // Hardcoded Secrets
  {
    id: 'hardcoded-secret-apikey',
    category: 'hardcoded-secrets',
    severity: 'critical',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key)\s*[:=]\s*['"`][a-zA-Z0-9_\-]{20,}['"`]/gi,
    message: 'Hardcoded API key or secret detected',
    remediation: 'Store secrets in environment variables or a secrets management service, not in source code',
    confidence: 0.8,
    coveredByFirewallCategories: ['secrets'],
  },
  {
    id: 'hardcoded-secret-password',
    category: 'hardcoded-secrets',
    severity: 'high',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{4,}['"`]/gi,
    message: 'Hardcoded password detected',
    remediation: 'Use environment variables or a secure credential store for passwords',
    confidence: 0.7,
    coveredByFirewallCategories: ['secrets'],
  },
  {
    id: 'hardcoded-secret-token',
    category: 'hardcoded-secrets',
    severity: 'critical',
    pattern: /(?:token|bearer|auth_token|access_token)\s*[:=]\s*['"`][a-zA-Z0-9_\-\.]{20,}['"`]/gi,
    message: 'Hardcoded authentication token detected',
    remediation: 'Use environment variables or a token management system instead of hardcoding tokens',
    confidence: 0.8,
    coveredByFirewallCategories: ['secrets'],
  },
  // Insecure Crypto
  {
    id: 'insecure-crypto-md5',
    category: 'insecure-crypto',
    severity: 'medium',
    pattern: /createHash\s*\(\s*['"`]md5['"`]\s*\)/g,
    message: 'MD5 is cryptographically broken and should not be used for security purposes',
    remediation: 'Use SHA-256 or SHA-3 for hashing. For password hashing, use bcrypt, scrypt, or argon2',
    confidence: 0.95,
    coveredByFirewallCategories: [],
  },
  {
    id: 'insecure-crypto-sha1',
    category: 'insecure-crypto',
    severity: 'medium',
    pattern: /createHash\s*\(\s*['"`]sha1['"`]\s*\)/g,
    message: 'SHA-1 is deprecated for security use and vulnerable to collision attacks',
    remediation: 'Use SHA-256 or SHA-3 for cryptographic hashing',
    confidence: 0.95,
    coveredByFirewallCategories: [],
  },
  {
    id: 'insecure-crypto-ecb',
    category: 'insecure-crypto',
    severity: 'high',
    pattern: /createCipher(?:iv)?\s*\(\s*['"`](?:aes-\d+-ecb|des|des3|rc4)['"`]/gi,
    message: 'Insecure cipher mode or algorithm detected',
    remediation: 'Use AES-256-GCM or AES-256-CBC with proper IV for symmetric encryption',
    confidence: 0.9,
    coveredByFirewallCategories: [],
  },
];

// ─── RealtimeCodeAnalyzer Class ─────────────────────────────────

export class RealtimeCodeAnalyzer {
  private readonly callbackEngine: CallbackEngine;
  private readonly firewall: FirewallInterface | null;
  private readonly maxLatencyMs: number;
  private readonly blockOnCriticalOnly: boolean;
  private readonly patterns: VulnerabilityPattern[];
  private hookHandler: ((context: unknown) => void) | null = null;

  constructor(
    callbackEngine: CallbackEngine,
    firewall: FirewallInterface | null,
    maxLatencyMs: number = 200,
    blockOnCriticalOnly: boolean = false,
    patterns?: VulnerabilityPattern[],
  ) {
    this.callbackEngine = callbackEngine;
    this.firewall = firewall;
    this.maxLatencyMs = maxLatencyMs;
    this.blockOnCriticalOnly = blockOnCriticalOnly;
    this.patterns = patterns || VULNERABILITY_PATTERNS;
  }

  /**
   * Register as a before-tool-call hook on CallbackEngine.
   * Intercepts file write operations to perform inline analysis.
   */
  registerHook(): void {
    if (this.hookHandler) {
      return; // Already registered
    }

    this.hookHandler = (context: unknown) => {
      // Hook handler is registered but actual analysis is performed
      // by the agent loop calling analyzeBeforeWrite directly.
      // The hook serves as the integration point with CallbackEngine.
      const ctx = context as { toolName?: string; input?: { filePath?: string; content?: string }; sessionId?: string } | undefined;
      if (ctx?.toolName === 'write_file' && ctx.input?.filePath && ctx.input?.content) {
        // Emit that the hook was triggered — actual blocking is done via analyzeBeforeWrite
        this.callbackEngine.emit('security-realtime-hook-triggered', {
          filePath: ctx.input.filePath,
          sessionId: ctx.sessionId,
        });
      }
    };

    if (this.callbackEngine.on) {
      this.callbackEngine.on('before-tool-call', this.hookHandler);
    }
  }

  /**
   * Unregister the before-tool-call hook.
   */
  unregisterHook(): void {
    if (this.hookHandler && this.callbackEngine.off) {
      this.callbackEngine.off('before-tool-call', this.hookHandler);
    }
    this.hookHandler = null;
  }

  /**
   * Analyze code content destined for a file write.
   * Returns within maxLatencyMs or allows write and emits async finding.
   * Coordinates with FirewallEngine to skip already-cleared categories.
   */
  async analyzeBeforeWrite(
    filePath: string,
    content: string,
    sessionId: string,
    firewallResult?: { passed: boolean; categories?: string[] },
  ): Promise<RealtimeAnalysisResult> {
    const startTime = Date.now();
    const findings: RealtimeAnalysisFinding[] = [];
    const firewallCategoriesSkipped: string[] = [];

    // Determine which firewall categories have already been cleared
    const clearedCategories = new Set<string>();
    if (firewallResult?.passed && firewallResult.categories) {
      for (const cat of firewallResult.categories) {
        clearedCategories.add(cat);
      }
    }

    // Run vulnerability pattern checks
    const lines = content.split('\n');

    for (const vulnPattern of this.patterns) {
      // Check if we've exceeded latency budget
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxLatencyMs) {
        const latencyMs = Date.now() - startTime;

        // Timeout: allow write and emit async finding
        this.callbackEngine.emit('security-write-warned' satisfies SecurityLifecycleEvent, {
          subsystem: 'realtime-code-analyzer',
          type: 'latency-timeout',
          filePath,
          sessionId,
          latencyMs,
          message: `Analysis exceeded ${this.maxLatencyMs}ms budget, write allowed`,
        });

        return {
          passed: true,
          findings,
          latencyMs,
          timedOut: true,
          firewallCategoriesSkipped,
        };
      }

      // Skip patterns covered by already-cleared firewall categories
      const isSkipped = vulnPattern.coveredByFirewallCategories.some(cat => clearedCategories.has(cat));
      if (isSkipped) {
        for (const cat of vulnPattern.coveredByFirewallCategories) {
          if (clearedCategories.has(cat) && !firewallCategoriesSkipped.includes(cat)) {
            firewallCategoriesSkipped.push(cat);
          }
        }
        continue;
      }

      // Run pattern against content line by line for line-number accuracy
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        // Reset regex for each line (global flag)
        vulnPattern.pattern.lastIndex = 0;
        if (vulnPattern.pattern.test(line)) {
          findings.push({
            id: randomUUID(),
            severity: vulnPattern.severity,
            confidence: vulnPattern.confidence,
            category: vulnPattern.category,
            message: vulnPattern.message,
            file: filePath,
            line: lineIdx + 1, // 1-indexed
            remediation: vulnPattern.remediation,
            blockedWrite: false, // Will be set below based on policy
          });
          // Only report first match per pattern per file to keep findings lean
          break;
        }
      }
    }

    const latencyMs = Date.now() - startTime;

    // Determine blocking behavior based on findings and policy
    if (findings.length > 0) {
      const hasCritical = findings.some(f => f.severity === 'critical');

      if (this.blockOnCriticalOnly) {
        // Only block on critical findings
        if (hasCritical) {
          // Mark critical findings as blocking
          for (const finding of findings) {
            if (finding.severity === 'critical') {
              finding.blockedWrite = true;
            }
          }

          // Emit blocking event
          this.callbackEngine.emit('security-write-blocked' satisfies SecurityLifecycleEvent, {
            subsystem: 'realtime-code-analyzer',
            severity: 'critical',
            filePath,
            sessionId,
            findings: findings.filter(f => f.blockedWrite),
            remediation: findings.filter(f => f.blockedWrite).map(f => f.remediation).join('; '),
            decision: 'blocked',
          });

          // Emit warning for non-critical findings
          const nonCritical = findings.filter(f => !f.blockedWrite);
          if (nonCritical.length > 0) {
            this.callbackEngine.emit('security-write-warned' satisfies SecurityLifecycleEvent, {
              subsystem: 'realtime-code-analyzer',
              severity: nonCritical[0].severity,
              filePath,
              sessionId,
              findings: nonCritical,
              decision: 'warned',
            });
          }

          return {
            passed: false,
            findings,
            latencyMs,
            timedOut: false,
            firewallCategoriesSkipped,
          };
        } else {
          // Non-critical only — emit warning, allow write
          this.callbackEngine.emit('security-write-warned' satisfies SecurityLifecycleEvent, {
            subsystem: 'realtime-code-analyzer',
            severity: findings[0].severity,
            filePath,
            sessionId,
            findings,
            decision: 'warned',
          });

          return {
            passed: true,
            findings,
            latencyMs,
            timedOut: false,
            firewallCategoriesSkipped,
          };
        }
      } else {
        // Block on any finding
        for (const finding of findings) {
          finding.blockedWrite = true;
        }

        this.callbackEngine.emit('security-write-blocked' satisfies SecurityLifecycleEvent, {
          subsystem: 'realtime-code-analyzer',
          severity: findings[0].severity,
          filePath,
          sessionId,
          findings,
          remediation: findings.map(f => f.remediation).join('; '),
          decision: 'blocked',
        });

        return {
          passed: false,
          findings,
          latencyMs,
          timedOut: false,
          firewallCategoriesSkipped,
        };
      }
    }

    // No findings — write is clean
    return {
      passed: true,
      findings: [],
      latencyMs,
      timedOut: false,
      firewallCategoriesSkipped,
    };
  }

  /**
   * Get the default hardcoded vulnerability patterns.
   */
  static getDefaultPatterns(): VulnerabilityPattern[] {
    return [...VULNERABILITY_PATTERNS];
  }

  /**
   * Load vulnerability patterns from `.neuronest/security-patterns.json` in the project root.
   * Falls back to the existing hardcoded 15 patterns when the file is not present.
   *
   * The external file format is:
   * ```json
   * {
   *   "patterns": [
   *     {
   *       "pattern": "regex string",
   *       "category": "category-name",
   *       "severity": "critical|high|medium|low",
   *       "remediation": "how to fix",
   *       "blockedWrite": true
   *     }
   *   ]
   * }
   * ```
   *
   * Requirements: 25.2, 25.3, 25.4
   */
  static loadPatterns(projectRoot: string): VulnerabilityPattern[] {
    const patternsFilePath = path.join(projectRoot, CONFIG_DIR, PATTERNS_FILENAME);

    if (!existsSync(patternsFilePath)) {
      return [...VULNERABILITY_PATTERNS];
    }

    let rawContent: string;
    try {
      rawContent = readFileSync(patternsFilePath, 'utf-8');
    } catch (e) {
      throw new ConfigValidationError(
        `Failed to read security patterns file: ${e instanceof Error ? e.message : String(e)}`,
        'realtime-code-analyzer',
        'file',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      throw new ConfigValidationError(
        `Failed to parse security patterns JSON: ${e instanceof Error ? e.message : String(e)}`,
        'realtime-code-analyzer',
        'json',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigValidationError(
        'Security patterns file must contain a JSON object',
        'realtime-code-analyzer',
        'root',
      );
    }

    const parsedObj = parsed as Record<string, unknown>;

    if (!Array.isArray(parsedObj['patterns'])) {
      throw new ConfigValidationError(
        'Security patterns file must contain a "patterns" array',
        'realtime-code-analyzer',
        'patterns',
      );
    }

    return RealtimeCodeAnalyzer.validateExternalPatterns(parsedObj['patterns']);
  }

  /**
   * Validate and convert external pattern definitions to internal VulnerabilityPattern format.
   * Throws ConfigValidationError on invalid regex patterns or missing required fields.
   */
  private static validateExternalPatterns(rawPatterns: unknown[]): VulnerabilityPattern[] {
    const VALID_SEVERITIES = new Set<string>(['critical', 'high', 'medium', 'low']);
    const validated: VulnerabilityPattern[] = [];

    for (let i = 0; i < rawPatterns.length; i++) {
      const raw = rawPatterns[i];
      if (typeof raw !== 'object' || raw === null) {
        throw new ConfigValidationError(
          `Pattern at index ${i} must be an object`,
          'realtime-code-analyzer',
          `patterns[${i}]`,
        );
      }

      const entry = raw as Record<string, unknown>;

      // Validate required fields
      if (typeof entry['pattern'] !== 'string' || entry['pattern'].trim() === '') {
        throw new ConfigValidationError(
          `Pattern at index ${i} is missing required field "pattern" (must be a non-empty regex string)`,
          'realtime-code-analyzer',
          'pattern',
        );
      }

      if (typeof entry['category'] !== 'string' || entry['category'].trim() === '') {
        throw new ConfigValidationError(
          `Pattern at index ${i} is missing required field "category"`,
          'realtime-code-analyzer',
          'category',
        );
      }

      if (typeof entry['severity'] !== 'string' || !VALID_SEVERITIES.has(entry['severity'])) {
        throw new ConfigValidationError(
          `Pattern at index ${i} has invalid "severity" (must be one of: critical, high, medium, low)`,
          'realtime-code-analyzer',
          'severity',
        );
      }

      if (typeof entry['remediation'] !== 'string' || entry['remediation'].trim() === '') {
        throw new ConfigValidationError(
          `Pattern at index ${i} is missing required field "remediation"`,
          'realtime-code-analyzer',
          'remediation',
        );
      }

      // Validate regex compilation
      let compiledPattern: RegExp;
      try {
        compiledPattern = new RegExp(entry['pattern'], 'gi');
      } catch (e) {
        throw new ConfigValidationError(
          `Pattern at index ${i} contains invalid regex: ${e instanceof Error ? e.message : String(e)}`,
          'realtime-code-analyzer',
          'pattern',
        );
      }

      validated.push({
        id: typeof entry['id'] === 'string' ? entry['id'] : `external-${i}`,
        category: entry['category'],
        severity: entry['severity'] as ThreatSeverity,
        pattern: compiledPattern,
        message: typeof entry['message'] === 'string' ? entry['message'] : `${entry['category']} vulnerability detected`,
        remediation: entry['remediation'],
        confidence: typeof entry['confidence'] === 'number' && entry['confidence'] >= 0 && entry['confidence'] <= 1
          ? entry['confidence']
          : 0.7,
        coveredByFirewallCategories: Array.isArray(entry['coveredByFirewallCategories'])
          ? (entry['coveredByFirewallCategories'] as string[]).filter(c => typeof c === 'string')
          : [],
      });
    }

    return validated;
  }
}
