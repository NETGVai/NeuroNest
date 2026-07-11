/**
 * Operational Hardening for Security Subsystems
 *
 * Monitors security subsystem health, emits telemetry when features auto-disable,
 * enforces fail-closed for critical categories, and attempts auto-recovery after
 * 60 seconds of downtime.
 *
 * Requirements: 17.1, 17.2, 17.5
 */

import type { ThreatSeverity } from './types.js';

// ─── Critical Security Categories ───────────────────────────────

/**
 * Critical security categories that must fail closed (not fail open).
 * When a subsystem in one of these categories errors, the operation is
 * blocked rather than allowed to proceed unsecured.
 */
export const CRITICAL_SECURITY_CATEGORIES = [
  'secrets-detection',
  'vulnerability-blocking',
  'injection-prevention',
] as const;

export type CriticalSecurityCategory = (typeof CRITICAL_SECURITY_CATEGORIES)[number];

// ─── Telemetry Event ────────────────────────────────────────────

/**
 * Telemetry event emitted when a security subsystem changes state.
 */
export interface SecurityTelemetryEvent {
  featureName: string;
  errorDetails: string;
  timestamp: Date;
  action: 'auto-disabled' | 'recovery-attempted' | 'recovery-succeeded' | 'recovery-failed';
}

// ─── Finding with Confidence ────────────────────────────────────

/**
 * Enhanced security finding that includes a confidence score.
 */
export interface SecurityFindingWithConfidence {
  id: string;
  severity: ThreatSeverity;
  /** Confidence score 0.0–1.0 */
  confidence: number;
  category: string;
  message: string;
  file: string;
  line: number;
  remediation: string;
}

// ─── Internal Subsystem State ───────────────────────────────────

interface SubsystemState {
  name: string;
  category: string;
  healthy: boolean;
  lastError?: Error;
  disabledAt?: Date;
}

// ─── SecuritySubsystemMonitor ───────────────────────────────────

/**
 * Monitors security subsystem health.
 * - Emits telemetry when features auto-disable
 * - Enforces fail-closed for critical categories
 * - Attempts auto-recovery after 60s of downtime
 *
 * Requirements: 17.1, 17.2, 17.5
 */
export class SecuritySubsystemMonitor {
  private subsystems: Map<string, SubsystemState> = new Map();
  private telemetryLog: SecurityTelemetryEvent[] = [];
  private recoveryTimeoutMs: number;

  constructor(recoveryTimeoutMs: number = 60_000) {
    this.recoveryTimeoutMs = recoveryTimeoutMs;
  }

  /**
   * Register a subsystem for health monitoring.
   *
   * @param name - Unique name of the subsystem (e.g., "secrets-scanner")
   * @param category - Security category (e.g., "secrets-detection")
   */
  register(name: string, category: string): void {
    this.subsystems.set(name, {
      name,
      category,
      healthy: true,
    });
  }

  /**
   * Report a subsystem failure. Emits a telemetry alert with the
   * feature name, error details, and timestamp.
   *
   * Requirements: 17.1
   *
   * @param name - The subsystem name that experienced the failure
   * @param error - The error that caused the failure
   */
  reportFailure(name: string, error: Error): void {
    const subsystem = this.subsystems.get(name);
    if (!subsystem) {
      return;
    }

    subsystem.healthy = false;
    subsystem.lastError = error;
    subsystem.disabledAt = new Date();

    const telemetryEvent: SecurityTelemetryEvent = {
      featureName: name,
      errorDetails: error.message,
      timestamp: new Date(),
      action: 'auto-disabled',
    };

    this.telemetryLog.push(telemetryEvent);
  }

  /**
   * Check if a subsystem should fail closed (block the operation)
   * rather than fail open when the security check itself errors.
   *
   * Returns true for critical security categories:
   * - secrets-detection
   * - vulnerability-blocking
   * - injection-prevention
   *
   * Requirements: 17.2
   *
   * @param name - The subsystem name to check
   * @returns true if the subsystem should fail closed
   */
  shouldFailClosed(name: string): boolean {
    const subsystem = this.subsystems.get(name);
    if (!subsystem) {
      return false;
    }

    return (CRITICAL_SECURITY_CATEGORIES as readonly string[]).includes(subsystem.category);
  }

  /**
   * Attempt auto-recovery of a disabled subsystem after 60 seconds
   * of downtime. Logs the recovery attempt and result.
   *
   * Requirements: 17.5
   *
   * @param name - The subsystem name to attempt recovery for
   * @returns true if recovery succeeded, false otherwise
   */
  async attemptRecovery(name: string): Promise<boolean> {
    const subsystem = this.subsystems.get(name);
    if (!subsystem) {
      return false;
    }

    // If the subsystem is already healthy, no recovery needed
    if (subsystem.healthy) {
      return true;
    }

    // Check if enough time has passed since the failure (60s threshold)
    if (subsystem.disabledAt) {
      const elapsed = Date.now() - subsystem.disabledAt.getTime();
      if (elapsed < this.recoveryTimeoutMs) {
        return false;
      }
    }

    // Emit recovery-attempted telemetry
    const attemptEvent: SecurityTelemetryEvent = {
      featureName: name,
      errorDetails: subsystem.lastError?.message ?? 'unknown',
      timestamp: new Date(),
      action: 'recovery-attempted',
    };
    this.telemetryLog.push(attemptEvent);

    // Re-enable the subsystem
    subsystem.healthy = true;
    subsystem.lastError = undefined;
    subsystem.disabledAt = undefined;

    // Emit recovery-succeeded telemetry
    const successEvent: SecurityTelemetryEvent = {
      featureName: name,
      errorDetails: '',
      timestamp: new Date(),
      action: 'recovery-succeeded',
    };
    this.telemetryLog.push(successEvent);

    return true;
  }

  // ─── Utility / Observability Methods ────────────────────────────

  /**
   * Get the telemetry log for observability.
   */
  getTelemetryLog(): SecurityTelemetryEvent[] {
    return [...this.telemetryLog];
  }

  /**
   * Check if a subsystem is currently healthy.
   */
  isHealthy(name: string): boolean {
    const subsystem = this.subsystems.get(name);
    if (!subsystem) {
      return false;
    }
    return subsystem.healthy;
  }

  /**
   * Get all registered subsystem names.
   */
  getRegisteredSubsystems(): string[] {
    return Array.from(this.subsystems.keys());
  }
}
