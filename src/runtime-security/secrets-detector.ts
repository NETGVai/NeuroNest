/**
 * Secrets Detection — Hardened secrets detection with entropy scoring.
 *
 * Provides Shannon-entropy scoring to catch high-entropy custom tokens beyond
 * pattern matching, optional live credential verification, full file history scanning,
 * and dummy value classification to reduce false positives.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4
 */

import { randomUUID } from 'node:crypto';
import type { ThreatSeverity } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SecretsDetectionConfig {
  /** Enable Shannon entropy scoring (default: true) */
  entropyScoring: boolean;
  /** Entropy threshold in bits/char (default: 4.5) */
  entropyThreshold: number;
  /** Minimum string length for entropy flagging (default: 16) */
  minEntropyLength: number;
  /** Enable live credential verification (default: false) */
  liveVerification: boolean;
  /** Scan full file history via git (default: true) */
  scanHistory: boolean;
}

export interface SecretFinding {
  id: string;
  severity: ThreatSeverity;
  pattern: string;
  matchedValue: string;
  file: string;
  line: number;
  /** Shannon entropy of the matched value */
  entropy: number;
  /** Whether the value matched a known dummy/example pattern */
  isDummy: boolean;
  /** Live verification result if enabled */
  verified?: boolean;
  confidence: number;
}

// ─── Known Secret Patterns ──────────────────────────────────────

interface SecretPattern {
  id: string;
  name: string;
  pattern: RegExp;
  severity: ThreatSeverity;
  /** Provider name for live verification */
  provider?: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'aws-access-key',
    name: 'AWS Access Key',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    severity: 'critical',
    provider: 'aws',
  },
  {
    id: 'github-token',
    name: 'GitHub Token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
    severity: 'critical',
    provider: 'github',
  },
  {
    id: 'stripe-key',
    name: 'Stripe API Key',
    pattern: /\b(sk_live_[0-9a-zA-Z]{24,99})\b/g,
    severity: 'critical',
    provider: 'stripe',
  },
  {
    id: 'openai-key',
    name: 'OpenAI API Key',
    pattern: /\b(sk-[A-Za-z0-9]{20,})\b/g,
    severity: 'critical',
    provider: 'openai',
  },
  {
    id: 'generic-api-key',
    name: 'Generic API Key',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key)\s*[:=]\s*['"`]([a-zA-Z0-9_\-]{20,})['"`]/gi,
    severity: 'high',
  },
  {
    id: 'generic-token',
    name: 'Generic Token',
    pattern: /(?:token|bearer|auth_token|access_token)\s*[:=]\s*['"`]([a-zA-Z0-9_\-\.]{20,})['"`]/gi,
    severity: 'high',
  },
  {
    id: 'generic-password',
    name: 'Hardcoded Password',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`]([^'"`]{8,})['"`]/gi,
    severity: 'high',
  },
  {
    id: 'private-key',
    name: 'Private Key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'critical',
  },
];

// ─── Dummy/Example Value Patterns ───────────────────────────────

const DUMMY_PATTERNS: RegExp[] = [
  /^sk[-_]test[-_]/i,
  /^pk[-_]test[-_]/i,
  /^your[-_]?(?:api)?[-_]?key[-_]?here$/i,
  /^(?:example|sample|test|demo|dummy|fake|placeholder|replace[-_]?me)/i,
  /[-_](?:example|sample|test|demo|dummy|fake|placeholder)$/i,
  /^xxx+$/i,
  /^0{16,}$/,
  /^1234567890/,
  /^abcdef/i,
  /^(?:insert|put|add)[-_]?(?:your|api)[-_]?(?:key|token|secret)[-_]?here$/i,
  /^AKIA[X]{12,}$/,  // Fake AWS keys with placeholder X chars
  /^sk[-_]live[-_]x{10,}$/i, // Fake Stripe keys
  /^ghp_[x]{36}$/i, // Fake GitHub PATs
  /\bplaceholder\b/i,
  /\bchangeme\b/i,
  /\bTODO\b/i,
  /^<.*>$/, // Placeholder like <YOUR_API_KEY>
];

