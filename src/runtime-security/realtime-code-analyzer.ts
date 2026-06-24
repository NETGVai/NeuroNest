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
import type { ThreatSeverity, SecurityLifecycleEvent } from './types.js';
import { LatencyBudgetExceededError } from './errors.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface RealtimeAnalysisFinding {
  id: string;
  severity: ThreatSeverity;
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
  /** FirewallEngine categories that cover this pattern */
  coveredByFirewallCategories: string[];
}

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
    coveredByFirewallCategories: [],
  },
  {
    id: 'sql-injection-format',
    category: 'sql-injection',
    severity: 'critical',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\s+.*(?:\+\s*(?:req\.|input|user|params)|`\s*\$\{(?:req\.|input|user|params))/gi,
    message: 'SQL statement constructed with user input',
    remediation: 'Use parameterized queries with placeholders ($1, ?, :param) instead of string interpolation',
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
    coveredByFirewallCategories: [],
  },
  {
    id: 'xss-document-write',
    category: 'xss',
    severity: 'high',
    pattern: /document\.write\s*\(/g,
    message: 'document.write can be exploited for XSS',
    remediation: 'Use DOM manipulation methods (createElement, appendChild) instead of document.write',
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
    coveredByFirewallCategories: ['unsafe-command'],
  },
  {
    id: 'command-injection-shell',
    category: 'command-injection',
    severity: 'critical',
    pattern: /child_process.*(?:exec|execSync)\s*\(\s*(?:.*\+|.*\$\{)/g,
    message: 'Shell command constructed with dynamic input',
    remediation: 'Use execFile or spawn with argument arrays instead of exec with string concatenation',
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
    coveredByFirewallCategories: [],
  },
  {
    id: 'path-traversal-dotdot',
    category: 'path-traversal',
    severity: 'medium',
    pattern: /(?:path\.join|path\.resolve)\s*\([^)]*(?:req\.|input|user|params|query|body)/gi,
    message: 'Path constructed with user input without traversal validation',
    remediation: 'After constructing the path, verify it starts with the expected base directory using path.relative()',
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
    coveredByFirewallCategories: ['secrets'],
  },
  {
    id: 'hardcoded-secret-password',
    category: 'hardcoded-secrets',
    severity: 'high',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{4,}['"`]/gi,
    message: 'Hardcoded password detected',
    remediation: 'Use environment variables or a secure credential store for passwords',
    coveredByFirewallCategories: ['secrets'],
  },
  {
    id: 'hardcoded-secret-token',
    category: 'hardcoded-secrets',
    severity: 'critical',
    pattern: /(?:token|bearer|auth_token|access_token)\s*[:=]\s*['"`][a-zA-Z0-9_\-\.]{20,}['"`]/gi,
    message: 'Hardcoded authentication token detected',
    remediation: 'Use environment variables or a token management system instead of hardcoding tokens',
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
    coveredByFirewallCategories: [],
  },
  {
    id: 'insecure-crypto-sha1',
    category: 'insecure-crypto',
    severity: 'medium',
    pattern: /createHash\s*\(\s*['"`]sha1['"`]\s*\)/g,
    message: 'SHA-1 is deprecated for security use and vulnerable to collision attacks',
    remediation: 'Use SHA-256 or SHA-3 for cryptographic hashing',
    coveredByFirewallCategories: [],
  },
  {
    id: 'insecure-crypto-ecb',
    category: 'insecure-crypto',
    severity: 'high',
    pattern: /createCipher(?:iv)?\s*\(\s*['"`](?:aes-\d+-ecb|des|des3|rc4)['"`]/gi,
    message: 'Insecure cipher mode or algorithm detected',
    remediation: 'Use AES-256-GCM or AES-256-CBC with proper IV for symmetric encryption',
    coveredByFirewallCategories: [],
  },
];

// ─── RealtimeCodeAnalyzer Class ─────────────────────────────────

export class RealtimeCodeAnalyzer {
  private readonly callbackEngine: CallbackEngine;
  private readonly firewall: FirewallInterface | null;
  private readonly maxLatencyMs: number;
  private readonly blockOnCriticalOnly: boolean;
  private hookHandler: ((context: unknown) => void) | null = null;

  constructor(
    callbackEngine: CallbackEngine,
    firewall: FirewallInterface | null,
    maxLatencyMs: number = 200,
    blockOnCriticalOnly: boolean = false,
  ) {
    this.callbackEngine = callbackEngine;
    this.firewall = firewall;
    this.maxLatencyMs = maxLatencyMs;
    this.blockOnCriticalOnly = blockOnCriticalOnly;
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

    for (const vulnPattern of VULNERABILITY_PATTERNS) {
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
}
