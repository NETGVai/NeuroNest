/**
 * Supply-chain gate for plugin / package / MCP installation (NN-SEC-012,
 * NN-SEC-016, D-16.7).
 *
 * FUT-PKG-04-SECURITY/T-008. BEFORE any package/plugin/MCP is staged or
 * activated, the gate verifies, in order:
 *
 *   1. manifest validity        (delegated to plugin-manifest-validator)
 *   2. package identity / publisher
 *   3. pinned version           (no range floats)
 *   4. integrity / signature    (missing signature is an *ambiguous* finding)
 *   5. license policy
 *   6. install scripts
 *   7. vulnerabilities
 *   8. typosquatting signals
 *   9. requested permissions    (least privilege, NN-INV-005)
 *  10. runtime compatibility
 *  11. rollback availability
 *
 * The decision rule (NN-SEC-012, NN-INV-001):
 *
 *   - Any `critical` / `high` severity finding  → BLOCK.
 *   - Any policy-`prohibited` finding            → BLOCK.
 *   - Any `ambiguous` / unresolved finding        → BLOCK (fail closed).
 *   - `medium` findings                            → require explicit approval.
 *   - only `low` / `info`                          → qualified activation.
 *
 * A BLOCK produces a QUARANTINE decision: the artifact is recorded in a
 * quarantine state and NEVER activated. The gate never returns a "partial"
 * install; the outcome is either qualified activation, quarantine (blocked),
 * or a typed `UNAVAILABLE` when a required check could not run.
 *
 * The gate itself performs NO installation and NO I/O. It consumes evidence
 * gathered by adapters (which run under the sandbox) and produces a pure,
 * deterministic decision so it is fully testable.
 *
 * Requirements: NN-SEC-012, NN-SEC-016, NN-INTEGRATION-003, NN-INV-001,
 * NN-INV-005, NN-INV-011, NN-INV-014.
 * Design anchors: D-03, D-16 (D-16.7), D-24.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorEnvelope,
} from '../../shared/contract-primitives';
import {
  validatePluginManifest,
  type PluginManifest,
} from './plugin-manifest-validator';

const GATE_OWNER = 'authority-supply-chain';

// ─── Findings ────────────────────────────────────────────────────────────────

/**
 * Severity of a supply-chain finding. `ambiguous` is a first-class severity:
 * an uncertain / unverifiable signal is NOT treated as clean (NN-INV-001 fail
 * closed).
 */
export const FINDING_SEVERITIES = Object.freeze([
  'info',
  'low',
  'medium',
  'high',
  'critical',
  'prohibited',
  'ambiguous',
] as const);
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The ordered check categories the gate evaluates (NN-SEC-012). */
export const GATE_CHECKS = Object.freeze([
  'manifest',
  'identity',
  'version',
  'integrity',
  'license',
  'install-scripts',
  'vulnerabilities',
  'typosquatting',
  'permissions',
  'compatibility',
  'rollback',
] as const);
export type GateCheck = (typeof GATE_CHECKS)[number];

/** A single supply-chain finding produced by a check. */
export interface SupplyChainFinding {
  readonly check: GateCheck;
  readonly severity: FindingSeverity;
  /** Whether this finding blocks (advisory vs blocking, NN-SEC-013). */
  readonly blocking: boolean;
  /** Safe, secret-free rule/source citation (NN-SEC-013). */
  readonly ruleId: string;
  /** Safe, secret-free, private-path-free human explanation. */
  readonly detail: string;
}

// ─── Policy inputs ────────────────────────────────────────────────────────────

/** The install policy the gate enforces. */
export interface SupplyChainPolicy {
  /** Publishers explicitly trusted; empty = trust decided per-finding only. */
  readonly trustedPublishers: readonly string[];
  /** Allowed SPDX license ids. A license outside this set is prohibited. */
  readonly allowedLicenses: readonly string[];
  /** License ids that are explicitly prohibited regardless of allow list. */
  readonly prohibitedLicenses: readonly string[];
  /**
   * Whether an unsigned artifact is treated as `ambiguous` (fail closed). When
   * `false`, an unsigned artifact from a trusted publisher is `low`. Default
   * behavior when constructing a policy is `true`.
   */
  readonly requireSignature: boolean;
  /** Permission ids that are never grantable to a third party (prohibited). */
  readonly prohibitedPermissions: readonly string[];
  /** The current host application version, for compatibility checks. */
  readonly hostVersion: string;
}

