/**
 * ComplianceGateRunner — Automated regulatory compliance checks on agent-generated code.
 *
 * Runs configured compliance rule sets (PCI-DSS, HIPAA, GDPR) against code changes
 * before marking a task complete. Produces an audit trail of all checks with pass/fail
 * results stored in the ExecutionTraceService SQLite database.
 *
 * Key behaviors:
 * - check() runs all active compliance rule sets against changed files
 * - PCI-DSS rules: detect plaintext credentials, unencrypted sensitive data storage
 * - HIPAA rules: detect PHI access without logging, overly broad data access
 * - GDPR rules: detect missing consent tracking, missing data deletion capability
 * - Configurable rule severity (critical vs warning)
 * - Support for custom user-defined rules
 * - Blocks task completion on critical violations with remediation guidance
 * - Audit trail persisted in compliance_audits SQLite table
 * - No-op when feature gate is disabled (zero overhead)
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Supported compliance standards */
export type ComplianceStandard = 'pci-dss' | 'hipaa' | 'gdpr';

/** Severity levels for compliance violations */
export type ViolationSeverity = 'critical' | 'warning';

/** A single compliance violation found in code */
export interface ComplianceViolation {
  /** Which standard this violation belongs to */
  standard: ComplianceStandard;
  /** Unique identifier for the rule that was violated */
  ruleId: string;
  /** Severity of the violation */
  severity: ViolationSeverity;
  /** File path where the violation was found */
  file: string;
  /** Line number of the violation (1-indexed) */
  line: number;
  /** Description of the violation */
  message: string;
  /** Actionable guidance on how to fix the violation */
  remediation: string;
}

/** Result of running one compliance standard's rule set against files */
export interface ComplianceResult {
  /** Which standard was checked */
  standard: ComplianceStandard;
  /** Whether all rules passed (no critical violations) */
  passed: boolean;
  /** List of violations found (may include warnings even if passed=true) */
  violations: ComplianceViolation[];
  /** ISO 8601 timestamp when the check was performed */
  checkedAt: string;
}

/** Full compliance report across all active standards */
export interface ComplianceReport {
  /** Session ID this report belongs to */
  sessionId: string;
  /** Results per standard */
  results: ComplianceResult[];
  /** Overall pass/fail — fails if any standard has critical violations */
  overallPassed: boolean;
  /** Timestamp of the report */
  checkedAt: string;
}

/** A single compliance rule definition */
export interface ComplianceRule {
  /** Unique rule identifier (e.g., 'pci-dss-001') */
  id: string;
  /** Which standard this rule belongs to */
  standard: ComplianceStandard;
  /** Severity level */
  severity: ViolationSeverity;
  /** Human-readable description of what the rule checks */
  description: string;
  /** Regex pattern to match against file content (line-by-line unless multiLine is true) */
  pattern: RegExp;
  /** Remediation guidance shown when rule is violated */
  remediation: string;
  /** Whether this rule is enabled */
  enabled: boolean;
  /**
   * If true, the pattern is checked against the full file content rather than line-by-line.
   * Useful for rules that need to check relationships across multiple lines (e.g., class has delete method).
   */
  multiLine?: boolean;
  /**
   * If provided, the rule only triggers when this pattern does NOT match anywhere in the file content.
   * Used for rules like "personal data stored without consent check" where the absence of a
   * safeguard (consent) anywhere in the file indicates a violation.
   */
  negationPattern?: RegExp;
}

/** Configuration for the ComplianceGateRunner */
export interface ComplianceGateConfig {
  /** Which standards are active for this project */
  activeStandards: ComplianceStandard[];
  /** Optional custom rules to add to built-in rule sets */
  customRules?: ComplianceRule[];
  /** Override severity for specific rule IDs */
  severityOverrides?: Record<string, ViolationSeverity>;
  /** Rule IDs to disable */
  disabledRules?: string[];
}

/**
 * Minimal interface for ExecutionTraceService dependency.
 * Only needs audit record insertion for compliance audit trail.
 */
export interface ComplianceTraceServiceLike {
  addComplianceAudit?(audit: {
    id: string;
    sessionId: string;
    standard: string;
    passed: boolean;
    violations: string; // JSON-encoded
    checkedAt: string;
  }): void;
}

// ─── SQL ─────────────────────────────────────────────────────────

/** SQL to create the compliance_audits table */
export const COMPLIANCE_AUDITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS compliance_audits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  standard TEXT NOT NULL,
  passed INTEGER NOT NULL,
  violations TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_session ON compliance_audits(session_id);
