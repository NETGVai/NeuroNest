/**
 * Shared type definitions for the Runtime Security subsystems.
 *
 * These types are used across all six runtime security subsystems:
 * Hackability Scoring, Threat Modeling, Real-time Analysis,
 * Attack Path Mapping, Security Evidence Store, and AI Security Rules.
 *
 * Requirements: 1.8, 4.7
 */

// ─── Severity and Decision Types ────────────────────────────────

/** Threat severity levels for all runtime security findings */
export type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Decision outcomes for security events */
export type SecurityDecision = 'blocked' | 'warned' | 'allowed';

// ─── Event Types ────────────────────────────────────────────────

/** Event types emitted by runtime security subsystems */
export type SecurityEventType =
  | 'hackability_score'
  | 'threat_finding'
  | 'realtime_block'
  | 'realtime_warning'
  | 'attack_path_detected'
  | 'ai_rule_finding'
  | 'remediation_applied';

/** Lifecycle events emitted via CallbackEngine for runtime security */
export type SecurityLifecycleEvent =
  | 'security-score-computed'
  | 'security-threat-detected'
  | 'security-write-blocked'
  | 'security-write-warned'
  | 'security-attack-path-found'
  | 'security-ai-rule-finding';

// ─── Hook Context ───────────────────────────────────────────────

/** Extended hook context for security events passed through CallbackEngine */
export interface SecurityHookContext {
  securityEvent?: {
    subsystem: string;
    severity: ThreatSeverity;
    score?: number;
    findings?: unknown[];
    decision?: SecurityDecision;
    filePath?: string;
  };
}
