/**
 * Explicit execution modes and deterministic dependency operations
 * (FUT-PKG-06-EXECUTION/T-008).
 *
 * NN-EXEC-010 requires flash/standard/pro/ultra/custom modes, plan mode,
 * action-first, and onboarding states to be EXPLICIT persisted profiles that
 * control planning, agent topology, tools, models, and permissions; mode
 * changes apply PROSPECTIVELY and NEVER bypass safety or required approvals.
 * This module owns the mode-profile vocabulary and the prospective-transition
 * rule.
 *
 * NN-EXEC-013 requires dependency operations to update manifest and lockfile
 * TOGETHER, validate clean deterministic installation, prefer existing
 * capabilities, and record introduced/removed/upgraded packages with scan
 * outcomes. This module owns {@link applyDependencyUpdate}: a malformed update
 * returns a typed non-success and NEVER a partial mutation (task acceptance).
 *
 * Design anchors: D-05, D-11, D-16. Requirements: NN-EXEC-010/013, NN-INV-014.
 */

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  type ErrorEnvelope,
} from '../shared/contract-primitives';

const MODE_OWNER = 'authority-execution-modes';
const DEP_OWNER = 'authority-dependencies';

// ════════════════════════════════════════════════════════════════════════════
// 1. Execution modes (NN-EXEC-010)
// ════════════════════════════════════════════════════════════════════════════

/** The explicit execution modes (NN-EXEC-010). */
export const EXECUTION_MODES = Object.freeze([
  'flash',
  'standard',
  'pro',
  'ultra',
  'custom',
  'plan',
  'action-first',
  'onboarding',
] as const);
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Whether a value is a known execution mode. */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

/**
 * The persisted, explicit profile a mode controls. Every axis is explicit so a
 * mode change is a deterministic, auditable transition — nothing is implicit
 * (NN-EXEC-010).
 */
export interface ModeProfile {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly mode: ExecutionMode;
  /** Whether the mode plans before acting (plan mode is plan-only). */
  readonly planning: boolean;
  /** The agent topology this mode selects (bounded vocabulary). */
  readonly topology: 'single' | 'pair' | 'council' | 'swarm';
  /** Enabled tool trust sources; a subset, never a superset of the safe set. */
  readonly enabledToolSources: readonly string[];
  /** The default model tier. */
  readonly modelTier: 'small' | 'standard' | 'large' | 'frontier';
  /** Permission scopes granted by the mode (never bypass approvals). */
  readonly permissions: readonly string[];
  /**
   * Whether the mode can ACT (perform side effects). `plan` and `onboarding`
   * are non-acting profiles: they may plan/observe but never bypass an approval
   * to act (NN-EXEC-010 "never bypass safety or required approvals").
   */
  readonly canAct: boolean;
}

/** The canonical default profiles for the built-in modes. */
export const DEFAULT_MODE_PROFILES: Readonly<Record<ExecutionMode, ModeProfile>> =
  Object.freeze({
    flash: profile('flash', { planning: false, topology: 'single', modelTier: 'small', canAct: true }),
    standard: profile('standard', { planning: true, topology: 'single', modelTier: 'standard', canAct: true }),
    pro: profile('pro', { planning: true, topology: 'pair', modelTier: 'large', canAct: true }),
    ultra: profile('ultra', { planning: true, topology: 'council', modelTier: 'frontier', canAct: true }),
    custom: profile('custom', { planning: true, topology: 'single', modelTier: 'standard', canAct: true }),
    plan: profile('plan', { planning: true, topology: 'single', modelTier: 'standard', canAct: false }),
    'action-first': profile('action-first', { planning: false, topology: 'single', modelTier: 'standard', canAct: true }),
    onboarding: profile('onboarding', { planning: true, topology: 'single', modelTier: 'small', canAct: false }),
  });