CREATE INDEX IF NOT EXISTS idx_compliance_standard ON compliance_audits(standard);
`.trim();

// ─── Built-in Rule Sets ─────────────────────────────────────────

/**
 * PCI-DSS rules: Focus on card data handling.
 * - No plaintext credit card numbers
 * - No hardcoded credentials/secrets
 * - Encrypted data at rest patterns
 */
const PCI_DSS_RULES: ComplianceRule[] = [
  {
    id: 'pci-dss-001',
    standard: 'pci-dss',
    severity: 'critical',
    description: 'Plaintext credit card number pattern detected',
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
    remediation: 'Never store or log credit card numbers in plaintext. Use a tokenization service or PCI-compliant payment processor. Mask card numbers (e.g., ****1234) in logs.',
    enabled: true,
  },
  {
    id: 'pci-dss-002',
    standard: 'pci-dss',
    severity: 'critical',
    description: 'Hardcoded credential or secret detected',
    pattern: /(?:password|secret|api_key|apikey|api_secret|private_key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    remediation: 'Never hardcode credentials in source code. Use environment variables, a secrets manager, or the CredentialVault to inject secrets at runtime.',
    enabled: true,
  },
  {
    id: 'pci-dss-003',
    standard: 'pci-dss',
    severity: 'warning',
    description: 'Sensitive data stored without encryption',
    pattern: /(?:writeFile|fs\.write|localStorage\.set|sessionStorage\.set).*(?:card|cvv|pan|credit|ssn|social_security)/i,
    remediation: 'Encrypt sensitive data before writing to disk or local storage. Use AES-256-GCM or equivalent symmetric encryption for data at rest.',
    enabled: true,
  },
  {
    id: 'pci-dss-004',
    standard: 'pci-dss',
    severity: 'warning',
    description: 'Logging potentially sensitive financial data',
    pattern: /(?:console\.log|logger\.|log\.).*(?:card|cvv|pan|credit_card|cardNumber|card_number)/i,
    remediation: 'Do not log sensitive cardholder data. Mask or redact card numbers and CVVs before logging. Use structured logging with field-level redaction.',
    enabled: true,
  },
];

/**
 * HIPAA rules: Focus on Protected Health Information (PHI) handling.
 * - PHI access must be logged/audited
 * - Minimum necessary access principle
 */
const HIPAA_RULES: ComplianceRule[] = [
  {
    id: 'hipaa-001',
    standard: 'hipaa',
    severity: 'critical',
    description: 'PHI data access without audit logging',
    pattern: /(?:patient|medical_record|diagnosis|treatment|health_info|phi_data|medical_history).*(?:find|get|query|select|fetch|read)(?!.*(?:audit|log|track))/i,
    remediation: 'All access to Protected Health Information (PHI) must be logged with who accessed it, when, and why. Add audit logging before any PHI read operation.',
    enabled: true,
  },
  {
    id: 'hipaa-002',
    standard: 'hipaa',
    severity: 'critical',
    description: 'Overly broad PHI data query (minimum necessary violation)',
    pattern: /SELECT\s+\*\s+FROM\s+\w*(?:patient|medical|health|diagnosis|treatment|record)\w*/i,
    remediation: 'Follow the minimum necessary principle: only query the specific PHI fields needed for the task. Replace SELECT * with explicit column selection.',
    enabled: true,
  },
  {
    id: 'hipaa-003',
    standard: 'hipaa',
    severity: 'warning',
    description: 'PHI transmitted without encryption indication',
    pattern: /(?:http:\/\/).*(?:patient|medical|health|phi|diagnosis)/i,
    remediation: 'PHI must be encrypted in transit. Use HTTPS (TLS 1.2+) for all PHI transmission. Never send PHI over unencrypted HTTP connections.',
    enabled: true,
  },
  {
    id: 'hipaa-004',
    standard: 'hipaa',
    severity: 'warning',
    description: 'PHI stored without access control check',
    pattern: /(?:save|store|write|insert|put).*(?:patient|medical_record|diagnosis|health_info|phi)(?!.*(?:auth|permission|role|access_control|rbac))/i,
    remediation: 'Implement role-based access control (RBAC) for all PHI storage operations. Verify the requesting user has appropriate authorization before persisting PHI.',
    enabled: true,
  },
];

/**
 * GDPR rules: Focus on personal data handling.
 * - Consent tracking required
 * - Data deletion capability (right to erasure)
 */
const GDPR_RULES: ComplianceRule[] = [
  {
    id: 'gdpr-001',
    standard: 'gdpr',
    severity: 'critical',
    description: 'Personal data collection without consent check',
    pattern: /(?:collect|gather|store|save|persist)[\s\S]*?(?:personal_data|user_data|email|phone|address)/i,
    negationPattern: /(?:consent|gdpr_consent|has_consent|check_consent)/i,
    remediation: 'Under GDPR, personal data collection requires explicit user consent. Add a consent verification check before collecting or storing personal data.',
    enabled: true,
    multiLine: true,
  },
  {
    id: 'gdpr-002',
    standard: 'gdpr',
    severity: 'critical',
    description: 'Missing data deletion capability (right to erasure)',
    pattern: /(?:class|interface)\s+\w*(?:User|Person|Customer|Profile)\w*\s*\{(?![\s\S]*?(?:delete|remove|erase|purge))/i,
    remediation: 'GDPR Article 17 requires the right to erasure. Implement a delete/erase method for any entity storing personal data to support data subject deletion requests.',
    enabled: true,
    multiLine: true,
  },
  {
    id: 'gdpr-003',
    standard: 'gdpr',
    severity: 'warning',
    description: 'Personal data retention without expiry mechanism',
    pattern: /(?:store|save|persist|cache).*(?:personal_data|user_data|pii)(?!.*(?:ttl|expir|retention|purge_after))/i,
    remediation: 'GDPR requires data minimization and storage limitation. Set a retention period (TTL) for personal data and implement automatic purging after the retention period.',
    enabled: true,
  },
  {
    id: 'gdpr-004',
    standard: 'gdpr',
    severity: 'warning',
    description: 'Cross-border data transfer without adequacy check',
    pattern: /(?:transfer|send|export|replicate).*(?:personal_data|user_data|pii).*(?:region|country|zone|international)/i,
    remediation: 'GDPR restricts cross-border data transfers. Verify adequacy decisions, standard contractual clauses, or binding corporate rules are in place before transferring personal data internationally.',
    enabled: true,
  },
];

// ─── ComplianceGateRunner Class ─────────────────────────────────

export class ComplianceGateRunner {
  /** Active standards to check */
  private readonly activeStandards: ComplianceStandard[];

  /** All rules (built-in + custom), keyed by standard */
  private readonly rulesByStandard: Map<ComplianceStandard, ComplianceRule[]>;

  /** Optional trace service for audit trail persistence */
  private readonly traceService: ComplianceTraceServiceLike | null;

  constructor(
    config: ComplianceGateConfig,
    traceService: ComplianceTraceServiceLike | null = null,
  ) {
    this.activeStandards = config.activeStandards;
    this.traceService = traceService;

    // Build rule set from built-in rules + custom rules (deep clone to avoid shared state mutation)
    this.rulesByStandard = new Map();
    this.rulesByStandard.set('pci-dss', PCI_DSS_RULES.map((r) => ({ ...r })));
    this.rulesByStandard.set('hipaa', HIPAA_RULES.map((r) => ({ ...r })));
    this.rulesByStandard.set('gdpr', GDPR_RULES.map((r) => ({ ...r })));

    // Add custom rules
    if (config.customRules) {
      for (const rule of config.customRules) {
        const existing = this.rulesByStandard.get(rule.standard) ?? [];
        existing.push(rule);
        this.rulesByStandard.set(rule.standard, existing);
      }
    }

    // Apply severity overrides
    if (config.severityOverrides) {
      for (const [ruleId, severity] of Object.entries(config.severityOverrides)) {
        for (const rules of this.rulesByStandard.values()) {
          const rule = rules.find((r) => r.id === ruleId);
          if (rule) {
            rule.severity = severity;
          }
        }
      }
    }

    // Apply disabled rules
    if (config.disabledRules) {
      for (const ruleId of config.disabledRules) {
        for (const rules of this.rulesByStandard.values()) {
          const rule = rules.find((r) => r.id === ruleId);
          if (rule) {
            rule.enabled = false;
          }
        }
      }
    }
  }

  /**
   * Run all active compliance rule sets against the specified changed files.
   *
   * Reads each file, runs line-by-line pattern matching against all enabled rules
   * for each active standard, and returns compliance results per standard.
   *
   * A standard passes only if it has no critical violations (warnings are allowed).
   *
   * Requirements: 27.1, 27.2, 27.3
   */
  async check(changedFiles: string[], sessionId?: string): Promise<ComplianceReport> {
    const now = new Date().toISOString();
    const results: ComplianceResult[] = [];

    for (const standard of this.activeStandards) {
      const rules = this.rulesByStandard.get(standard) ?? [];
      const enabledRules = rules.filter((r) => r.enabled);
      const violations: ComplianceViolation[] = [];

      for (const filePath of changedFiles) {
        const fileViolations = this.checkFile(filePath, enabledRules, standard);
        violations.push(...fileViolations);
      }

      // A standard passes if it has no critical violations
      const hasCriticalViolation = violations.some((v) => v.severity === 'critical');
      const result: ComplianceResult = {
        standard,
        passed: !hasCriticalViolation,
        violations,
        checkedAt: now,
      };
      results.push(result);

      // Persist audit trail if trace service available
      if (this.traceService?.addComplianceAudit && sessionId) {
        this.traceService.addComplianceAudit({
          id: randomUUID(),
          sessionId,
          standard,
          passed: result.passed,
          violations: JSON.stringify(violations),
          checkedAt: now,
        });
      }
    }

    const overallPassed = results.every((r) => r.passed);

    return {
      sessionId: sessionId ?? 'unknown',
      results,
      overallPassed,
      checkedAt: now,
    };
  }

  /**
   * Get the list of active standards configured for this runner.
   */
  getActiveStandards(): ComplianceStandard[] {
    return [...this.activeStandards];
  }

  /**
   * Get all rules for a specific standard (including disabled ones).
   */
  getRulesForStandard(standard: ComplianceStandard): ComplianceRule[] {
    return [...(this.rulesByStandard.get(standard) ?? [])];
  }

  /**
   * Get all enabled rules across all standards.
   */
  getAllEnabledRules(): ComplianceRule[] {
    const allRules: ComplianceRule[] = [];
    for (const rules of this.rulesByStandard.values()) {
      allRules.push(...rules.filter((r) => r.enabled));
    }
    return allRules;
  }

  /**
   * Get the SQL statement to create the compliance_audits table.
   */
  static getTableCreationSQL(): string {
    return COMPLIANCE_AUDITS_TABLE_SQL;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check a single file against a set of rules.
   * Reads the file content and checks each line against line-based rules,
   * and the full content against multi-line rules.
   */
  private checkFile(
    filePath: string,
    rules: ComplianceRule[],
    standard: ComplianceStandard,
  ): ComplianceViolation[] {
    const violations: ComplianceViolation[] = [];

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // File doesn't exist or can't be read — skip without failing
      return violations;
    }

    // Separate line-based and multi-line rules
    const lineRules = rules.filter((r) => !r.multiLine);
    const multiLineRules = rules.filter((r) => r.multiLine);

    // Check multi-line rules against full content
    for (const rule of multiLineRules) {
      // If rule has a negationPattern, skip this rule if negation matches (safeguard is present)
      if (rule.negationPattern && rule.negationPattern.test(content)) {
        continue;
      }
      if (rule.pattern.test(content)) {
        // Find the approximate line number (first occurrence)
        const match = content.match(rule.pattern);
        let lineNum = 1;
        if (match && match.index !== undefined) {
          lineNum = content.substring(0, match.index).split('\n').length;
        }
        violations.push({
          standard,
          ruleId: rule.id,
          severity: rule.severity,
          file: filePath,
          line: lineNum,
          message: rule.description,
          remediation: rule.remediation,
        });
      }
    }

    // Check line-based rules
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      // Skip empty lines and pure comments for performance
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }

      for (const rule of lineRules) {
        if (rule.pattern.test(line)) {
          violations.push({
            standard,
            ruleId: rule.id,
            severity: rule.severity,
            file: filePath,
            line: lineIndex + 1, // 1-indexed
            message: rule.description,
            remediation: rule.remediation,
          });
        }
      }
    }

    return violations;
  }

  /**
   * Check content string directly (for testing or in-memory code analysis).
   * Useful when file content is already available without filesystem access.
   */
  checkContent(
    content: string,
    filePath: string,
    standard: ComplianceStandard,
  ): ComplianceViolation[] {
    const rules = (this.rulesByStandard.get(standard) ?? []).filter((r) => r.enabled);
    const violations: ComplianceViolation[] = [];

    // Separate line-based and multi-line rules
    const lineRules = rules.filter((r) => !r.multiLine);
    const multiLineRules = rules.filter((r) => r.multiLine);

    // Check multi-line rules against full content
    for (const rule of multiLineRules) {
      // If rule has a negationPattern, skip this rule if negation matches (safeguard is present)
      if (rule.negationPattern && rule.negationPattern.test(content)) {
        continue;
      }
      if (rule.pattern.test(content)) {
        const match = content.match(rule.pattern);
        let lineNum = 1;
        if (match && match.index !== undefined) {
          lineNum = content.substring(0, match.index).split('\n').length;
        }
        violations.push({
          standard,
          ruleId: rule.id,
          severity: rule.severity,
          file: filePath,
          line: lineNum,
          message: rule.description,
          remediation: rule.remediation,
        });
      }
    }

    // Check line-based rules
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trim();

      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }

      for (const rule of lineRules) {
        if (rule.pattern.test(line)) {
          violations.push({
            standard,
            ruleId: rule.id,
            severity: rule.severity,
            file: filePath,
            line: lineIndex + 1,
            message: rule.description,
            remediation: rule.remediation,
          });
        }
      }
    }

    return violations;
  }
}