// ─── Live Verification Interface ────────────────────────────────

export interface CredentialVerifier {
  verify(provider: string, credential: string): Promise<boolean>;
}

// ─── Git History Scanner Interface ──────────────────────────────

export interface GitHistoryScanner {
  getFullFileHistory(filePath: string): Promise<string[]>;
}

// ─── SecretsDetector Class ──────────────────────────────────────

export class SecretsDetector {
  private readonly config: SecretsDetectionConfig;
  private readonly credentialVerifier: CredentialVerifier | undefined;
  private readonly gitScanner: GitHistoryScanner | undefined;

  constructor(
    config?: Partial<SecretsDetectionConfig>,
    credentialVerifier?: CredentialVerifier,
    gitScanner?: GitHistoryScanner,
  ) {
    this.config = {
      entropyScoring: config?.entropyScoring ?? true,
      entropyThreshold: config?.entropyThreshold ?? 4.5,
      minEntropyLength: config?.minEntropyLength ?? 16,
      liveVerification: config?.liveVerification ?? false,
      scanHistory: config?.scanHistory ?? true,
    };
    this.credentialVerifier = credentialVerifier ?? undefined;
    this.gitScanner = gitScanner ?? undefined;
  }

  /**
   * Calculate Shannon entropy for a string.
   *
   * Shannon entropy is: -Σ(p_i * log2(p_i)) for each unique character's
   * frequency p_i in the string. Returns bits per character.
   *
   * Higher entropy indicates more randomness (likely a secret).
   * English text typically has 3.5-4.5 bits/char.
   * Random tokens typically have >4.5 bits/char.
   */
  calculateEntropy(value: string): number {
    if (value.length === 0) {
      return 0;
    }

    // Count character frequencies
    const frequencies = new Map<string, number>();
    for (const char of value) {
      frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    }

    const length = value.length;
    let entropy = 0;

    for (const count of frequencies.values()) {
      const p = count / length;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Check if a value matches known dummy/example patterns.
   *
   * Always returns true for values that are clearly placeholders, test values,
   * or example strings — regardless of any configuration setting.
   * This ensures dummy values are always classified as informational to reduce
   * false-positive friction.
   *
   * Requirements: 14.4
   */
  isDummyValue(value: string): boolean {
    return DUMMY_PATTERNS.some(pattern => pattern.test(value));
  }

  /**
   * Detect secrets in file content.
   *
   * Performs pattern matching, entropy scoring, dummy value classification,
   * optional live credential verification, and optional full file history scanning.
   *
   * Requirements: 14.1, 14.2, 14.3, 14.4
   */
  async detect(filePath: string, content: string): Promise<SecretFinding[]> {
    const findings: SecretFinding[] = [];

    // Collect all content to scan (current + history if enabled)
    const contentsToScan: Array<{ content: string; isHistory: boolean }> = [
      { content, isHistory: false },
    ];

    // Scan full file history if enabled (Requirement 14.3)
    if (this.config.scanHistory && this.gitScanner) {
      try {
        const historicalContents = await this.gitScanner.getFullFileHistory(filePath);
        for (const histContent of historicalContents) {
          contentsToScan.push({ content: histContent, isHistory: true });
        }
      } catch {
        // If git history scanning fails, continue with current content only
      }
    }

    for (const { content: scanContent, isHistory } of contentsToScan) {
      const lines = scanContent.split('\n');

      // 1. Pattern-based detection
      for (const secretPattern of SECRET_PATTERNS) {
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]!;
          // Reset regex lastIndex for global patterns
          secretPattern.pattern.lastIndex = 0;
          let match: RegExpExecArray | null;

          while ((match = secretPattern.pattern.exec(line)) !== null) {
            const matchedValue = (match[1] ?? match[0]) as string;
            const entropy = this.calculateEntropy(matchedValue);
            const isDummy = this.isDummyValue(matchedValue);

            // Always classify dummy values as informational (Requirement 14.4)
            let severity: ThreatSeverity = isDummy ? 'low' : secretPattern.severity;
            let verified: boolean | undefined;

            // Optional live credential verification (Requirement 14.2)
            if (
              this.config.liveVerification &&
              this.credentialVerifier &&
              secretPattern.provider &&
              !isDummy
            ) {
              try {
                const isValid = await this.credentialVerifier.verify(
                  secretPattern.provider,
                  matchedValue,
                );
                verified = isValid;
                // Downgrade to informational if credential fails authentication
                if (!isValid) {
                  severity = 'low';
                }
              } catch {
                // If verification fails, keep the original severity
                verified = undefined;
              }
            }

            const finding: SecretFinding = {
              id: randomUUID(),
              severity,
              pattern: secretPattern.id,
              matchedValue: redactValue(matchedValue),
              file: filePath,
              line: lineIdx + 1,
              entropy,
              isDummy,
              confidence: isDummy ? 0.2 : verified === true ? 1.0 : 0.7,
            };
            if (verified !== undefined) {
              finding.verified = verified;
            }
            findings.push(finding);
          }
        }
      }

      // 2. Entropy-based detection (Requirement 14.1)
      if (this.config.entropyScoring) {
        const entropyFindings = this.detectHighEntropyStrings(lines, filePath, findings, isHistory);
        findings.push(...entropyFindings);
      }
    }

    // Deduplicate findings (same pattern + same line in current vs history)
    return deduplicateFindings(findings);
  }

