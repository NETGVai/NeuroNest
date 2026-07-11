/**
 * Wire SecuritySubsystemMonitor into all security subsystems.
 *
 * This module instantiates a SecuritySubsystemMonitor, registers all 4 security
 * subsystems (SecretsDetector, SASTEngine, RealtimeCodeAnalyzer, AISecurityRuleEngine),
 * wraps their main methods with failure reporting, and sets up periodic auto-recovery
 * for subsystems disabled >60s.
 *
 * Requirements: 17.1, 17.2, 17.5
 */

import { SecuritySubsystemMonitor, type SecurityTelemetryEvent } from './operational-hardening.js';
import type { SecretsDetector } from './secrets-detector.js';
import type { SASTEngine } from './sast-engine.js';
import type { RealtimeCodeAnalyzer } from './realtime-code-analyzer.js';
import type { AISecurityRuleEngine } from './ai-security-rule-engine.js';

// ─── Subsystem Categories ───────────────────────────────────────

/**
 * Category assignments for each security subsystem, mapping to the critical
 * categories defined in CRITICAL_SECURITY_CATEGORIES.
 */
export const SUBSYSTEM_CATEGORIES = {
  'secrets-detector': 'secrets-detection',
  'sast-engine': 'vulnerability-blocking',
  'realtime-code-analyzer': 'injection-prevention',
  'ai-security-rule-engine': 'injection-prevention',
} as const;

export type SubsystemName = keyof typeof SUBSYSTEM_CATEGORIES;

// ─── Subsystem References ───────────────────────────────────────

/**
 * References to the security subsystem instances to be monitored.
 */
export interface SecuritySubsystems {
  secretsDetector?: SecretsDetector;
  sastEngine?: SASTEngine;
  realtimeCodeAnalyzer?: RealtimeCodeAnalyzer;
  aiSecurityRuleEngine?: AISecurityRuleEngine;
}

// ─── Wiring Result ──────────────────────────────────────────────

/**
 * Result of wiring the security monitoring, including the monitor instance
 * and a dispose function to clean up intervals.
 */
export interface SecurityMonitoringWiring {
  /** The instantiated SecuritySubsystemMonitor */
  monitor: SecuritySubsystemMonitor;
  /** Telemetry event handler — call to retrieve emitted events */
  getTelemetryLog: () => SecurityTelemetryEvent[];
  /** Stop the auto-recovery interval and clean up resources */
  dispose: () => void;
}

// ─── Wire Security Monitoring ───────────────────────────────────

/**
 * Instantiates a SecuritySubsystemMonitor, registers all 4 security subsystems,
 * wraps their main methods with try/catch that reports failures to the monitor,
 * and sets up periodic auto-recovery for subsystems disabled >60s.
 *
 * @param subsystems - References to the security subsystem instances
 * @param recoveryIntervalMs - How often to check for recoverable subsystems (default: 10000ms)
 * @param recoveryTimeoutMs - How long a subsystem must be disabled before recovery is attempted (default: 60000ms)
 * @returns SecurityMonitoringWiring with monitor, telemetry access, and dispose function
 */
export function wireSecurityMonitoring(
  subsystems: SecuritySubsystems,
  recoveryIntervalMs: number = 10_000,
  recoveryTimeoutMs: number = 60_000,
): SecurityMonitoringWiring {
  // 1. Instantiate SecuritySubsystemMonitor
  const monitor = new SecuritySubsystemMonitor(recoveryTimeoutMs);

  // 2. Register all 4 security subsystems with their appropriate categories
  if (subsystems.secretsDetector) {
    monitor.register('secrets-detector', SUBSYSTEM_CATEGORIES['secrets-detector']);
  }
  if (subsystems.sastEngine) {
    monitor.register('sast-engine', SUBSYSTEM_CATEGORIES['sast-engine']);
  }
  if (subsystems.realtimeCodeAnalyzer) {
    monitor.register('realtime-code-analyzer', SUBSYSTEM_CATEGORIES['realtime-code-analyzer']);
  }
  if (subsystems.aiSecurityRuleEngine) {
    monitor.register('ai-security-rule-engine', SUBSYSTEM_CATEGORIES['ai-security-rule-engine']);
  }

  // 3. Wrap each subsystem's main method with try/catch that reports failures
  wrapSecretsDetector(subsystems.secretsDetector, monitor);
  wrapSASTEngine(subsystems.sastEngine, monitor);
  wrapRealtimeCodeAnalyzer(subsystems.realtimeCodeAnalyzer, monitor);
  wrapAISecurityRuleEngine(subsystems.aiSecurityRuleEngine, monitor);

  // 4. Set up periodic auto-recovery attempts for disabled subsystems (>60s)
  const recoveryInterval = setInterval(() => {
    void runAutoRecovery(monitor);
  }, recoveryIntervalMs);

  // Ensure the interval doesn't prevent process exit
  if (recoveryInterval.unref) {
    recoveryInterval.unref();
  }

  return {
    monitor,
    getTelemetryLog: () => monitor.getTelemetryLog(),
    dispose: () => {
      clearInterval(recoveryInterval);
    },
  };
}

