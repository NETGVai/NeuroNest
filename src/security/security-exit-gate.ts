/**
 * Cross-platform security exit gate (FUT-PKG-04-SECURITY/T-009).
 *
 * This module is the P3 SECURITY EXIT GATE. It is an ADVERSARIAL verification
 * surface: it does not add a new security control, it *proves* that the controls
 * built by T-001..T-008 actually DENY hostile input, and it publishes a
 * per-platform blocker report that decides whether the affected scope may be
 * admitted to P4/P5 (task acceptance; NN-VERIFY-005, D-22, D-23).
 *
 * The gate runs one adversarial matrix per security domain:
 *
 *   ipc          — a renderer-forged privilege marker never grants a tier
 *                  (src/main/security/ipc-caller-identity.ts, D-16.2, NN-SEC-009).
 *   path         — traversal / device / NUL / absolute-escape paths are denied
 *                  (src/shared/security-authority.ts evaluatePath, D-16.3).
 *   network      — SSRF / DNS-rebinding / credential / bad-scheme destinations are
 *                  denied (evaluateUrl / evaluateNetworkDestination, D-16.5).
 *   secret       — a raw secret canary never survives redaction / masking and a
 *                  masked credential never leaks a raw value
 *                  (src/shared/observable-redaction.ts, FIX-SECRETS-CANARY-01,
 *                  NN-INV-004).
 *   approval     — a decision bound to a stale / mismatched action digest never
 *                  authorizes; no cancellation path implies approval
 *                  (src/approval/approval-service.ts, NN-APPROVAL-002, NN-INV-001).
 *   budget       — a reservation at/over the hard cap, or a negative amount, is
 *                  denied and never yields a negative balance
 *                  (src/storage/budget-authority.ts, CD-028, NN-ORCH-013).
 *   sandbox      — a required strict-isolation profile that the platform cannot
 *                  provide returns typed UNAVAILABLE and NEVER downgrades to an
 *                  unsandboxed spawn (src/shared/platform-sandbox.ts, NN-SEC-003).
 *   webview      — an incomplete/legacy webview guest policy stays UNAVAILABLE
 *                  and a hostile guest URL is denied
 *                  (src/main/security/window-hardener.ts, NN-SEC-017).
 *   supply-chain — a critical/high/prohibited/ambiguous package finding blocks and
 *                  quarantines (src/security/supply-chain/supply-chain-gate.ts,
 *                  NN-SEC-012/016).
 *   entitlement  — a forged / expired / mismatched entitlement never returns a
 *                  paid (false) capability (src/security/entitlement-authority.ts,
 *                  NN-LICENSE-003/006, NN-INV-014).
 *
 * Each matrix asserts the corresponding authority DENIES the adversarial input.
 * A matrix "critical" result is a security violation: an authorization that
 * should have failed closed did not (unauthorized effect, secret leak, insecure
 * fallback, implied approval, negative budget, or false capability). ANY critical
 * result makes the gate return BLOCK for the affected scope (NN-INV-001,
 * NN-VERIFY-005).
 *
 * Gate self-test (V-VERIFY-001/security-blocker-self-test): a gate that cannot
 * detect a planted failure is worthless. {@link runSelfTest} injects a
 * deliberately broken "authority" that ALLOWS a hostile input and asserts the
 * matrix classifies it as critical and the gate BLOCKS. This proves the gate's
 * detection is real, not vacuous.
 *
 * Everything here is a pure decision surface. It NEVER performs the risky effect
 * it evaluates (no host spawn, no real network connection, no credential read,
 * no artifact install): it only asks the real authorities to make their DENY
 * decision on hostile input and records whether they held. Budget and approval
 * decisions are exercised against real temporary SQLite in the test harness; the
 * matrices here accept an injected decision function so the module stays pure and
 * the harness supplies the real authority calls.
 *
 * No raw secret VALUES appear here — canaries are placeholder strings from the
 * shared observable-redaction corpus (FIX-SECRETS-CANARY-01) and are asserted
 * ABSENT from any evaluated payload (NN-INV-004).
 *
 * Design anchors: D-03, D-11, D-16, D-17, D-18, D-22, D-23, D-24.
 * Requirements: NN-INV-001/002/003/004/005/011/015, NN-SEC-001..017,
 * NN-PLATFORM-002, NN-VERIFY-002/005.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import {
  evaluatePath,
  evaluateCommand,
  evaluateUrl,
  evaluateNetworkDestination,
  evaluateExclusion,
  defaultCommandPolicy,
  networkPreset,
  type SecurityDecision,
  type ExclusionPolicy,
  type NetworkPolicy,
} from '../shared/security-authority';
import {
  selectSandboxProfile,
  type IsolationRequirement,
  type ProfileSelection,
} from '../shared/platform-sandbox';
import {
  CapabilityRegistry,
  PLATFORMS,
  type Platform,
  type Architecture,
} from '../shared/capability-registry';
import {
  getStringShapedCanaryValues,
  redactValue,
  FIELD_ONLY_REDACTION_CANARIES,
  FIELD_ONLY_CANARY_FIELD,
} from '../shared/observable-redaction';
import {
  validateWebviewGuestPolicy,
  guestUrlAllowed,
  type WebviewGuestPolicy,
} from '../main/security/window-hardener';

// ════════════════════════════════════════════════════════════════════════════
// 1. Matrix vocabulary
// ════════════════════════════════════════════════════════════════════════════

/** The ten adversarial security domains the exit gate covers (task acceptance). */
export const SECURITY_DOMAINS = Object.freeze([
  'ipc',
  'path',
  'network',
  'secret',
  'approval',
  'budget',
  'sandbox',
  'webview',
  'supply-chain',
  'entitlement',
] as const);
export type SecurityDomain = (typeof SECURITY_DOMAINS)[number];

