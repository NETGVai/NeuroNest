/**
 * Compliance Evidence Adapter — Bridges SecurityEvidenceStore output
 * to the format expected by ComplianceGateRunner.
 *
 * Maps SecurityEvidenceRecords into a structured payload suitable for
 * compliance audits (PCI-DSS, HIPAA, GDPR), with category-based
 * standard mapping and aggregated summary statistics.
 *
 * Requirements: 6.6
 */

import type { SecurityEvidenceStore, SecurityEvidenceRecord } from './security-evidence-store.js';
import type { SecurityEventType, ThreatSeverity, SecurityDecision } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A single formatted evidence record for a compliance audit.
 */
export interface ComplianceEvidenceRecord {
  /** Unique identifier from the original evidence record. */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Category derived from source subsystem and event type. */
  category: string;
  /** Severity level. */
  severity: ThreatSeverity;
  /** Decision taken (blocked/warned/allowed). */
  decision: SecurityDecision;
  /** Human-readable details of the finding. */
  details: string;
  /** Files affected by this finding. */
  affectedFiles: string[];
  /** Applicable compliance standards based on category mapping. */
  complianceStandards: string[];
}

/**
 * Summary statistics aggregated from evidence records.
 */
export interface ComplianceEvidenceSummary {
  /** Total number of security events. */
  totalEvents: number;
  /** Number of events that resulted in a block. */
  blocked: number;
  /** Number of events that resulted in a warning. */
  warned: number;
  /** Number of events that were allowed. */
  allowed: number;
  /** Number of critical-severity findings. */
  criticalFindings: number;
}

/**
 * Full payload of security evidence formatted for ComplianceGateRunner.
 */
export interface ComplianceEvidencePayload {
  /** Session this evidence belongs to. */
  sessionId: string;
  /** Formatted evidence records with compliance standard mapping. */
  evidenceRecords: ComplianceEvidenceRecord[];
  /** Aggregated summary statistics. */
  summary: ComplianceEvidenceSummary;
}

/**
 * Adapter interface for connecting SecurityEvidenceStore to ComplianceGateRunner.
 */
export interface IComplianceEvidenceAdapter {
  /**
   * Get formatted security evidence for a compliance audit.
   * Maps SecurityEvidenceRecords to the format expected by ComplianceGateRunner.
   */
  getEvidenceForAudit(sessionId: string): ComplianceEvidencePayload;
}

// ─── Category-to-Standard Mapping ───────────────────────────────

/**
 * Maps finding categories (derived from event types and subsystem details)
 * to the relevant compliance standards.
 *
 * - secrets/credentials/encryption → PCI-DSS
 * - PII/health data/data access → HIPAA, GDPR
 * - auth/access control → PCI-DSS
 * - data handling/consent/deletion → GDPR
 * - general vulnerabilities → all standards
 */
const CATEGORY_STANDARD_MAP: Record<string, string[]> = {
  // Secrets and credentials → PCI-DSS (cardholder data protection)
  secrets: ['PCI-DSS'],
  'secrets-in-prompts': ['PCI-DSS'],
  credentials: ['PCI-DSS'],
  encryption: ['PCI-DSS'],

  // PII handling → HIPAA and GDPR
  pii: ['HIPAA', 'GDPR'],
  'pii-leakage': ['HIPAA', 'GDPR'],
  'health-data': ['HIPAA'],
  'personal-data': ['GDPR'],

  // Authentication and access control → PCI-DSS
  auth: ['PCI-DSS'],
  authentication: ['PCI-DSS'],
  'access-control': ['PCI-DSS', 'HIPAA'],

  // Data validation and injection → PCI-DSS, GDPR
  injection: ['PCI-DSS', 'GDPR'],
  'prompt-injection': ['PCI-DSS', 'GDPR'],
  'data-validation': ['PCI-DSS', 'GDPR'],

  // Unvalidated output and missing rate limit → all
  'unvalidated-output': ['PCI-DSS', 'HIPAA', 'GDPR'],
  'missing-rate-limit': ['PCI-DSS', 'HIPAA', 'GDPR'],

  // AI-specific risks → all (cross-cutting concern)
  'ai-specific': ['PCI-DSS', 'HIPAA', 'GDPR'],

  // Attack paths → all standards
  'attack-path': ['PCI-DSS', 'HIPAA', 'GDPR'],

  // General/default → all standards
  general: ['PCI-DSS', 'HIPAA', 'GDPR'],
};

/**
 * Maps SecurityEventType to a human-readable category string
 * used for compliance standard mapping.
 */