/**
 * Externally gathered evidence about the candidate artifact. Adapters (running
 * under the sandbox) populate this; the gate only reasons over it. Every field
 * that is `undefined` is treated as an unresolved/ambiguous signal.
 */
export interface SupplyChainEvidence {
  /** Whether the resolved package name/publisher matched the manifest. */
  readonly identityVerified: boolean;
  /**
   * Integrity verification result. `undefined` means the check could not be
   * completed (ambiguous). `false` means a mismatch (critical).
   */
  readonly integrityMatches?: boolean;
  /** Known vulnerability findings for the pinned version. */
  readonly vulnerabilities: readonly {
    readonly id: string;
    readonly severity: FindingSeverity;
  }[];
  /**
   * Typosquatting signal: the closest popular package and edit distance. When
   * `distance` is 1 or 2 against a different popular name, it is a high signal.
   */
  readonly typosquat?: {
    readonly nearestPopular: string;
    readonly distance: number;
  };
  /**
   * Whether every install script has been reviewed/approved. `false` with a
   * non-empty manifest.installScripts is a high finding.
   */
  readonly installScriptsReviewed: boolean;
}

// ─── Decision ────────────────────────────────────────────────────────────────

/** The terminal gate outcome (never a partial install). */
export type GateDecision =
  /** Qualified activation permitted (only low/info findings). */
  | {
      readonly outcome: 'activate';
      readonly manifest: PluginManifest;
      readonly findings: readonly SupplyChainFinding[];
    }
  /** Medium findings require an explicit approval before activation. */
  | {
      readonly outcome: 'requires-approval';
      readonly manifest: PluginManifest;
      readonly findings: readonly SupplyChainFinding[];
    }
  /**
   * Blocked: the artifact is quarantined and NEVER activated. A blocking
   * finding (critical/high/prohibited/ambiguous) triggers this.
   */
  | {
      readonly outcome: 'blocked';
      readonly quarantined: true;
      readonly findings: readonly SupplyChainFinding[];
      readonly error: ErrorEnvelope;
    }
  /** A required check could not run (e.g. manifest invalid). */
  | {
      readonly outcome: 'unavailable';
      readonly error: ErrorEnvelope;
    };

function gateError(
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: GATE_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Resolve every blocking or ambiguous supply-chain finding before ' +
      'installation. The artifact remains quarantined and is never ' +
      'activated while a blocking finding is present.',
    redaction: 'internal',
  };
}

/** Build a policy with safe fail-closed defaults. */
export function defaultSupplyChainPolicy(
  hostVersion: string,
  overrides?: Partial<SupplyChainPolicy>,
): SupplyChainPolicy {
  return {
    trustedPublishers: overrides?.trustedPublishers ?? [],
    allowedLicenses:
      overrides?.allowedLicenses ??
      ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'],
    prohibitedLicenses: overrides?.prohibitedLicenses ?? ['GPL-3.0-only', 'AGPL-3.0-only'],
    requireSignature: overrides?.requireSignature ?? true,
    prohibitedPermissions:
      overrides?.prohibitedPermissions ?? ['process.spawn-unrestricted', 'fs.write-host-root'],
    hostVersion,
  };
}

// ─── Compatibility helper ─────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `a >= b` semver comparison over `[major, minor, patch]`. */
function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

// ─── Per-check evaluators ─────────────────────────────────────────────────────

function checkVersion(manifest: PluginManifest): SupplyChainFinding[] {
  // The schema already forbids ranges; a range would have failed validation.
  // Here we defensively re-assert the pin so a future schema loosening cannot
  // silently permit a float.
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    return [
      {
        check: 'version',
        severity: 'prohibited',
        blocking: true,
        ruleId: 'SC-VERSION-UNPINNED',
        detail: 'package version is not an exact pinned semver',
      },
    ];
  }
  return [];
}

function checkIdentity(evidence: SupplyChainEvidence): SupplyChainFinding[] {
  if (!evidence.identityVerified) {
    return [
      {
        check: 'identity',
        severity: 'critical',
        blocking: true,
        ruleId: 'SC-IDENTITY-MISMATCH',
        detail: 'resolved package identity did not match the manifest',
      },
    ];
  }
  return [];
}