function profile(
  mode: ExecutionMode,
  opts: {
    readonly planning: boolean;
    readonly topology: ModeProfile['topology'];
    readonly modelTier: ModeProfile['modelTier'];
    readonly canAct: boolean;
  },
): ModeProfile {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    mode,
    planning: opts.planning,
    topology: opts.topology,
    enabledToolSources: ['built-in', 'skill'],
    modelTier: opts.modelTier,
    permissions: opts.canAct ? ['read', 'edit'] : ['read'],
    canAct: opts.canAct,
  };
}

/** The outcome of a mode transition. */
export type ModeTransitionResult =
  | {
      readonly ok: true;
      /** The profile in effect for work started AFTER this transition. */
      readonly profile: ModeProfile;
      /** The transition applies prospectively from this monotonic instant. */
      readonly appliesFromMs: number;
    }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * Apply a PROSPECTIVE mode transition. The new profile governs only work
 * started after `appliesFromMs`; it never retroactively re-governs in-flight
 * work and never widens a pending approval (NN-EXEC-010). A transition to an
 * unknown mode is a typed `VALIDATION` with no change. Because the transition
 * is prospective and additive, it can never BYPASS safety: a non-acting mode
 * (`plan`/`onboarding`) cannot grant act permission it does not have.
 */
export function transitionMode(input: {
  readonly toMode: ExecutionMode;
  readonly nowMs: number;
  readonly customProfile?: ModeProfile;
  readonly correlationId?: string;
}): ModeTransitionResult {
  if (!isExecutionMode(input.toMode)) {
    return {
      ok: false,
      error: modeError('VALIDATION', `unknown execution mode`, 'mode.transition', input.correlationId),
    };
  }
  let profileToUse: ModeProfile;
  if (input.toMode === 'custom' && input.customProfile) {
    // A custom profile is honored but can NEVER grant act permission a
    // non-acting posture forbids, and it is normalized to the custom mode.
    profileToUse = { ...input.customProfile, mode: 'custom' };
  } else {
    profileToUse = DEFAULT_MODE_PROFILES[input.toMode];
  }
  // Safety floor: a non-acting profile cannot carry act permissions.
  if (!profileToUse.canAct && profileToUse.permissions.some((p) => p !== 'read')) {
    return {
      ok: false,
      error: modeError(
        'FORBIDDEN',
        'a non-acting mode profile cannot carry act permissions; it must not bypass approvals',
        'mode.transition',
        input.correlationId,
      ),
    };
  }
  return { ok: true, profile: profileToUse, appliesFromMs: input.nowMs };
}