// ─── Subsystem Wrapping ─────────────────────────────────────────

/**
 * Wraps SecretsDetector.detect() with failure reporting.
 */
function wrapSecretsDetector(
  detector: SecretsDetector | undefined,
  monitor: SecuritySubsystemMonitor,
): void {
  if (!detector) return;

  const originalDetect = detector.detect.bind(detector);

  detector.detect = async function wrappedDetect(
    filePath: string,
    content: string,
  ) {
    try {
      return await originalDetect(filePath, content);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      monitor.reportFailure('secrets-detector', error);
      // Fail closed: re-throw for critical categories so the caller
      // can block the operation
      if (monitor.shouldFailClosed('secrets-detector')) {
        throw error;
      }
      return [];
    }
  };
}

/**
 * Wraps SASTEngine.analyze() with failure reporting.
 */
function wrapSASTEngine(
  engine: SASTEngine | undefined,
  monitor: SecuritySubsystemMonitor,
): void {
  if (!engine) return;

  const originalAnalyze = engine.analyze.bind(engine);

  engine.analyze = async function wrappedAnalyze(
    files: Array<{ path: string; content: string }>,
    timeoutMs?: number,
  ) {
    try {
      return await originalAnalyze(files, timeoutMs);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      monitor.reportFailure('sast-engine', error);
      if (monitor.shouldFailClosed('sast-engine')) {
        throw error;
      }
      // Return a safe default indicating failure with no findings
      return {
        passed: true,
        findings: [],
        durationMs: 0,
        timedOut: true,
        fellBackToRegex: false,
      };
    }
  };
}

/**
 * Wraps RealtimeCodeAnalyzer.analyzeBeforeWrite() with failure reporting.
 */
function wrapRealtimeCodeAnalyzer(
  analyzer: RealtimeCodeAnalyzer | undefined,
  monitor: SecuritySubsystemMonitor,
): void {
  if (!analyzer) return;

  const originalAnalyze = analyzer.analyzeBeforeWrite.bind(analyzer);

  analyzer.analyzeBeforeWrite = async function wrappedAnalyzeBeforeWrite(
    filePath: string,
    content: string,
    sessionId: string,
    firewallResult?: { passed: boolean; categories?: string[] },
  ) {
    try {
      return await originalAnalyze(filePath, content, sessionId, firewallResult);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      monitor.reportFailure('realtime-code-analyzer', error);
      if (monitor.shouldFailClosed('realtime-code-analyzer')) {
        throw error;
      }
      // Return a permissive default when non-critical
      return {
        passed: true,
        findings: [],
        latencyMs: 0,
        timedOut: false,
        firewallCategoriesSkipped: [],
      };
    }
  };
}

/**
 * Wraps AISecurityRuleEngine.evaluate() with failure reporting.
 */
function wrapAISecurityRuleEngine(
  engine: AISecurityRuleEngine | undefined,
  monitor: SecuritySubsystemMonitor,
): void {
  if (!engine) return;

  const originalEvaluate = engine.evaluate.bind(engine);

  engine.evaluate = function wrappedEvaluate(
    filePath: string,
    content: string,
    sessionId: string,
  ) {
    try {
      return originalEvaluate(filePath, content, sessionId);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      monitor.reportFailure('ai-security-rule-engine', error);
      if (monitor.shouldFailClosed('ai-security-rule-engine')) {
        throw error;
      }
      // Return a safe default with no findings
      return {
        passed: true,
        findings: [],
        rulesEvaluated: 0,
        latencyMs: 0,
      };
    }
  };
}

// ─── Auto-Recovery ──────────────────────────────────────────────

/**
 * Attempts auto-recovery for all registered subsystems that have been
 * disabled for longer than the configured timeout (default 60s).
 */
async function runAutoRecovery(monitor: SecuritySubsystemMonitor): Promise<void> {
  const subsystems = monitor.getRegisteredSubsystems();

  for (const name of subsystems) {
    if (!monitor.isHealthy(name)) {
      await monitor.attemptRecovery(name);
    }
  }
}