function checkIntegrity(
  manifest: PluginManifest,
  evidence: SupplyChainEvidence,
  policy: SupplyChainPolicy,
): SupplyChainFinding[] {
  if (evidence.integrityMatches === false) {
    return [
      {
        check: 'integrity',
        severity: 'critical',
        blocking: true,
        ruleId: 'SC-INTEGRITY-MISMATCH',
        detail: 'artifact integrity digest did not match the manifest',
      },
    ];
  }
  const hasSignature = manifest.signature !== undefined && manifest.integrity !== undefined;
  if (!hasSignature || evidence.integrityMatches === undefined) {
    const trusted = policy.trustedPublishers.includes(manifest.publisher);
    // Missing signature / unresolved integrity is AMBIGUOUS (fail closed)
    // unless the publisher is trusted AND policy does not require a signature.
    if (policy.requireSignature || !trusted) {
      return [
        {
          check: 'integrity',
          severity: 'ambiguous',
          blocking: true,
          ruleId: 'SC-INTEGRITY-UNVERIFIED',
          detail: 'integrity/signature could not be verified',
        },
      ];
    }
    return [
      {
        check: 'integrity',
        severity: 'low',
        blocking: false,
        ruleId: 'SC-INTEGRITY-TRUSTED-UNSIGNED',
        detail: 'unsigned artifact accepted from a trusted publisher by policy',
      },
    ];
  }
  return [];
}

function checkLicense(
  manifest: PluginManifest,
  policy: SupplyChainPolicy,
): SupplyChainFinding[] {
  if (policy.prohibitedLicenses.includes(manifest.license)) {
    return [
      {
        check: 'license',
        severity: 'prohibited',
        blocking: true,
        ruleId: 'SC-LICENSE-PROHIBITED',
        detail: `license \`${manifest.license}\` is prohibited by policy`,
      },
    ];
  }
  if (!policy.allowedLicenses.includes(manifest.license)) {
    return [
      {
        check: 'license',
        severity: 'ambiguous',
        blocking: true,
        ruleId: 'SC-LICENSE-UNRECOGNIZED',
        detail: `license \`${manifest.license}\` is not on the allow list`,
      },
    ];
  }
  return [];
}

function checkInstallScripts(
  manifest: PluginManifest,
  evidence: SupplyChainEvidence,
): SupplyChainFinding[] {
  if (manifest.installScripts.length === 0) return [];
  if (!evidence.installScriptsReviewed) {
    return [
      {
        check: 'install-scripts',
        severity: 'high',
        blocking: true,
        ruleId: 'SC-INSTALL-SCRIPT-UNREVIEWED',
        detail: 'artifact declares install scripts that were not reviewed',
      },
    ];
  }
  return [
    {
      check: 'install-scripts',
      severity: 'medium',
      blocking: false,
      ruleId: 'SC-INSTALL-SCRIPT-PRESENT',
      detail: 'artifact declares reviewed install scripts (approval required)',
    },
  ];
}

function checkVulnerabilities(evidence: SupplyChainEvidence): SupplyChainFinding[] {
  const findings: SupplyChainFinding[] = [];
  for (const v of evidence.vulnerabilities) {
    const blocking =
      v.severity === 'critical' ||
      v.severity === 'high' ||
      v.severity === 'prohibited' ||
      v.severity === 'ambiguous';
    findings.push({
      check: 'vulnerabilities',
      severity: v.severity,
      blocking,
      ruleId: `SC-VULN-${v.id}`,
      detail: `known vulnerability ${v.id} (${v.severity})`,
    });
  }
  return findings;
}

function checkTyposquat(evidence: SupplyChainEvidence): SupplyChainFinding[] {
  const t = evidence.typosquat;
  if (!t) return [];
  if (t.distance >= 1 && t.distance <= 2) {
    return [
      {
        check: 'typosquatting',
        severity: 'high',
        blocking: true,
        ruleId: 'SC-TYPOSQUAT-NEAR',
        detail: `name is edit-distance ${t.distance} from popular \`${t.nearestPopular}\``,
      },
    ];
  }
  return [];
}