function eventTypeToCategory(eventType: SecurityEventType, findingDetails: string): string {
  // Try to extract a more specific category from finding details
  const detailsLower = findingDetails.toLowerCase();

  // Check for specific content patterns in the finding details
  if (detailsLower.includes('secret') || detailsLower.includes('credential') || detailsLower.includes('api_key') || detailsLower.includes('password')) {
    return 'secrets';
  }
  if (detailsLower.includes('pii') || detailsLower.includes('personal') || detailsLower.includes('email') || detailsLower.includes('phone')) {
    return 'pii';
  }
  if (detailsLower.includes('health') || detailsLower.includes('medical') || detailsLower.includes('patient') || detailsLower.includes('phi')) {
    return 'health-data';
  }
  if (detailsLower.includes('auth') || detailsLower.includes('login') || detailsLower.includes('access control')) {
    return 'auth';
  }
  if (detailsLower.includes('injection') || detailsLower.includes('prompt injection')) {
    return 'injection';
  }
  if (detailsLower.includes('encrypt') || detailsLower.includes('cipher') || detailsLower.includes('tls')) {
    return 'encryption';
  }
  if (detailsLower.includes('consent') || detailsLower.includes('gdpr') || detailsLower.includes('erasure') || detailsLower.includes('deletion')) {
    return 'personal-data';
  }

  // Fall back to event-type-based category
  switch (eventType) {
    case 'hackability_score':
      return 'general';
    case 'threat_finding':
      return 'ai-specific';
    case 'realtime_block':
    case 'realtime_warning':
      return 'data-validation';
    case 'attack_path_detected':
      return 'attack-path';
    case 'ai_rule_finding':
      return 'ai-specific';
    case 'remediation_applied':
      return 'general';
    default:
      return 'general';
  }
}

/**
 * Get applicable compliance standards for a given category.
 */
function getComplianceStandards(category: string): string[] {
  return CATEGORY_STANDARD_MAP[category] ?? CATEGORY_STANDARD_MAP['general']!;
}

// ─── ComplianceEvidenceAdapter ──────────────────────────────────

/**
 * Adapts SecurityEvidenceStore records into the ComplianceEvidencePayload
 * format consumed by ComplianceGateRunner for audit documentation.
 */
export class ComplianceEvidenceAdapter implements IComplianceEvidenceAdapter {
  private readonly evidenceStore: SecurityEvidenceStore;

  constructor(evidenceStore: SecurityEvidenceStore) {
    this.evidenceStore = evidenceStore;
  }

  /**
   * Get formatted security evidence for a compliance audit.
   *
   * Retrieves all evidence records for the given session from the
   * SecurityEvidenceStore, maps each to a ComplianceEvidenceRecord
   * with applicable compliance standards, and computes summary statistics.
   *
   * @param sessionId - The session to retrieve evidence for.
   * @returns ComplianceEvidencePayload with formatted records and summary.
   */
  getEvidenceForAudit(sessionId: string): ComplianceEvidencePayload {
    const rawRecords = this.evidenceStore.getComplianceEvidence(sessionId);

    const evidenceRecords = rawRecords.map((record) =>
      this.mapRecord(record),
    );

    const summary = this.computeSummary(rawRecords);

    return {
      sessionId,
      evidenceRecords,
      summary,
    };
  }

  /**
   * Map a single SecurityEvidenceRecord to a ComplianceEvidenceRecord.
   */
  private mapRecord(record: SecurityEvidenceRecord): ComplianceEvidenceRecord {
    const category = eventTypeToCategory(record.eventType, record.findingDetails);
    const complianceStandards = getComplianceStandards(category);

    return {
      id: record.id,
      timestamp: record.timestamp,
      category,
      severity: record.severity,
      decision: record.decision,
      details: record.findingDetails,
      affectedFiles: record.affectedFiles,
      complianceStandards,
    };
  }

  /**
   * Compute aggregated summary statistics from evidence records.
   */
  private computeSummary(records: SecurityEvidenceRecord[]): ComplianceEvidenceSummary {
    let blocked = 0;
    let warned = 0;
    let allowed = 0;
    let criticalFindings = 0;

    for (const record of records) {
      switch (record.decision) {
        case 'blocked':
          blocked++;
          break;
        case 'warned':
          warned++;
          break;
        case 'allowed':
          allowed++;
          break;
      }

      if (record.severity === 'critical') {
        criticalFindings++;
      }
    }

    return {
      totalEvents: records.length,
      blocked,
      warned,
      allowed,
      criticalFindings,
    };
  }
}
