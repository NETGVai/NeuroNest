/**
 * Sandboxed, quarantined staged installation of plugins / MCP servers
 * (NN-SEC-012/016, NN-INTEGRATION-003, D-16.7).
 *
 * FUT-PKG-04-SECURITY/T-008. "Installation is staged/quarantined until checks
 * and approval pass" (D-16.7). This module orchestrates the safe order:
 *
 *   1. The scanner (resource-bounded) gathers evidence.
 *   2. The supply-chain gate decides over the manifest + evidence.
 *   3. Staging runs UNDER THE SELECTED SANDBOX PROFILE (never an unsandboxed
 *      host spawn); if the required isolation is unavailable the install is
 *      `unavailable`, never host-executed silently (NN-SEC-016).
 *   4. Activation happens ONLY after the gate returns `activate` (or an
 *      `approved` medium-finding path); a blocked artifact stays quarantined
 *      and never activates.
 *
 * Rollback: `rollbackStagedInstall` removes the staged capability and returns
 * the artifact to quarantine, preserving the local audit record. It never
 * leaves a half-installed capability active.
 *
 * Pure/deterministic: sandbox selection reads the descriptive Capability
 * Registry only and performs no real spawn, so the safety decision is testable.
 *
 * Requirements: NN-SEC-012, NN-SEC-016, NN-INTEGRATION-003, NN-INV-001,
 * NN-INV-005, NN-INV-006, NN-INV-011, NN-INV-014.
 * Design anchors: D-03, D-16 (D-16.4, D-16.7), D-24.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorEnvelope,
} from '../../shared/contract-primitives';
import {
  selectSandboxProfile,
  profileMayExecute,
  type IsolationRequirement,
} from '../../shared/platform-sandbox';
import {
  CapabilityRegistry,
  type Architecture,
  type Platform,
} from '../../shared/capability-registry';
import {
  evaluateSupplyChainGate,
  type GateDecision,
  type SupplyChainEvidence,
  type SupplyChainPolicy,
  type SupplyChainFinding,
} from './supply-chain-gate';
import type { PluginManifest } from './plugin-manifest-validator';

/** The lifecycle state of a candidate artifact. */
export const INSTALL_STATES = Object.freeze([
  'quarantined',
  'staged',
  'activated',
] as const);
export type InstallState = (typeof INSTALL_STATES)[number];

/** The terminal outcome of a staged-install attempt. */
export type StagedInstallResult =
  | {
      readonly outcome: 'activated';
      readonly state: 'activated';
      readonly manifest: PluginManifest;
      readonly sandboxProfile: string;
      readonly findings: readonly SupplyChainFinding[];
    }
  | {
      readonly outcome: 'requires-approval';
      readonly state: 'staged';
      readonly manifest: PluginManifest;
      readonly sandboxProfile: string;
      readonly findings: readonly SupplyChainFinding[];
    }
  | {
      readonly outcome: 'quarantined';
      readonly state: 'quarantined';
      readonly findings: readonly SupplyChainFinding[];
      readonly error: ErrorEnvelope;
    }
  | {
      readonly outcome: 'unavailable';
      readonly state: 'quarantined';
      readonly error: ErrorEnvelope;
    };

/**
 * Run the full gate-then-stage-then-activate pipeline. Isolation requirement is
 * derived from the manifest's declared sandbox profile: a `degraded-read-only`
 * plugin needs no execution profile; anything else needs a real execution
 * sandbox and therefore `strict`/`standard` isolation.
 */
export function stageInstall(
  manifestInput: unknown,
  evidence: SupplyChainEvidence,
  policy: SupplyChainPolicy,
  registry: CapabilityRegistry,
  platform: Platform,
  architecture: Architecture,
  correlationId?: string,
): StagedInstallResult {
  const decision: GateDecision = evaluateSupplyChainGate(
    manifestInput,
    evidence,
    policy,
    correlationId,
  );

  if (decision.outcome === 'unavailable') {
    return { outcome: 'unavailable', state: 'quarantined', error: decision.error };
  }
  if (decision.outcome === 'blocked') {
    // Quarantine before activation; never partial.
    return {
      outcome: 'quarantined',
      state: 'quarantined',
      findings: decision.findings,
      error: decision.error,
    };
  }

  // The gate allowed activation or approval. Stage under the sandbox.
  const manifest = decision.manifest;
  const requirement: IsolationRequirement =
    manifest.sandboxProfile === 'degraded-read-only'
      ? 'read-only'
      : manifest.sandboxProfile === 'strict'
        ? 'strict'
        : 'standard';

  const selection = selectSandboxProfile(registry, platform, architecture, requirement);
  if (!selection.ok) {
    // Required isolation is unavailable: install is unavailable, NEVER
    // host-executed silently (NN-SEC-016).
    return { outcome: 'unavailable', state: 'quarantined', error: selection.error };
  }

  // A plugin that declares it needs execution must have landed on an
  // execution-capable profile; a read-only plugin must not require execution.
  const profile = selection.selected.profile;
  const needsExecution = requirement !== 'read-only';
  if (needsExecution && !profileMayExecute(profile)) {
    // The selector resolved to a non-execution profile for an execution
    // requirement; treat as unavailable rather than host-execute (NN-SEC-016).
    return {
      outcome: 'unavailable',
      state: 'quarantined',
      error: {
        schemaVersion: CONTRACT_WRITE_VERSION,
        code: 'UNAVAILABLE',
        message: 'no execution-capable sandbox profile is available for staging',
        owner: 'authority-supply-chain',
        operation: 'stage-install',
        correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
        retryable: false,
        remediation:
          'Install and verify an execution-capable sandbox adapter; a plugin ' +
          'requiring execution is never staged under a read-only profile.',
        redaction: 'internal',
      },
    };
  }

  if (decision.outcome === 'requires-approval') {
    // Staged under the sandbox but held for explicit approval before activation.
    return {
      outcome: 'requires-approval',
      state: 'staged',
      manifest,
      sandboxProfile: profile,
      findings: decision.findings,
    };
  }

  // decision.outcome === 'activate'
  return {
    outcome: 'activated',
    state: 'activated',
    manifest,
    sandboxProfile: profile,
    findings: decision.findings,
  };
}

/**
 * Roll back a staged/activated install: remove the staged capability and
 * return to `quarantined`. The caller preserves the local audit record; this
 * function only computes the resulting safe state (NN-INV-006 recoverability,
 * task rollback rule). It never returns `activated`.
 */
export function rollbackStagedInstall(): { readonly state: 'quarantined' } {
  return { state: 'quarantined' };
}
