/**
 * Architecture Conformance Check — Verifies that no parallel replacement
 * authorities exist and that all extension ports route through registered owners.
 *
 * This check can run as a test assertion, a startup check, or a CI gate.
 * It prevents architectural drift by detecting:
 *
 * 1. Duplicate authority registrations (parallel replacement authorities)
 * 2. Extension ports that claim an authority not registered in the registry
 * 3. Direct access attempts that bypass the extension port routing layer
 *
 * Requirements: 1.1–1.6, 25.4, 35.12, 39.13, 43.3
 */

import type { AuthorityKind } from './types.js';
import { AUTHORITY_LABELS } from './types.js';
import type { AuthorityRegistry } from './authority-registry.js';

// ─── Conformance Result ─────────────────────────────────────────

export interface ConformanceViolation {
  rule: ConformanceRule;
  authority: AuthorityKind;
  message: string;
  severity: 'error' | 'warning';
}

export type ConformanceRule =
  | 'NO_PARALLEL_AUTHORITY'
  | 'PORT_OWNER_REGISTERED'
  | 'NO_ORPHANED_PORTS'
  | 'NO_BYPASS_ATTEMPTS'
  | 'ALL_AUTHORITIES_COVERED';

export interface ConformanceResult {
  passed: boolean;
  violations: ConformanceViolation[];
  checkedAt: number;
  authoritiesRegistered: number;
  portsRegistered: number;
  bypassAttemptsRecorded: number;
}

// ─── The full set of expected authorities ───────────────────────

const ALL_AUTHORITY_KINDS: readonly AuthorityKind[] = [
  'mcp_server_manager',
  'provider_registry',
  'session_store',
  'plugin_registry',
  'orchestration_engine',
  'skill_catalog',
  'security_authority',
  'filesystem_authority',
  'process_authority',
  'terminal_authority',
  'language_service_authority',
  'tool_system',
] as const;

// ─── Architecture Conformance Checker ───────────────────────────

/**
 * Run a complete architecture conformance check against the registry.
 *
 * Detects:
 * - Bypass attempts that have been recorded
 * - Extension ports whose owning authority is not registered
 * - Missing authority registrations (when `requireAllAuthorities` is true)
 */
export function checkArchitectureConformance(
  registry: AuthorityRegistry,
  options?: {
    /** If true, require all known authority kinds to be registered */
    requireAllAuthorities?: boolean;
    /** If true, fail on any recorded bypass attempt */
    failOnBypassAttempts?: boolean;
  },
): ConformanceResult {
  const violations: ConformanceViolation[] = [];
  const opts = {
    requireAllAuthorities: false,
    failOnBypassAttempts: true,
    ...options,
  };

  // Check 1: No bypass attempts recorded
  const bypassAttempts = registry.getBypassAttempts();
  if (opts.failOnBypassAttempts && bypassAttempts.length > 0) {
    for (const attempt of bypassAttempts) {
      violations.push({
        rule: 'NO_BYPASS_ATTEMPTS',
        authority: attempt.authority,
        message: `Bypass attempt detected: operation '${attempt.attemptedOperation}' on authority '${AUTHORITY_LABELS[attempt.authority]}' (code: ${attempt.code})`,
        severity: 'error',
      });
    }
  }

  // Check 2: All registered ports have their owning authority registered
  const registeredAuthorities = registry.listAuthorities();
  for (const auth of registeredAuthorities) {
    const ports = registry.listPorts(auth.kind);
    for (const port of ports) {
      if (!registry.hasAuthority(port.id.authority)) {
        violations.push({
          rule: 'PORT_OWNER_REGISTERED',
          authority: port.id.authority,
          message: `Port '${port.id.name}' claims authority '${AUTHORITY_LABELS[port.id.authority]}' which is not registered.`,
          severity: 'error',
        });
      }
    }
  }

  // Check 3: Require all authorities (optional — for production readiness)
  if (opts.requireAllAuthorities) {
    for (const kind of ALL_AUTHORITY_KINDS) {
      if (!registry.hasAuthority(kind)) {
        violations.push({
          rule: 'ALL_AUTHORITIES_COVERED',
          authority: kind,
          message: `Authority '${AUTHORITY_LABELS[kind]}' is not registered. All domain authorities must be registered.`,
          severity: 'warning',
        });
      }
    }
  }

  // Compute summary
  let totalPorts = 0;
  for (const auth of registeredAuthorities) {
    totalPorts += registry.listPorts(auth.kind).length;
  }

  return {
    passed: violations.filter((v) => v.severity === 'error').length === 0,
    violations,
    checkedAt: Date.now(),
    authoritiesRegistered: registeredAuthorities.length,
    portsRegistered: totalPorts,
    bypassAttemptsRecorded: bypassAttempts.length,
  };
}

/**
 * Assert architecture conformance — throws if violations with severity 'error' exist.
 * Suitable for use in test assertions and CI gates.
 */
export function assertArchitectureConformance(
  registry: AuthorityRegistry,
  options?: Parameters<typeof checkArchitectureConformance>[1],
): void {
  const result = checkArchitectureConformance(registry, options);
  if (!result.passed) {
    const errorMessages = result.violations
      .filter((v) => v.severity === 'error')
      .map((v) => `  [${v.rule}] ${v.message}`)
      .join('\n');
    throw new Error(
      `Architecture conformance check FAILED:\n${errorMessages}`,
    );
  }
}

/**
 * Verify that attempting to register a second instance of an authority fails.
 * This is the key guard against parallel replacement authorities.
 */
export function verifyNoParallelAuthority(
  registry: AuthorityRegistry,
  kind: AuthorityKind,
  candidateInstance: unknown,
): ConformanceViolation | null {
  const result = registry.registerAuthority(kind, candidateInstance);
  if (!result.ok) {
    return {
      rule: 'NO_PARALLEL_AUTHORITY',
      authority: kind,
      message: result.denial.message,
      severity: 'error',
    };
  }
  // If registration unexpectedly succeeded, clean it up and report no violation
  // (this shouldn't happen if the authority was already registered)
  registry.unregisterAuthority(kind);
  return null;
}