  /**
   * Detect high-entropy strings that don't match known patterns.
   * Flags strings with >entropyThreshold bits/char and length >minEntropyLength.
   */
  private detectHighEntropyStrings(
    lines: string[],
    filePath: string,
    existingFindings: SecretFinding[],
    _isHistory: boolean,
  ): SecretFinding[] {
    const findings: SecretFinding[] = [];

    // Extract string literals from each line
    const stringLiteralPattern = /['"`]([^'"`\n]{17,})['"`]/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      stringLiteralPattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = stringLiteralPattern.exec(line)) !== null) {
        const value = match[1];
        if (!value) {
          continue;
        }

        // Skip if already caught by pattern-based detection
        const alreadyFound = existingFindings.some(
          f => f.line === lineIdx + 1 && f.file === filePath,
        );
        if (alreadyFound) {
          continue;
        }

        // Check length threshold
        if (value.length <= this.config.minEntropyLength) {
          continue;
        }

        // Calculate entropy
        const entropy = this.calculateEntropy(value);

        // Flag if entropy exceeds threshold (Requirement 14.1)
        if (entropy > this.config.entropyThreshold) {
          const isDummy = this.isDummyValue(value);

          // Always classify dummy values as informational (Requirement 14.4)
          const severity: ThreatSeverity = isDummy ? 'low' : 'high';

          findings.push({
            id: randomUUID(),
            severity,
            pattern: 'high-entropy-string',
            matchedValue: redactValue(value),
            file: filePath,
            line: lineIdx + 1,
            entropy,
            isDummy,
            confidence: isDummy ? 0.2 : 0.6,
          });
        }
      }
    }

    return findings;
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Redact a secret value for safe storage/display.
 * Shows first 4 and last 4 characters with middle replaced by asterisks.
 */
function redactValue(value: string): string {
  if (value.length <= 8) {
    return '****';
  }
  const prefix = value.slice(0, 4);
  const suffix = value.slice(-4);
  return `${prefix}${'*'.repeat(Math.min(value.length - 8, 20))}${suffix}`;
}

/**
 * Deduplicate findings based on pattern + file + line combination.
 * Keeps the finding with the higher severity.
 */
function deduplicateFindings(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Map<string, SecretFinding>();
  const severityOrder: Record<ThreatSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  for (const finding of findings) {
    const key = `${finding.pattern}:${finding.file}:${finding.line}`;
    const existing = seen.get(key);
    if (!existing || severityOrder[finding.severity] > severityOrder[existing.severity]) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}
