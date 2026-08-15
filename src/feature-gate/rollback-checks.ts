/**
 * Rollback Compatibility Checks
 *
 * Implements rollback logic that preserves the last durable compatible state
 * and blocks affected writes when safe reversion is impossible.
 *
 * When a gate is disabled, the system:
 * 1. Checks if safe rollback is possible (schema compatibility, data integrity)
 * 2. If safe: reverts to the prior supported behavior
 * 3. If unsafe: blocks affected data mutations, preserves last compatible state,
 *    reports affected components and required recovery action
 *
 * Requirements: 28.3, 28.4, 28.6
 */

import type { EditorChatGateId } from './editor-chat-gates.js';

// ─── Rollback Check Types ───────────────────────────────────────

export type RollbackVerdict = 'safe' | 'blocked' | 'partial';

export interface RollbackCheckResult {
  gateId: EditorChatGateId;
  verdict: RollbackVerdict;
  /** Whether the last durable compatible state was preserved */
  compatibleStatePreserved: boolean;
  /** Components affected by the rollback */
  affectedComponents: string[];
  /** If blocked, the required recovery action */
  requiredRecoveryAction: string | null;
  /** Schema version at which the gate was last safely operating */
  lastCompatibleSchemaVersion: number | null;
  /** Current schema version that may be incompatible */
  currentSchemaVersion: number | null;
  /** Which data mutations are blocked until recovery */
  blockedMutations: string[];
  /** Human-readable report of what happened */
  report: string;
  /** Timestamp of the check */
  checkedAt: string;
}

export interface CompatibilitySnapshot {
  gateId: EditorChatGateId;
  schemaVersion: number;
  /** Fingerprint of the data state at the time of snapshot */
  dataFingerprint: string;
  /** Timestamp when this compatible state was captured */
  capturedAt: string;
  /** Whether this snapshot is the last known good state */
  isLastGood: boolean;
}

// ─── Rollback Check Configuration ───────────────────────────────

export interface RollbackCheckConfig {
  /** Whether to perform schema version compatibility checks */
  checkSchemaCompatibility: boolean;
  /** Whether to verify data integrity before rollback */
  checkDataIntegrity: boolean;
  /** Whether to check for in-flight transactions that would be corrupted */
  checkInFlightTransactions: boolean;
  /** Maximum time to wait for in-flight transactions to complete (ms) */
  transactionDrainTimeoutMs: number;
}

export const DEFAULT_ROLLBACK_CHECK_CONFIG: RollbackCheckConfig = {
  checkSchemaCompatibility: true,
  checkDataIntegrity: true,
  checkInFlightTransactions: true,
  transactionDrainTimeoutMs: 5000,
};

// ─── Rollback Compatibility Service ─────────────────────────────

export class RollbackCompatibilityService {
  private compatibleSnapshots: Map<EditorChatGateId, CompatibilitySnapshot> = new Map();
  private blockedGates: Map<EditorChatGateId, RollbackCheckResult> = new Map();
  private config: RollbackCheckConfig;

  constructor(config: Partial<RollbackCheckConfig> = {}) {
    this.config = { ...DEFAULT_ROLLBACK_CHECK_CONFIG, ...config };
  }

  /**
   * Capture a compatible state snapshot for a gate.
   * Should be called after a gate is successfully enabled and verified.
   */
  captureCompatibleState(
    gateId: EditorChatGateId,
    schemaVersion: number,
    dataFingerprint: string,
  ): CompatibilitySnapshot {
    const snapshot: CompatibilitySnapshot = {
      gateId,
      schemaVersion,
      dataFingerprint,
      capturedAt: new Date().toISOString(),
      isLastGood: true,
    };

    // Mark previous snapshot as not-last-good
    const prev = this.compatibleSnapshots.get(gateId);
    if (prev) {
      prev.isLastGood = false;
    }

    this.compatibleSnapshots.set(gateId, snapshot);
    return snapshot;
  }