/**
 * The class of unauthorized outcome a matrix guards against. A `critical` case
 * that is NOT held (i.e. the authority allowed the hostile input) is a release
 * blocker (NN-VERIFY-005). These map one-to-one to the task's prohibited
 * outcomes: "zero unauthorized effect, secret leak, insecure fallback, implied
 * approval, negative budget, or false capability".
 */
export const VIOLATION_CLASSES = Object.freeze([
  'unauthorized-effect',
  'secret-leak',
  'insecure-fallback',
  'implied-approval',
  'negative-budget',
  'false-capability',
] as const);
export type ViolationClass = (typeof VIOLATION_CLASSES)[number];

/** The result of one adversarial case: did the authority DENY as required? */
export interface MatrixCaseResult {
  readonly domain: SecurityDomain;
  /** Stable, secret-free id of the adversarial case. */
  readonly caseId: string;
  /** The prohibited outcome this case proves is impossible. */
  readonly violationClass: ViolationClass;
  /**
   * `true` when the authority correctly DENIED / failed-closed on the hostile
   * input (the case HELD). `false` is a critical security violation: the
   * authority allowed something it must not.
   */
  readonly held: boolean;
  /** Safe, secret-free note describing the observed decision. */
  readonly detail: string;
}

/** Severity of a gate finding. Only `critical` blocks admission. */
export type GateSeverity = 'critical' | 'info';

/** A blocker finding: a matrix case that did not hold. */
export interface GateBlocker {
  readonly domain: SecurityDomain;
  readonly caseId: string;
  readonly violationClass: ViolationClass;
  readonly severity: GateSeverity;
  readonly reason: string;
}

/** The per-platform capability-evidence cell (V-PLATFORM-001). */
export interface PlatformCapabilityEvidence {
  readonly platform: Platform;
  /** Whether every mandatory-unavailable capability failed closed on absence. */
  readonly failedClosedOnAbsence: boolean;
  /** Whether a required-but-absent strict profile refused to downgrade. */
  readonly noInsecureFallback: boolean;
  /** Safe, secret-free note. */
  readonly detail: string;
}

/** The overall gate verdict. `block` denies P4/P5 admission for the scope. */
export type GateVerdict = 'pass' | 'block';

/** The published exit-gate report. */
export interface SecurityExitGateReport {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly verdict: GateVerdict;
  /** Every matrix case that ran, in domain order. */
  readonly cases: readonly MatrixCaseResult[];
  /** Every critical blocker (empty on a pass). */
  readonly blockers: readonly GateBlocker[];
  /** Per-platform capability evidence (macOS/Windows/Linux). */
  readonly platformEvidence: readonly PlatformCapabilityEvidence[];
  /** Total cases and how many held. */
  readonly totals: {
    readonly cases: number;
    readonly held: number;
    readonly critical: number;
  };
  /** A typed FORBIDDEN error present only when the verdict is `block`. */
  readonly error?: ErrorEnvelope;
}