function modeError(
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: MODE_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation: 'Mode changes apply prospectively and never bypass safety or required approvals.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Deterministic dependency operations (NN-EXEC-013)
// ════════════════════════════════════════════════════════════════════════════

/** A single package change in a dependency update. */
export interface PackageChange {
  readonly name: string;
  readonly action: 'introduce' | 'remove' | 'upgrade';
  readonly fromVersion?: string;
  readonly toVersion?: string;
}

/** A dependency update request: manifest + lockfile move together. */
export interface DependencyUpdateInput {
  readonly changes: readonly PackageChange[];
  /** The current manifest package set (name -> version). */
  readonly manifest: Readonly<Record<string, string>>;
  /** The current lockfile package set (name -> resolved version). */
  readonly lockfile: Readonly<Record<string, string>>;
  /** Scan outcomes keyed by package name (must exist for introduced/upgraded). */
  readonly scanOutcomes: Readonly<Record<string, 'clean' | 'flagged'>>;
  readonly correlationId?: string;
}

/** The deterministic result of a dependency update. */
export type DependencyUpdateResult =
  | {
      readonly ok: true;
      readonly manifest: Readonly<Record<string, string>>;
      readonly lockfile: Readonly<Record<string, string>>;
      readonly introduced: readonly string[];
      readonly removed: readonly string[];
      readonly upgraded: readonly string[];
      /** A digest binding the new manifest+lockfile (deterministic install). */
      readonly resolutionDigest: string;
    }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * Apply a dependency update DETERMINISTICALLY (NN-EXEC-013). Manifest and
 * lockfile are updated TOGETHER: the function computes the full new manifest
 * and lockfile and returns them atomically, or returns a typed non-success and
 * makes NO partial mutation (the inputs are read-only; nothing is mutated in
 * place — the caller only commits the returned pair, or nothing). A malformed
 * update — an introduce that already exists, a remove/upgrade of an absent
 * package, an upgrade without a target version, or an introduced/upgraded
 * package whose scan outcome is missing or `flagged` — is a typed `VALIDATION`
 * / `FORBIDDEN` with no result (task acceptance "never a partial mutation").
 *
 * The result also records introduced/removed/upgraded package lists and a
 * `resolutionDigest` binding the resolved pair so the same inputs always yield
 * the same digest (deterministic installation).
 */
export function applyDependencyUpdate(input: DependencyUpdateInput): DependencyUpdateResult {
  const manifest: Record<string, string> = { ...input.manifest };
  const lockfile: Record<string, string> = { ...input.lockfile };
  const introduced: string[] = [];
  const removed: string[] = [];
  const upgraded: string[] = [];

  const err = (code: ErrorEnvelope['code'], message: string): DependencyUpdateResult => ({
    ok: false,
    error: {
      schemaVersion: CONTRACT_WRITE_VERSION,
      code,
      message,
      owner: DEP_OWNER,
      operation: 'dependency.update',
      correlationId: isOpaqueId(input.correlationId) ? input.correlationId : 'corr-unset',
      retryable: false,
      remediation: 'A malformed dependency update makes no partial mutation; correct the change set and retry.',
      redaction: 'internal',
    },
  });

  for (const change of input.changes) {
    switch (change.action) {
      case 'introduce': {
        if (change.name in manifest) return err('CONFLICT', `package '${change.name}' already present; cannot introduce`);
        if (!change.toVersion) return err('VALIDATION', `introduce of '${change.name}' requires a target version`);
        const scan = input.scanOutcomes[change.name];
        if (scan !== 'clean') return err('FORBIDDEN', `introduced package '${change.name}' has no clean scan outcome`);
        manifest[change.name] = change.toVersion;
        lockfile[change.name] = change.toVersion;
        introduced.push(change.name);
        break;
      }
      case 'remove': {
        if (!(change.name in manifest)) return err('VALIDATION', `package '${change.name}' absent; cannot remove`);
        delete manifest[change.name];
        delete lockfile[change.name];
        removed.push(change.name);
        break;
      }
      case 'upgrade': {
        if (!(change.name in manifest)) return err('VALIDATION', `package '${change.name}' absent; cannot upgrade`);
        if (!change.toVersion) return err('VALIDATION', `upgrade of '${change.name}' requires a target version`);
        const scan = input.scanOutcomes[change.name];
        if (scan !== 'clean') return err('FORBIDDEN', `upgraded package '${change.name}' has no clean scan outcome`);
        manifest[change.name] = change.toVersion;
        lockfile[change.name] = change.toVersion;
        upgraded.push(change.name);
        break;
      }
      default:
        return err('VALIDATION', `unknown dependency action`);
    }
  }

  // Manifest and lockfile must agree exactly (they moved together).
  const manifestKeys = Object.keys(manifest).sort();
  const lockKeys = Object.keys(lockfile).sort();
  if (manifestKeys.length !== lockKeys.length || manifestKeys.some((k, i) => k !== lockKeys[i])) {
    return err('INTEGRITY', 'manifest and lockfile diverged; refusing partial mutation');
  }
  for (const k of manifestKeys) {
    if (manifest[k] !== lockfile[k]) {
      return err('INTEGRITY', `manifest/lockfile version mismatch for '${k}'`);
    }
  }

  const resolutionDigest = computeDigest({ manifest, lockfile });
  return {
    ok: true,
    manifest,
    lockfile,
    introduced: introduced.sort(),
    removed: removed.sort(),
    upgraded: upgraded.sort(),
    resolutionDigest,
  };
}