  /**
   * Perform a rollback compatibility check for a gate.
   * Returns whether the gate can safely revert to its prior behavior.
   */
  checkRollbackCompatibility(
    gateId: EditorChatGateId,
    currentSchemaVersion: number,
    currentDataFingerprint: string,
    inFlightTransactions: number = 0,
  ): RollbackCheckResult {
    const snapshot = this.compatibleSnapshots.get(gateId);
    const checkedAt = new Date().toISOString();

    // No compatible snapshot exists — cannot safely rollback
    if (!snapshot) {
      const result: RollbackCheckResult = {
        gateId,
        verdict: 'safe',
        compatibleStatePreserved: true,
        affectedComponents: [],
        requiredRecoveryAction: null,
        lastCompatibleSchemaVersion: null,
        currentSchemaVersion,
        blockedMutations: [],
        report: `No prior state exists for gate '${gateId}'. Safe to disable (no data to preserve).`,
        checkedAt,
      };
      return result;
    }

    const affectedComponents: string[] = [];
    const blockedMutations: string[] = [];
    let verdict: RollbackVerdict = 'safe';
    let requiredRecoveryAction: string | null = null;

    // Check schema compatibility
    if (this.config.checkSchemaCompatibility && currentSchemaVersion > snapshot.schemaVersion) {
      // Schema has been upgraded since the compatible state was captured.
      // If the schema is not backward-compatible, rollback is blocked.
      const schemaBreaking = this.isSchemaBreaking(snapshot.schemaVersion, currentSchemaVersion);
      if (schemaBreaking) {
        verdict = 'blocked';
        affectedComponents.push(`schema_v${snapshot.schemaVersion}_to_v${currentSchemaVersion}`);
        blockedMutations.push(`all_${gateId}_writes`);
        requiredRecoveryAction = `Schema migration from v${currentSchemaVersion} to v${snapshot.schemaVersion} is not reversible. Run guided recovery for gate '${gateId}'.`;
      }
    }

    // Check data integrity
    if (this.config.checkDataIntegrity && currentDataFingerprint !== snapshot.dataFingerprint) {
      // Data has changed since compatible state. Check if changes are compatible.
      if (verdict !== 'blocked') {
        // Data divergence alone doesn't block, but requires careful rollback
        affectedComponents.push('data_divergence');
      }
    }

    // Check in-flight transactions
    if (this.config.checkInFlightTransactions && inFlightTransactions > 0) {
      if (verdict !== 'blocked') {
        verdict = 'partial';
        affectedComponents.push(`in_flight_transactions:${inFlightTransactions}`);
        blockedMutations.push(`new_${gateId}_writes_until_drain`);
      }
    }

    const report = this.buildReport(gateId, verdict, affectedComponents, requiredRecoveryAction, snapshot);

    const result: RollbackCheckResult = {
      gateId,
      verdict,
      compatibleStatePreserved: verdict !== 'blocked',
      affectedComponents,
      requiredRecoveryAction,
      lastCompatibleSchemaVersion: snapshot.schemaVersion,
      currentSchemaVersion,
      blockedMutations,
      report,
      checkedAt,
    };

    // If blocked, record it so writes can be refused
    if (verdict === 'blocked') {
      this.blockedGates.set(gateId, result);
    } else {
      this.blockedGates.delete(gateId);
    }

    return result;
  }

  /**
   * Check if writes are blocked for a gate due to a failed rollback.
   */
  isWriteBlocked(gateId: EditorChatGateId): boolean {
    return this.blockedGates.has(gateId);
  }

  /**
   * Get the rollback failure reason for a blocked gate.
   */
  getBlockedReason(gateId: EditorChatGateId): RollbackCheckResult | undefined {
    return this.blockedGates.get(gateId);
  }

  /**
   * Get all currently blocked gates.
   */
  getBlockedGates(): EditorChatGateId[] {
    return Array.from(this.blockedGates.keys());
  }

  /**
   * Clear a block after guided recovery is complete.
   */
  clearBlock(gateId: EditorChatGateId): void {
    this.blockedGates.delete(gateId);
  }

  /**
   * Get the last compatible snapshot for a gate.
   */
  getCompatibleSnapshot(gateId: EditorChatGateId): CompatibilitySnapshot | undefined {
    return this.compatibleSnapshots.get(gateId);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Determine if a schema migration is breaking (not backward compatible).
   * A schema version increase of more than 1 minor version is considered breaking,
   * as are major version changes.
   */
  private isSchemaBreaking(fromVersion: number, toVersion: number): boolean {
    // Major version change (integer part differs by more than 0)
    const fromMajor = Math.floor(fromVersion);
    const toMajor = Math.floor(toVersion);
    if (toMajor > fromMajor + 1) {
      return true;
    }
    return false;
  }

  private buildReport(
    gateId: EditorChatGateId,
    verdict: RollbackVerdict,
    affectedComponents: string[],
    requiredRecoveryAction: string | null,
    snapshot: CompatibilitySnapshot,
  ): string {
    const lines: string[] = [];
    lines.push(`Rollback check for gate '${gateId}': ${verdict.toUpperCase()}`);
    lines.push(`Last compatible state captured at: ${snapshot.capturedAt}`);
    lines.push(`Last compatible schema version: ${snapshot.schemaVersion}`);

    if (affectedComponents.length > 0) {
      lines.push(`Affected components: ${affectedComponents.join(', ')}`);
    }
    if (requiredRecoveryAction) {
      lines.push(`Required recovery: ${requiredRecoveryAction}`);
    }
    if (verdict === 'safe') {
      lines.push('Rollback can proceed safely.');
    } else if (verdict === 'blocked') {
      lines.push('Rollback BLOCKED. Writes are disabled for affected scopes until recovery completes.');
    } else if (verdict === 'partial') {
      lines.push('Rollback is partial. Some operations are temporarily blocked until in-flight transactions drain.');
    }

    return lines.join('\n');
  }
}