function checkPermissions(
  manifest: PluginManifest,
  policy: SupplyChainPolicy,
): SupplyChainFinding[] {
  const findings: SupplyChainFinding[] = [];
  for (const perm of manifest.permissions) {
    if (policy.prohibitedPermissions.includes(perm.id)) {
      findings.push({
        check: 'permissions',
        severity: 'prohibited',
        blocking: true,
        ruleId: 'SC-PERMISSION-PROHIBITED',
        detail: `requested permission \`${perm.id}\` is never grantable`,
      });
    }
  }
  return findings;
}

function checkCompatibility(
  manifest: PluginManifest,
  policy: SupplyChainPolicy,
): SupplyChainFinding[] {
  const host = parseSemver(policy.hostVersion);
  const min = parseSemver(manifest.compatibility.minHostVersion);
  if (host === null || min === null) {
    return [
      {
        check: 'compatibility',
        severity: 'ambiguous',
        blocking: true,
        ruleId: 'SC-COMPAT-UNPARSEABLE',
        detail: 'host or declared compatibility version could not be parsed',
      },
    ];
  }
  if (!gte(host, min)) {
    return [
      {
        check: 'compatibility',
        severity: 'high',
        blocking: true,
        ruleId: 'SC-COMPAT-TOO-OLD',
        detail: 'host version is older than the declared minimum',
      },
    ];
  }
  if (manifest.compatibility.maxHostVersion) {
    const max = parseSemver(manifest.compatibility.maxHostVersion);
    if (max !== null && !gte(max, host)) {
      return [
        {
          check: 'compatibility',
          severity: 'high',
          blocking: true,
          ruleId: 'SC-COMPAT-TOO-NEW',
          detail: 'host version exceeds the declared maximum',
        },
      ];
    }
  }
  return [];
}

function checkRollback(manifest: PluginManifest): SupplyChainFinding[] {
  if (!manifest.rollbackAvailable) {
    return [
      {
        check: 'rollback',
        severity: 'ambiguous',
        blocking: true,
        ruleId: 'SC-ROLLBACK-UNAVAILABLE',
        detail: 'no rollback (prior verified artifact) is declared available',
      },
    ];
  }
  return [];
}

// ─── The gate ─────────────────────────────────────────────────────────────────

const BLOCKING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
  'high',
  'critical',
  'prohibited',
  'ambiguous',
]);

/**
 * Run the full ordered supply-chain gate over an untrusted manifest and
 * externally gathered evidence. Pure and deterministic.
 *
 * Decision (NN-SEC-012, NN-INV-001):
 *   - invalid manifest                              → `unavailable`
 *   - any blocking finding (high+/prohibited/ambig) → `blocked` (quarantined)
 *   - any medium finding                            → `requires-approval`
 *   - only low/info                                 → `activate`
 */
export function evaluateSupplyChainGate(
  manifestInput: unknown,
  evidence: SupplyChainEvidence,
  policy: SupplyChainPolicy,
  correlationId?: string,
): GateDecision {
  const validated = validatePluginManifest(manifestInput, correlationId);
  if (!validated.ok) {
    // A malformed / ambiguous manifest can never be partially installed.
    return { outcome: 'unavailable', error: validated.error };
  }
  const manifest = validated.value;

  const findings: SupplyChainFinding[] = [
    ...checkVersion(manifest),
    ...checkIdentity(evidence),
    ...checkIntegrity(manifest, evidence, policy),
    ...checkLicense(manifest, policy),
    ...checkInstallScripts(manifest, evidence),
    ...checkVulnerabilities(evidence),
    ...checkTyposquat(evidence),
    ...checkPermissions(manifest, policy),
    ...checkCompatibility(manifest, policy),
    ...checkRollback(manifest),
  ];

  const hasBlocking = findings.some(
    (f) => f.blocking || BLOCKING_SEVERITIES.has(f.severity),
  );
  if (hasBlocking) {
    return {
      outcome: 'blocked',
      quarantined: true,
      findings,
      error: gateError(
        'FORBIDDEN',
        'supply-chain gate blocked installation; artifact quarantined',
        'evaluate-supply-chain-gate',
        correlationId,
      ),
    };
  }

  const hasMedium = findings.some((f) => f.severity === 'medium');
  if (hasMedium) {
    return { outcome: 'requires-approval', manifest, findings };
  }

  return { outcome: 'activate', manifest, findings };
}
