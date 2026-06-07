/**
 * Type definitions for the SecurityScanner module.
 *
 * Requirements: 2.6, 1.1
 */

// ─── Enums ──────────────────────────────────────────────────────

export type ScanTier = 'minimal' | 'extended' | 'paranoid';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

// ─── Scan Finding ───────────────────────────────────────────────

export interface ScanFinding {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  category: string;
  description: string;
  remediation: string;
}

// ─── Scan Summary ───────────────────────────────────────────────

export interface ScanSummary {
  totalFiles: number;
  totalFindings: number;
  findingsBySeverity: Record<Severity, number>;
  durationMs: number;
  tier: ScanTier;
  suppressedCount: number;
}

// ─── Scan Result ────────────────────────────────────────────────

export interface ScanResult {
  id: string;
  projectId: string;
  timestamp: number;
  tier: ScanTier;
  findings: ScanFinding[];
  summary: ScanSummary;
}

// ─── Scan Options ───────────────────────────────────────────────

export interface ScanOptions {
  tier?: ScanTier;
  baseline?: string;
  output?: string;
}

// ─── Scanner Rule ───────────────────────────────────────────────

export interface ScannerRule {
  id: string;
  name: string;
  pattern: RegExp;
  severity: Severity;
  category: string;
  description: string;
  remediation: string;
  tiers: ScanTier[];
}

// ─── Scan Exception ─────────────────────────────────────────────

export interface ScanException {
  id: string;
  ruleId: string;
  filePattern: string;
  reason: string;
  creator: string;
  createdAt: number;
  expiresAt: number | null;
}

// ─── Scanner Health ─────────────────────────────────────────────

export interface ScannerHealthEntry {
  name: string;
  status: 'operational' | 'degraded' | 'non-functional';
  message: string;
  remediation?: string;
}

export interface ScannerHealthReport {
  timestamp: number;
  scanners: ScannerHealthEntry[];
  totalScanners: number;
  operationalCount: number;
  nonFunctionalCount: number;
}