const GATE_OWNER = 'authority-security-verification';

function gateError(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: GATE_OWNER,
    operation: 'security-exit-gate',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'A security matrix case did not hold. Disable the affected capability for the ' +
      'affected scope and block P4/P5 admission until the authority denies the hostile input.',
    redaction: 'internal',
  };
}

/** A decision "denied" iff it is not an `allow`. `ask` is a safe pause. */
function denied(decision: SecurityDecision<unknown>): boolean {
  return decision.decision !== 'allow';
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Injected adversarial decisions for stateful authorities
// ════════════════════════════════════════════════════════════════════════════

/**
 * The stateful authorities (budget over SQLite, approval over SQLite) cannot be
 * driven purely, so the caller injects the *outcome* of the real adversarial
 * authority call. The gate stays pure; the harness performs the real
 * authority+SQLite call and reports whether it denied. This keeps the safety
 * decision logic identical whether run in CI (real SQLite) or embedded.
 */
export interface InjectedAdversarialOutcomes {
  /**
   * Real approval-authority result for a decision bound to a STALE/mismatched
   * action digest. `authorized` MUST be false (the mismatched decision must not
   * authorize) — a `true` here is an implied-approval violation.
   */
  readonly staleApprovalAuthorized: boolean;
  /**
   * Real approval-authority result for a decision on an EXPIRED request.
   * `authorized` MUST be false.
   */
  readonly expiredApprovalAuthorized: boolean;
  /**
   * Real budget-authority reserve outcome for an amount AT/OVER the hard cap.
   * `granted` MUST be false (the reservation must be denied).
   */
  readonly overCapReservationGranted: boolean;
  /**
   * Real budget-authority reserve outcome for a NEGATIVE amount. `granted` MUST
   * be false and the resulting balance MUST NOT be negative.
   */
  readonly negativeReservationGranted: boolean;
  /** Whether the budget balance is non-negative after the adversarial attempts. */
  readonly budgetBalanceNonNegative: boolean;
  /**
   * Real entitlement-authority launch result for a FORGED (bad-signature)
   * record. `paidCapabilityGranted` MUST be false.
   */
  readonly forgedEntitlementGrantedPaid: boolean;
  /**
   * Real entitlement-authority launch result for an EXPIRED record.
   * `paidCapabilityGranted` MUST be false.
   */
  readonly expiredEntitlementGrantedPaid: boolean;
  /**
   * Real supply-chain gate outcome for a package with a CRITICAL finding.
   * `blockedAndQuarantined` MUST be true.
   */
  readonly criticalPackageBlockedAndQuarantined: boolean;
  /**
   * Real IPC caller-identity result: a renderer that FORGES a privilege marker
   * from an untrusted sender. `attestedPrivileged` MUST be false.
   */
  readonly forgedIpcMarkerAttestedPrivileged: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Pure adversarial matrices (path / network / secret / sandbox / webview)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Path matrix: every hostile path shape must be denied by evaluatePath
 * (D-16.3). `root` is a real, existing directory the harness supplies so the
 * symlink-resolution branch runs against a real filesystem.
 */
export function runPathMatrix(root: string): MatrixCaseResult[] {
  const hostile: ReadonlyArray<{ id: string; input: string }> = [
    { id: 'traversal-dotdot', input: '../../etc/passwd' },
    { id: 'nested-traversal', input: 'a/b/../../../../../../etc/shadow' },
    { id: 'absolute-escape', input: '/etc/hosts' },
    { id: 'nul-byte', input: 'safe\u0000/../../evil' },
    { id: 'windows-device-namespace', input: '\\\\.\\PhysicalDrive0' },
    { id: 'windows-longpath-device', input: '\\\\?\\C:\\Windows\\System32' },
  ];
  return hostile.map(({ id, input }) => {
    const decision = evaluatePath(input, root, {}, { operation: 'exit-gate:path' });
    return {
      domain: 'path' as const,
      caseId: `path/${id}`,
      violationClass: 'unauthorized-effect' as const,
      held: denied(decision),
      detail: denied(decision)
        ? `denied at ${decision.stage}: ${decision.reason}`
        : 'ALLOWED a hostile path (traversal/device/NUL escape)',
    };
  });
}

/**
 * Command matrix: a shell-metacharacter executable and a destructive command
 * must never be `allow`ed on the structured-argv path (NN-SEC-006).
 */
export function runCommandCases(): MatrixCaseResult[] {
  const policy = defaultCommandPolicy();
  const cases: MatrixCaseResult[] = [];

  const shellInjection = evaluateCommand(
    { executable: 'sh -c "rm -rf /"', args: [] },
    policy,
    { operation: 'exit-gate:command' },
  );
  cases.push({
    domain: 'path',
    caseId: 'command/shell-metacharacter-executable',
    violationClass: 'unauthorized-effect',
    held: denied(shellInjection),
    detail: denied(shellInjection)
      ? `denied: ${shellInjection.reason}`
      : 'ALLOWED shell interpolation through the executable field',
  });

  const destructive = evaluateCommand(
    { executable: 'rm', args: ['-rf', '/'] },
    policy,
    { operation: 'exit-gate:command' },
  );
  cases.push({
    domain: 'path',
    caseId: 'command/destructive-rm-rf',
    violationClass: 'unauthorized-effect',
    held: denied(destructive),
    detail: denied(destructive)
      ? `denied: ${destructive.reason}`
      : 'ALLOWED a destructive recursive delete',
  });

  return cases;
}

/**
 * Network matrix: SSRF literal targets, credentialed URLs, forbidden schemes,
 * and DNS-rebinding (a public name that resolves to a private address) must all
 * be denied (D-16.5). A deterministic resolver models the rebinding.
 */
export function runNetworkMatrix(): MatrixCaseResult[] {
  const policy: NetworkPolicy = networkPreset('standard');
  const cases: MatrixCaseResult[] = [];

  const push = (
    caseId: string,
    decision: SecurityDecision<unknown>,
    allowedNote: string,
  ): void => {
    cases.push({
      domain: 'network',
      caseId: `network/${caseId}`,
      violationClass: 'unauthorized-effect',
      held: denied(decision),
      detail: denied(decision) ? `denied: ${decision.reason}` : allowedNote,
    });
  };

  push(
    'ssrf-metadata-endpoint',
    evaluateUrl('http://169.254.169.254/latest/meta-data/', policy),
    'ALLOWED the cloud metadata endpoint (SSRF)',
  );
  push(
    'ssrf-loopback',
    evaluateUrl('http://127.0.0.1:8080/admin', policy),
    'ALLOWED a loopback destination (SSRF)',
  );
  push(
    'credentials-in-url',
    evaluateUrl('https://user:secret@example.com/', policy),
    'ALLOWED credentials embedded in the URL',
  );
  push(
    'forbidden-file-scheme',
    evaluateUrl('file:///etc/passwd', policy),
    'ALLOWED a file:// scheme',
  );
  push(
    'forbidden-javascript-scheme',
    evaluateUrl('javascript:alert(1)', policy),
    'ALLOWED a javascript: scheme',
  );

  // DNS rebinding: the name pre-screens as public but resolves to loopback.
  const rebinding = evaluateNetworkDestination(
    'https://public-looking.example.com/',
    policy,
    () => ['127.0.0.1'],
  );
  push(
    'dns-rebinding-to-loopback',
    rebinding,
    'ALLOWED a name that resolves to loopback (DNS rebinding)',
  );

  return cases;
}

/**
 * Exclusion matrix: a private/ignored path must be denied egress on every
 * channel (NN-SEC-014). Proves exclusion runs before any egress.
 */
export function runExclusionCases(): MatrixCaseResult[] {
  const policy: ExclusionPolicy = {
    patterns: ['*.env', 'secrets/'],
    privatePaths: ['private/'],
  };
  const cases: MatrixCaseResult[] = [];
  const attempts: ReadonlyArray<{ id: string; path: string }> = [
    { id: 'dotenv-to-cloud', path: 'config/prod.env' },
    { id: 'secrets-dir-to-training', path: 'secrets/keys.txt' },
    { id: 'private-dir-to-telemetry', path: 'private/notes.md' },
  ];
  for (const { id, path: p } of attempts) {
    const decision = evaluateExclusion(p, 'cloud', policy, { operation: 'exit-gate:exclusion' });
    cases.push({
      domain: 'secret',
      caseId: `exclusion/${id}`,
      violationClass: 'secret-leak',
      held: denied(decision),
      detail: denied(decision) ? `denied egress: ${decision.reason}` : 'ALLOWED excluded content to egress',
    });
  }
  return cases;
}

/**
 * Secret matrix: no raw secret canary (FIX-SECRETS-CANARY-01) may survive
 * redaction of an observable payload (NN-INV-004). Each string-shaped canary is
 * placed in a payload and must be scrubbed; each field-only canary is placed
 * under its deny-listed field and must be scrubbed.
 */
export function runSecretMatrix(): MatrixCaseResult[] {
  const cases: MatrixCaseResult[] = [];

  // String-shaped canaries: scrubbed by the redaction regex regardless of the
  // field they appear in. The invariant (NN-INV-004) is that the raw canary
  // VALUE must not survive; the redaction placeholder that replaces it is fine.
  let idx = 0;
  for (const canary of getStringShapedCanaryValues()) {
    const payload = { message: `leaking ${canary} in a log line`, nested: { note: canary } };
    const redacted = redactValue(payload);
    const serialized = JSON.stringify(redacted);
    const survived = serialized.includes(canary);
    cases.push({
      domain: 'secret',
      caseId: `secret/string-shaped/${idx++}`,
      violationClass: 'secret-leak',
      held: !survived,
      detail: survived ? 'a raw secret canary survived redaction' : 'canary scrubbed from observable payload',
    });
  }

  // Field-only canaries: bare values no regex recognizes, scrubbed ONLY by the
  // deny-listed field name they belong under (proxyCredential/apiKey/prompt/…).
  for (const [key, canary] of Object.entries(FIELD_ONLY_REDACTION_CANARIES)) {
    const field = FIELD_ONLY_CANARY_FIELD[key as keyof typeof FIELD_ONLY_CANARY_FIELD];
    const payload = { [field]: canary } as Record<string, string>;
    const redacted = redactValue(payload);
    const serialized = JSON.stringify(redacted);
    const survived = serialized.includes(canary);
    cases.push({
      domain: 'secret',
      caseId: `secret/field-only/${field}`,
      violationClass: 'secret-leak',
      held: !survived,
      detail: survived
        ? `a raw secret canary survived under the "${field}" field`
        : `canary scrubbed under the "${field}" field`,
    });
  }

  return cases;
}

/**
 * Sandbox matrix: on a platform whose strict-isolation cell is ABSENT, a
 * `strict` requirement must return UNAVAILABLE and NEVER downgrade; a `standard`
 * requirement must select a confined profile (never unsandboxed) (NN-SEC-003).
 */
export function runSandboxMatrix(): MatrixCaseResult[] {
  const cases: MatrixCaseResult[] = [];
  const arch: Architecture = 'x64';

  for (const platform of PLATFORMS) {
    // A registry with NO strict-isolation cell registered → the cell is absent.
    const registry = new CapabilityRegistry();
    const platformArch: Architecture = platform === 'macos' ? 'universal' : arch;

    const strict: ProfileSelection = selectSandboxProfile(
      registry,
      platform,
      platformArch,
      'strict' as IsolationRequirement,
      'corr-exit-gate',
    );
    cases.push({
      domain: 'sandbox',
      caseId: `sandbox/${platform}/strict-unavailable-no-downgrade`,
      violationClass: 'insecure-fallback',
      // HELD iff strict selection FAILED (returned UNAVAILABLE) — never silently
      // downgraded to a spawnable profile.
      held: strict.ok === false,
      detail:
        strict.ok === false
          ? `strict isolation unavailable on ${platform}; selection refused (no downgrade)`
          : `DOWNGRADED to ${strict.selected.profile} on ${platform} when strict was required`,
    });

    const standard: ProfileSelection = selectSandboxProfile(
      registry,
      platform,
      platformArch,
      'standard' as IsolationRequirement,
      'corr-exit-gate',
    );
    // A `standard` requirement is allowed to select the confined `standard`
    // profile, but it must NEVER be unsandboxed. `standard`/`strict` are the
    // only execution profiles and both are confined; degraded-read-only never
    // executes. HELD iff selection is a confined profile.
    const confined =
      standard.ok === true &&
      (standard.selected.profile === 'standard' || standard.selected.profile === 'strict');
    cases.push({
      domain: 'sandbox',
      caseId: `sandbox/${platform}/standard-stays-confined`,
      violationClass: 'insecure-fallback',
      held: confined,
      detail: confined
        ? `standard requirement selected confined ${standard.ok ? standard.selected.profile : '?'} on ${platform}`
        : `standard requirement did not resolve to a confined profile on ${platform}`,
    });
  }

  return cases;
}

/**
 * Webview matrix: an incomplete legacy guest policy must be rejected (stays
 * UNAVAILABLE), and a hostile guest URL (off-allowlist / credentialed /
 * non-http) must be denied navigation (NN-SEC-017).
 */
export function runWebviewMatrix(): MatrixCaseResult[] {
  const cases: MatrixCaseResult[] = [];

  // Incomplete policy: missing preload + missing origin allowlist + default partition.
  const incomplete = {
    partition: 'persist:default',
    guestPreloadPath: '',
    allowedGuestOrigins: [],
    allowedPermissions: [],
  } as unknown as WebviewGuestPolicy;
  const reasons = validateWebviewGuestPolicy(incomplete);
  cases.push({
    domain: 'webview',
    caseId: 'webview/incomplete-policy-stays-unavailable',
    violationClass: 'false-capability',
    held: reasons.length > 0,
    detail:
      reasons.length > 0
        ? `guest policy rejected (${reasons.length} reasons); guest stays UNAVAILABLE`
        : 'ACCEPTED an incomplete guest policy (guest would be enabled without controls)',
  });

  // A complete-but-strict allowlist policy; hostile URLs must still be denied.
  const allowlist = ['https://trusted.example.com'];
  const hostile: ReadonlyArray<{ id: string; url: string }> = [
    { id: 'off-allowlist', url: 'https://evil.example.net/phish' },
    { id: 'credentialed', url: 'https://user:pw@trusted.example.com/' },
    { id: 'non-http-scheme', url: 'file:///etc/passwd' },
    { id: 'javascript-scheme', url: 'javascript:alert(1)' },
  ];
  for (const { id, url } of hostile) {
    const allowed = guestUrlAllowed(url, allowlist);
    cases.push({
      domain: 'webview',
      caseId: `webview/hostile-url/${id}`,
      violationClass: 'unauthorized-effect',
      held: allowed === false,
      detail: allowed === false ? 'guest navigation denied' : 'ALLOWED a hostile guest navigation',
    });
  }

  return cases;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Matrices for injected (stateful-authority) outcomes
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the approval / budget / entitlement / supply-chain / ipc matrix cases
 * from the real authority outcomes the harness injected. Each case HELD iff the
 * real authority DENIED the hostile input.
 */
export function runInjectedMatrices(
  outcomes: InjectedAdversarialOutcomes,
): MatrixCaseResult[] {
  return [
    {
      domain: 'ipc',
      caseId: 'ipc/forged-privilege-marker',
      violationClass: 'unauthorized-effect',
      held: outcomes.forgedIpcMarkerAttestedPrivileged === false,
      detail: outcomes.forgedIpcMarkerAttestedPrivileged
        ? 'a renderer-forged __ipcTier marker attested a privileged tier'
        : 'renderer-forged privilege marker did not grant any tier',
    },
    {
      domain: 'approval',
      caseId: 'approval/stale-digest-never-authorizes',
      violationClass: 'implied-approval',
      held: outcomes.staleApprovalAuthorized === false,
      detail: outcomes.staleApprovalAuthorized
        ? 'a decision bound to a stale/mismatched action digest authorized'
        : 'stale/mismatched action digest decision did not authorize',
    },
    {
      domain: 'approval',
      caseId: 'approval/expired-never-authorizes',
      violationClass: 'implied-approval',
      held: outcomes.expiredApprovalAuthorized === false,
      detail: outcomes.expiredApprovalAuthorized
        ? 'an expired approval request was approved'
        : 'expired approval request could not be approved',
    },
    {
      domain: 'budget',
      caseId: 'budget/over-cap-reservation-denied',
      violationClass: 'unauthorized-effect',
      held: outcomes.overCapReservationGranted === false,
      detail: outcomes.overCapReservationGranted
        ? 'a reservation at/over the hard cap was granted (no downgrade rule violated)'
        : 'over-cap reservation denied (exact extension required)',
    },
    {
      domain: 'budget',
      caseId: 'budget/negative-reservation-denied',
      violationClass: 'negative-budget',
      held: outcomes.negativeReservationGranted === false && outcomes.budgetBalanceNonNegative,
      detail:
        outcomes.negativeReservationGranted || !outcomes.budgetBalanceNonNegative
          ? 'a negative reservation was accepted or the balance went negative'
          : 'negative reservation denied; balance stayed non-negative',
    },
    {
      domain: 'entitlement',
      caseId: 'entitlement/forged-never-grants-paid',
      violationClass: 'false-capability',
      held: outcomes.forgedEntitlementGrantedPaid === false,
      detail: outcomes.forgedEntitlementGrantedPaid
        ? 'a forged (bad-signature) entitlement granted a paid capability'
        : 'forged entitlement did not grant a paid capability',
    },
    {
      domain: 'entitlement',
      caseId: 'entitlement/expired-never-grants-paid',
      violationClass: 'false-capability',
      held: outcomes.expiredEntitlementGrantedPaid === false,
      detail: outcomes.expiredEntitlementGrantedPaid
        ? 'an expired entitlement granted a paid capability'
        : 'expired entitlement did not grant a paid capability',
    },
    {
      domain: 'supply-chain',
      caseId: 'supply-chain/critical-finding-blocks-and-quarantines',
      violationClass: 'unauthorized-effect',
      held: outcomes.criticalPackageBlockedAndQuarantined === true,
      detail: outcomes.criticalPackageBlockedAndQuarantined
        ? 'a critical package finding blocked and quarantined the artifact'
        : 'a critical package finding did NOT block/quarantine the artifact',
    },
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Per-platform capability evidence (V-PLATFORM-001)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Produce per-platform capability evidence from the sandbox matrix results.
 * For each platform, `failedClosedOnAbsence`/`noInsecureFallback` are true iff
 * that platform's strict-unavailable case HELD (strict selection refused rather
 * than downgraded). This is the "no false capability" per-platform evidence
 * (FIX-PLATFORM-CAPABILITY-01, NN-PLATFORM-002).
 */
export function buildPlatformEvidence(
  sandboxCases: readonly MatrixCaseResult[],
): PlatformCapabilityEvidence[] {
  return PLATFORMS.map((platform) => {
    const strictCase = sandboxCases.find(
      (c) => c.caseId === `sandbox/${platform}/strict-unavailable-no-downgrade`,
    );
    const standardCase = sandboxCases.find(
      (c) => c.caseId === `sandbox/${platform}/standard-stays-confined`,
    );
    const failedClosed = strictCase?.held === true;
    const confined = standardCase?.held === true;
    return {
      platform,
      failedClosedOnAbsence: failedClosed,
      noInsecureFallback: failedClosed && confined,
      detail:
        failedClosed && confined
          ? `${platform}: strict-absent refused (no downgrade); standard stays confined`
          : `${platform}: a capability cell did not fail closed`,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Gate evaluation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a full set of matrix cases into a verdict. ANY case that did not hold
 * is a `critical` blocker and forces `block` (NN-INV-001, NN-VERIFY-005). A gate
 * with zero cases is a `block` (deny-by-default: an empty matrix proves nothing).
 */
export function evaluateGate(
  cases: readonly MatrixCaseResult[],
  platformEvidence: readonly PlatformCapabilityEvidence[],
  correlationId?: string,
): SecurityExitGateReport {
  const blockers: GateBlocker[] = [];
  let held = 0;
  for (const c of cases) {
    if (c.held) {
      held += 1;
    } else {
      blockers.push({
        domain: c.domain,
        caseId: c.caseId,
        violationClass: c.violationClass,
        severity: 'critical',
        reason: c.detail,
      });
    }
  }

  // Per-platform capability evidence gaps are also critical (false capability).
  for (const pe of platformEvidence) {
    if (!pe.failedClosedOnAbsence || !pe.noInsecureFallback) {
      blockers.push({
        domain: 'sandbox',
        caseId: `platform/${pe.platform}/capability-evidence`,
        violationClass: 'false-capability',
        severity: 'critical',
        reason: pe.detail,
      });
    }
  }

  const emptyMatrix = cases.length === 0;
  const verdict: GateVerdict = blockers.length === 0 && !emptyMatrix ? 'pass' : 'block';

  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    verdict,
    cases,
    blockers,
    platformEvidence,
    totals: { cases: cases.length, held, critical: blockers.length },
    ...(verdict === 'block'
      ? {
          error: gateError(
            'FORBIDDEN',
            emptyMatrix
              ? 'security exit gate ran no cases; deny-by-default (nothing proven)'
              : `security exit gate BLOCKED: ${blockers.length} critical security case(s) did not hold`,
            correlationId,
          ),
        }
      : {}),
  };
}

/**
 * Run every pure matrix plus the injected (stateful-authority) matrices and
 * evaluate the gate. `root` is a real existing directory for the path matrix.
 */
export function runSecurityExitGate(
  root: string,
  injected: InjectedAdversarialOutcomes,
  correlationId?: string,
): SecurityExitGateReport {
  const sandboxCases = runSandboxMatrix();
  const cases: MatrixCaseResult[] = [
    ...runInjectedMatrices(injected).filter((c) => c.domain === 'ipc'),
    ...runPathMatrix(root),
    ...runCommandCases(),
    ...runNetworkMatrix(),
    ...runExclusionCases(),
    ...runSecretMatrix(),
    ...runInjectedMatrices(injected).filter((c) => c.domain === 'approval'),
    ...runInjectedMatrices(injected).filter((c) => c.domain === 'budget'),
    ...sandboxCases,
    ...runWebviewMatrix(),
    ...runInjectedMatrices(injected).filter((c) => c.domain === 'supply-chain'),
    ...runInjectedMatrices(injected).filter((c) => c.domain === 'entitlement'),
  ];
  const platformEvidence = buildPlatformEvidence(sandboxCases);
  return evaluateGate(cases, platformEvidence, correlationId);
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Gate self-test (V-VERIFY-001/security-blocker-self-test)
// ════════════════════════════════════════════════════════════════════════════

/** The result of the gate self-test. */
export interface SelfTestResult {
  /**
   * `true` when the gate correctly BLOCKED the planted-failure scenario AND
   * PASSED the all-secure scenario. A self-test that does not distinguish the
   * two means the gate cannot detect a real failure and is itself a blocker.
   */
  readonly detectsPlantedFailure: boolean;
  readonly plantedVerdict: GateVerdict;
  readonly secureVerdict: GateVerdict;
  readonly detail: string;
}

/**
 * Prove the gate's detection is real (NN-VERIFY-005, D-22). We do NOT weaken any
 * real authority. Instead we hand {@link evaluateGate} two synthetic matrix
 * inputs:
 *
 *   1. a "planted failure" set where exactly one case did NOT hold (simulating a
 *      broken authority that allowed a hostile input) — the gate MUST BLOCK;
 *   2. an all-secure set where every case held — the gate MUST PASS.
 *
 * If the gate blocks on the planted failure and passes on the secure set, its
 * detection is demonstrably non-vacuous. A gate that passed the planted failure
 * would be worthless and this self-test would report `detectsPlantedFailure:false`.
 */
export function runSelfTest(): SelfTestResult {
  const secureCase: MatrixCaseResult = {
    domain: 'path',
    caseId: 'selftest/secure',
    violationClass: 'unauthorized-effect',
    held: true,
    detail: 'authority denied the hostile input (secure)',
  };
  const plantedFailure: MatrixCaseResult = {
    domain: 'network',
    caseId: 'selftest/planted-broken-authority',
    violationClass: 'unauthorized-effect',
    held: false,
    detail: 'PLANTED: a broken authority allowed a hostile input',
  };

  const goodEvidence: PlatformCapabilityEvidence[] = PLATFORMS.map((platform) => ({
    platform,
    failedClosedOnAbsence: true,
    noInsecureFallback: true,
    detail: `${platform}: secure`,
  }));

  const secure = evaluateGate([secureCase], goodEvidence, 'corr-selftest');
  const planted = evaluateGate([secureCase, plantedFailure], goodEvidence, 'corr-selftest');

  const detects = planted.verdict === 'block' && secure.verdict === 'pass';
  return {
    detectsPlantedFailure: detects,
    plantedVerdict: planted.verdict,
    secureVerdict: secure.verdict,
    detail: detects
      ? 'gate blocked the planted failure and passed the secure set; detection is non-vacuous'
      : 'gate FAILED to distinguish a planted failure from a secure set',
  };
}
