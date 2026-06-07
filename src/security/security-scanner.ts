/**
 * SecurityScanner — scans project source files for vulnerability patterns.
 *
 * Reuses FirewallEngine Tier 2 rules for secrets detection and adds
 * code-pattern rules (extended tier) and paranoid-tier rules.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 10.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FirewallEngine } from '../firewall/firewall-engine';
import { logger } from '../utils/logger.js';
import type {
  ScanFinding,
  ScanSummary,
  ScanResult,
  ScanOptions,
  ScannerRule,
  ScanTier,
  Severity,
  ScannerHealthEntry,
  ScannerHealthReport,
} from './types';

// ─── Constants ──────────────────────────────────────────────────

const MAX_FILE_SIZE = 1_048_576; // 1 MB
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.gif', '.ico', '.woff', '.ttf',
  '.zip', '.tar', '.gz',
]);

// ─── SecurityScanner ────────────────────────────────────────────

export class SecurityScanner {
  private rules: ScannerRule[] = [];
  private insertScanStmt: Database.Statement | null = null;
  private insertFindingStmt: Database.Statement | null = null;
  private selectScansStmt: Database.Statement | null = null;
  private selectFindingsStmt: Database.Statement | null = null;

  constructor(
    private db: Database.Database | null,
    private firewallEngine: FirewallEngine,
  ) {
    this.rules = this.buildRuleSet();
    this.prepareStatements();
  }

  /**
   * Prepare reusable SQL statements for scan persistence.
   * If db is null, statements remain null and DB operations are skipped.
   */
  private prepareStatements(): void {
    if (!this.db) return;
    try {
      this.insertScanStmt = this.db.prepare(
        `INSERT INTO scan_results (id, project_id, tier, total_files, total_findings, findings_low, findings_medium, findings_high, findings_critical, suppressed_count, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.insertFindingStmt = this.db.prepare(
        `INSERT INTO scan_findings (scan_id, file_path, line, col, rule_id, rule_name, severity, category, description, remediation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.selectScansStmt = this.db.prepare(
        `SELECT id, project_id, tier, total_files, total_findings, findings_low, findings_medium, findings_high, findings_critical, suppressed_count, duration_ms, created_at
         FROM scan_results WHERE project_id = ? ORDER BY created_at DESC`,
      );
      this.selectFindingsStmt = this.db.prepare(
        `SELECT file_path, line, col, rule_id, rule_name, severity, category, description, remediation
         FROM scan_findings WHERE scan_id = ?`,
      );
    } catch (err) {
      logger.error('SecurityScanner: failed to prepare DB statements', { error: String(err) });
    }
  }

  /** Expose rules for testing */
  getRules(): ScannerRule[] {
    return this.rules;
  }

  /**
   * Build the full rule set:
   * - Import Tier 2 (secrets) rules from FirewallEngine → all tiers
   * - Add code-pattern rules cp-01..cp-05 → extended + paranoid
   * - Add paranoid rules dep-01, cfg-01 → paranoid only
   */
  buildRuleSet(): ScannerRule[] {
    const rules: ScannerRule[] = [];

    // Import Tier 2 (secrets) rules from FirewallEngine
    const fwRules = this.firewallEngine
      .getRules()
      .filter((r) => r.tier === 2 && r.enabled);

    for (const fwRule of fwRules) {
      if (!fwRule.pattern) continue;
      const flags = fwRule.pattern.startsWith('(?i)') ? 'gi' : 'g';
      const cleanPattern = fwRule.pattern.replace(/^\(\?i\)/, '');
      rules.push({
        id: fwRule.id,
        name: fwRule.name,
        pattern: new RegExp(cleanPattern, flags),
        severity: fwRule.severity as Severity,
        category: 'secrets',
        description: fwRule.description,
        remediation: `Remove or externalize the detected ${fwRule.name.toLowerCase()}.`,
        tiers: ['minimal', 'extended', 'paranoid'],
      });
    }

    // Extended tier: code pattern rules
    rules.push(
      {
        id: 'cp-01',
        name: 'SQL Injection',
        tiers: ['extended', 'paranoid'],
        pattern: /(\bexec\b|\bquery\b)\s*\(\s*[`'"].*\$\{/gi,
        severity: 'high',
        category: 'injection',
        description:
          'Potential SQL injection via string interpolation in query.',
        remediation:
          'Use parameterized queries instead of string interpolation.',
      },
      {
        id: 'cp-02',
        name: 'XSS Vector',
        tiers: ['extended', 'paranoid'],
        pattern: /\.innerHTML\s*=|document\.write\s*\(/gi,
        severity: 'high',
        category: 'xss',
        description: 'Potential XSS via direct DOM manipulation.',
        remediation: 'Use textContent or a sanitization library.',
      },
      {
        id: 'cp-03',
        name: 'Command Injection',
        tiers: ['extended', 'paranoid'],
        pattern: /child_process.*exec\s*\(|execSync\s*\(/gi,
        severity: 'critical',
        category: 'injection',
        description:
          'Potential command injection via child_process exec.',
        remediation:
          'Use execFile with explicit arguments instead of exec.',
      },
      {
        id: 'cp-04',
        name: 'Path Traversal',
        tiers: ['extended', 'paranoid'],
        pattern: /\.\.\//g,
        severity: 'medium',
        category: 'path-traversal',
        description: 'Potential path traversal pattern detected.',
        remediation: 'Validate and normalize file paths before use.',
      },
      {
        id: 'cp-05',
        name: 'Insecure Randomness',
        tiers: ['extended', 'paranoid'],
        pattern: /Math\.random\s*\(\)/g,
        severity: 'medium',
        category: 'crypto',
        description: 'Math.random() is not cryptographically secure.',
        remediation:
          'Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.',
      },
    );

    // Paranoid tier: dependency and config rules
    rules.push(
      {
        id: 'dep-01',
        name: 'Known Vulnerable Dependency',
        tiers: ['paranoid'],
        pattern:
          /("event-stream"|"ua-parser-js"|"colors"|"faker")\s*:/gi,
        severity: 'high',
        category: 'dependency',
        description:
          'Package has known supply-chain vulnerability history.',
        remediation: 'Review dependency and consider alternatives.',
      },
      {
        id: 'cfg-01',
        name: 'Insecure Configuration',
        tiers: ['paranoid'],
        pattern:
          /("nodeIntegration"\s*:\s*true|"contextIsolation"\s*:\s*false)/gi,
        severity: 'critical',
        category: 'config',
        description: 'Insecure Electron configuration detected.',
        remediation:
          'Set nodeIntegration: false and contextIsolation: true.',
      },
    );

    return rules;
  }

  /**
   * Enumerate scannable files under projectPath.
   * Skips: node_modules, .git, dist, build, .next directories,
   * binary file extensions, and files > 1 MB.
   */
  enumerateFiles(projectPath: string): string[] {
    const files: string[] = [];

    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // skip unreadable directories
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTS.has(ext)) continue;
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              files.push(fullPath);
            }
          } catch {
            // skip files we can't stat
          }
        }
      }
    }

    walk(projectPath);
    return files;
  }

  /**
   * Scan a single file line-by-line against tier-filtered rules.
   * Returns all findings for the file.
   */
  scanFile(
    filePath: string,
    projectRoot: string,
    tier: ScanTier,
  ): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const activeRules = this.rules.filter((r) => r.tiers.includes(tier));

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return findings; // skip unreadable files
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of activeRules) {
        // Reset regex lastIndex for global patterns
        rule.pattern.lastIndex = 0;
        let match = rule.pattern.exec(line);
        while (match !== null) {
          findings.push({
            filePath: path.relative(projectRoot, filePath),
            line: i + 1,
            column: match.index,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: rule.category,
            description: rule.description,
            remediation: rule.remediation,
          });
          match = rule.pattern.exec(line);
        }
      }
    }

    return findings;
  }

  /**
   * Apply baseline delta filtering.
   * Parses a baseline SARIF file and returns only findings
   * not present in the baseline (by ruleId, filePath, line, column identity).
   *
   * Requirements: 2.9
   */
  applyBaseline(
    findings: ScanFinding[],
    baselinePath: string,
  ): ScanFinding[] {
    let baselineDoc: {
      runs?: Array<{
        results?: Array<{
          ruleId?: string;
          locations?: Array<{
            physicalLocation?: {
              artifactLocation?: { uri?: string };
              region?: { startLine?: number; startColumn?: number };
            };
          }>;
        }>;
      }>;
    };

    try {
      const raw = fs.readFileSync(baselinePath, 'utf-8');
      baselineDoc = JSON.parse(raw);
    } catch {
      // File doesn't exist or can't be parsed — return findings unchanged
      return findings;
    }

    const baselineKeys = new Set<string>();

    const results = baselineDoc?.runs?.[0]?.results;
    if (Array.isArray(results)) {
      for (const result of results) {
        const ruleId = result.ruleId ?? '';
        const loc = result.locations?.[0]?.physicalLocation;
        const filePath = loc?.artifactLocation?.uri ?? '';
        const line = loc?.region?.startLine ?? 0;
        const column = loc?.region?.startColumn ?? 0;
        baselineKeys.add(`${ruleId}|${filePath}|${line}|${column}`);
      }
    }

    return findings.filter((f) => {
      const key = `${f.ruleId}|${f.filePath}|${f.line}|${f.column}`;
      return !baselineKeys.has(key);
    });
  }

  /**
   * Persist scan results to database.
   * Uses a transaction to insert scan metadata and all findings atomically.
   * If db is null or write fails, logs error and returns silently.
   *
   * Requirements: 8.1, 8.4
   */
  private persistScan(result: ScanResult): void {
    if (!this.db || !this.insertScanStmt || !this.insertFindingStmt) return;

    const txn = this.db.transaction(() => {
      this.insertScanStmt!.run(
        result.id,
        result.projectId,
        result.tier,
        result.summary.totalFiles,
        result.summary.totalFindings,
        result.summary.findingsBySeverity.low,
        result.summary.findingsBySeverity.medium,
        result.summary.findingsBySeverity.high,
        result.summary.findingsBySeverity.critical,
        result.summary.suppressedCount,
        result.summary.durationMs,
        new Date(result.timestamp).toISOString(),
      );

      for (const f of result.findings) {
        this.insertFindingStmt!.run(
          result.id,
          f.filePath,
          f.line,
          f.column,
          f.ruleId,
          f.ruleName,
          f.severity,
          f.category,
          f.description,
          f.remediation,
        );
      }
    });

    try {
      txn();
    } catch (err) {
      logger.error('SecurityScanner: failed to persist scan results', { error: String(err) });
    }
  }

  /**
   * Check if a finding is suppressed by an active exception.
   * Stub until ExceptionManager is implemented (task 6.1).
   */
  private isSuppressed(_finding: ScanFinding): boolean {
    return false;
  }

  /**
   * Orchestrate a full scan:
   * 1. Enumerate files
   * 2. Filter rules by tier
   * 3. Scan each file line-by-line
   * 4. Apply exception filtering
   * 5. Apply baseline delta if --baseline provided
   * 6. Generate summary
   * 7. Persist results
   * 8. Return ScanResult
   */
  async scan(
    projectPath: string,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    const start = Date.now();
    const tier: ScanTier = options.tier ?? 'extended';

    // 1. Enumerate files
    const files = this.enumerateFiles(projectPath);

    // 2–3. Scan each file
    let allFindings: ScanFinding[] = [];
    for (const file of files) {
      const fileFindings = this.scanFile(file, projectPath, tier);
      allFindings = allFindings.concat(fileFindings);
    }

    // 4. Apply exception filtering
    let suppressedCount = 0;
    const unsuppressed: ScanFinding[] = [];
    for (const finding of allFindings) {
      if (this.isSuppressed(finding)) {
        suppressedCount++;
      } else {
        unsuppressed.push(finding);
      }
    }

    // 5. Apply baseline delta if provided
    let findings = unsuppressed;
    if (options.baseline) {
      findings = this.applyBaseline(findings, options.baseline);
    }

    // 6. Generate summary
    const findingsBySeverity: Record<Severity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    for (const f of findings) {
      findingsBySeverity[f.severity]++;
    }

    const summary: ScanSummary = {
      totalFiles: files.length,
      totalFindings: findings.length,
      findingsBySeverity,
      durationMs: Date.now() - start,
      tier,
      suppressedCount,
    };

    const result: ScanResult = {
      id: crypto.randomUUID(),
      projectId: path.basename(projectPath),
      timestamp: Date.now(),
      tier,
      findings,
      summary,
    };

    // 7. Persist results (best-effort)
    try {
      this.persistScan(result);
    } catch {
      // Requirement 8.4: log error, still return results
    }

    return result;
  }

  /**
   * Run scanner health verification.
   *
   * Tests each scanner category against known-positive inputs,
   * verifies FirewallEngine Tier 2 rules are loaded and enabled,
   * and produces a ScannerHealthReport.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  async runHealthCheck(): Promise<ScannerHealthReport> {
    const scanners: ScannerHealthEntry[] = [];

    // Known-positive test inputs per category, mapped to expected rule IDs
    const knownPositives: Array<{
      category: string;
      name: string;
      inputs: Array<{ input: string; expectedRuleId: string }>;
    }> = [
      {
        category: 'secrets',
        name: 'Secrets Detection',
        inputs: [
          { input: 'const key = "AKIAIOSFODNN7EXAMPLE";', expectedRuleId: 'sec-01' },
        ],
      },
      {
        category: 'injection',
        name: 'Injection Detection',
        inputs: [
          { input: 'db.query(`SELECT * FROM users WHERE id = ${userId}`)', expectedRuleId: 'cp-01' },
          { input: 'require("child_process").exec(cmd)', expectedRuleId: 'cp-03' },
        ],
      },
      {
        category: 'xss',
        name: 'XSS Detection',
        inputs: [
          { input: 'el.innerHTML = userInput;', expectedRuleId: 'cp-02' },
        ],
      },
      {
        category: 'path-traversal',
        name: 'Path Traversal Detection',
        inputs: [
          { input: 'const p = "../../../etc/passwd"', expectedRuleId: 'cp-04' },
        ],
      },
      {
        category: 'crypto',
        name: 'Insecure Crypto Detection',
        inputs: [
          { input: 'const r = Math.random();', expectedRuleId: 'cp-05' },
        ],
      },
      {
        category: 'dependency',
        name: 'Dependency Vulnerability Detection',
        inputs: [
          { input: '"event-stream": "^3.3.4"', expectedRuleId: 'dep-01' },
        ],
      },
      {
        category: 'config',
        name: 'Insecure Configuration Detection',
        inputs: [
          { input: '"nodeIntegration": true', expectedRuleId: 'cfg-01' },
        ],
      },
    ];

    // Test each category against its known-positive inputs
    for (const group of knownPositives) {
      const categoryRules = this.rules.filter((r) => r.category === group.category);

      if (categoryRules.length === 0) {
        scanners.push({
          name: group.name,
          status: 'non-functional',
          message: `No rules registered for category "${group.category}".`,
          remediation: 'Verify that the rule set is properly initialized and FirewallEngine is loaded.',
        });
        continue;
      }

      let detectedCount = 0;
      let totalExpected = group.inputs.length;
      const failedRules: string[] = [];

      for (const testCase of group.inputs) {
        const rule = categoryRules.find((r) => r.id === testCase.expectedRuleId);
        if (!rule) {
          failedRules.push(testCase.expectedRuleId);
          continue;
        }

        // Reset regex lastIndex for global patterns
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(testCase.input);
        if (match) {
          detectedCount++;
        } else {
          failedRules.push(testCase.expectedRuleId);
        }
      }

      if (detectedCount === totalExpected) {
        scanners.push({
          name: group.name,
          status: 'operational',
          message: `All ${totalExpected} test input(s) detected successfully. ${categoryRules.length} rule(s) loaded.`,
        });
      } else if (detectedCount > 0) {
        scanners.push({
          name: group.name,
          status: 'degraded',
          message: `${detectedCount}/${totalExpected} test inputs detected. Rules not matching: ${failedRules.join(', ')}.`,
          remediation: `Check rule patterns for: ${failedRules.join(', ')}.`,
        });
      } else {
        scanners.push({
          name: group.name,
          status: 'non-functional',
          message: `No test inputs detected. Rules not matching: ${failedRules.join(', ')}.`,
          remediation: `Verify rule patterns and ensure rules are properly registered for category "${group.category}".`,
        });
      }
    }

    // Verify FirewallEngine Tier 2 rules are loaded and enabled
    const fwRules = this.firewallEngine.getRules().filter((r) => r.tier === 2);
    const enabledFwRules = fwRules.filter((r) => r.enabled);
    const disabledFwRules = fwRules.filter((r) => !r.enabled);

    if (fwRules.length === 0) {
      scanners.push({
        name: 'FirewallEngine Tier 2 Rules',
        status: 'non-functional',
        message: 'No Tier 2 (secrets) rules found in FirewallEngine.',
        remediation: 'Ensure FirewallEngine is initialized with default rules including Tier 2 secrets detection.',
      });
    } else if (disabledFwRules.length > 0) {
      scanners.push({
        name: 'FirewallEngine Tier 2 Rules',
        status: 'degraded',
        message: `${enabledFwRules.length}/${fwRules.length} Tier 2 rules enabled. Disabled: ${disabledFwRules.map((r) => r.id).join(', ')}.`,
        remediation: `Re-enable disabled rules: ${disabledFwRules.map((r) => r.id).join(', ')}.`,
      });
    } else {
      scanners.push({
        name: 'FirewallEngine Tier 2 Rules',
        status: 'operational',
        message: `All ${fwRules.length} Tier 2 rules loaded and enabled.`,
      });
    }

    const operationalCount = scanners.filter((s) => s.status === 'operational').length;
    const nonFunctionalCount = scanners.filter((s) => s.status === 'non-functional').length;

    return {
      timestamp: Date.now(),
      scanners,
      totalScanners: scanners.length,
      operationalCount,
      nonFunctionalCount,
    };
  }

  /**
   * Get scan history for a project, ordered by timestamp descending.
   * Returns [] if db is null or query fails.
   *
   * Requirements: 8.2
   */
  getScanHistory(projectId: string): ScanResult[] {
    if (!this.db || !this.selectScansStmt || !this.selectFindingsStmt) return [];

    try {
      const rows = this.selectScansStmt.all(projectId) as Array<{
        id: string;
        project_id: string;
        tier: ScanTier;
        total_files: number;
        total_findings: number;
        findings_low: number;
        findings_medium: number;
        findings_high: number;
        findings_critical: number;
        suppressed_count: number;
        duration_ms: number;
        created_at: string;
      }>;

      return rows.map((row) => {
        const findings = (this.selectFindingsStmt!.all(row.id) as Array<{
          file_path: string;
          line: number;
          col: number;
          rule_id: string;
          rule_name: string;
          severity: Severity;
          category: string;
          description: string;
          remediation: string;
        }>).map((f) => ({
          filePath: f.file_path,
          line: f.line,
          column: f.col,
          ruleId: f.rule_id,
          ruleName: f.rule_name,
          severity: f.severity,
          category: f.category,
          description: f.description,
          remediation: f.remediation,
        }));

        const summary: ScanSummary = {
          totalFiles: row.total_files,
          totalFindings: row.total_findings,
          findingsBySeverity: {
            low: row.findings_low,
            medium: row.findings_medium,
            high: row.findings_high,
            critical: row.findings_critical,
          },
          durationMs: row.duration_ms,
          tier: row.tier,
          suppressedCount: row.suppressed_count,
        };

        return {
          id: row.id,
          projectId: row.project_id,
          timestamp: new Date(row.created_at).getTime(),
          tier: row.tier,
          findings,
          summary,
        } satisfies ScanResult;
      });
    } catch (err) {
      logger.error('SecurityScanner: failed to query scan history', { error: String(err) });
      return [];
    }
  }
}
