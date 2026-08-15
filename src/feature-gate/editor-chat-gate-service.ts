/**
 * Editor Chat Gate Service
 *
 * Orchestrates the independent feature gates, compatibility adapters,
 * rollback checks, and criteria recording for the editor-chat-enhancement
 * staged rollout.
 *
 * This is the main entry point for checking whether a gate is active,
 * toggling gates, performing rollback, and observing criteria.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4, 28.6, 28.7, 28.8
 */

import {
  type EditorChatGateId,
  type EditorChatGateState,
  type GateState,
  EDITOR_CHAT_GATE_IDS,
  EDITOR_CHAT_GATE_METADATA,
} from './editor-chat-gates.js';
import { CompatibilityAdapterRegistry, type DeprecationEvent } from './compatibility-adapter.js';
import { RollbackCompatibilityService, type RollbackCheckResult } from './rollback-checks.js';
import { RollbackCriteriaRecorder, type StageRollbackCriteria } from './rollback-criteria.js';

// ─── Service Events ─────────────────────────────────────────────

export interface GateToggleEvent {
  gateId: EditorChatGateId;
  previousState: GateState;
  newState: GateState;
  actor: string;
  timestamp: string;
  rollbackResult?: RollbackCheckResult;
}

export type GateEventListener = (event: GateToggleEvent) => void;

// ─── Service ────────────────────────────────────────────────────

export class EditorChatGateService {
  private gateStates: Map<EditorChatGateId, EditorChatGateState> = new Map();
  private adapters: CompatibilityAdapterRegistry;
  private rollbackService: RollbackCompatibilityService;
  private criteriaRecorder: RollbackCriteriaRecorder;
  private listeners: GateEventListener[] = [];

  constructor(
    adapters?: CompatibilityAdapterRegistry,
    rollbackService?: RollbackCompatibilityService,
    criteriaRecorder?: RollbackCriteriaRecorder,
  ) {
    this.adapters = adapters ?? new CompatibilityAdapterRegistry();
    this.rollbackService = rollbackService ?? new RollbackCompatibilityService();
    this.criteriaRecorder = criteriaRecorder ?? new RollbackCriteriaRecorder();

    // Initialize all gates as disabled
    for (const gateId of EDITOR_CHAT_GATE_IDS) {
      this.gateStates.set(gateId, {
        id: gateId,
        state: 'disabled',
        enabledAt: null,
        disabledAt: null,
        blockReason: null,
        schemaVersion: null,
      });
    }
  }

  // ─── Gate Queries ───────────────────────────────────────────────

  /**
   * Check if a gate is currently enabled and active.
   */
  isGateEnabled(gateId: EditorChatGateId): boolean {
    const state = this.gateStates.get(gateId);
    return state?.state === 'enabled';
  }

  /**
   * Check if writes are blocked for a gate due to failed rollback.
   */
  isWriteBlocked(gateId: EditorChatGateId): boolean {
    return this.rollbackService.isWriteBlocked(gateId);
  }

  /**
   * Get the current state of a gate.
   */
  getGateState(gateId: EditorChatGateId): EditorChatGateState | undefined {
    return this.gateStates.get(gateId);
  }

  /**
   * Get all gate states.
   */
  getAllGateStates(): EditorChatGateState[] {
    return Array.from(this.gateStates.values());
  }

  /**
   * Get metadata for a gate.
   */
  getGateMetadata(gateId: EditorChatGateId) {
    return EDITOR_CHAT_GATE_METADATA[gateId];
  }

  // ─── Gate Toggle ────────────────────────────────────────────────

  /**
   * Enable a gate. Initializes criteria tracking and captures a compatible state.
   */
  enableGate(gateId: EditorChatGateId, schemaVersion: number, actor: string = 'system'): GateToggleEvent {
    const currentState = this.gateStates.get(gateId)!;
    const previousState = currentState.state;

    // Check if rollback-blocked
    if (currentState.state === 'rollback_blocked') {
      throw new Error(
        `Cannot enable gate '${gateId}': it is blocked due to a failed rollback. ` +
        `Resolve the block first: ${currentState.blockReason}`,
      );
    }

    const now = new Date().toISOString();

    // Update state
    currentState.state = 'enabled';
    currentState.enabledAt = now;
    currentState.schemaVersion = schemaVersion;
    currentState.blockReason = null;

    // Initialize criteria tracking
    this.criteriaRecorder.initializeGate(gateId);

    // Capture compatible state for future rollback
    this.rollbackService.captureCompatibleState(gateId, schemaVersion, `initial_${gateId}_${now}`);

    const event: GateToggleEvent = {
      gateId,
      previousState,
      newState: 'enabled',
      actor,
      timestamp: now,
    };

    this.notifyListeners(event);
    return event;
  }

  /**
   * Disable a gate, performing rollback compatibility checks.
   * If rollback is unsafe, the gate enters 'rollback_blocked' state.
   */
  disableGate(
    gateId: EditorChatGateId,
    currentSchemaVersion: number,
    currentDataFingerprint: string,
    inFlightTransactions: number = 0,
    actor: string = 'system',
  ): GateToggleEvent {
    const currentState = this.gateStates.get(gateId)!;
    const previousState = currentState.state;

    if (currentState.state === 'disabled') {
      // Already disabled, no-op
      return {
        gateId,
        previousState: 'disabled',
        newState: 'disabled',
        actor,
        timestamp: new Date().toISOString(),
      };
    }

    // Perform rollback compatibility check
    const rollbackResult = this.rollbackService.checkRollbackCompatibility(
      gateId,
      currentSchemaVersion,
      currentDataFingerprint,
      inFlightTransactions,
    );

    const now = new Date().toISOString();
    let newState: GateState;

    if (rollbackResult.verdict === 'blocked') {
      // Cannot safely rollback — block writes and preserve last compatible state
      newState = 'rollback_blocked';
      currentState.state = 'rollback_blocked';
      currentState.disabledAt = now;
      currentState.blockReason = rollbackResult.requiredRecoveryAction;
    } else {
      // Safe to rollback (or partially safe)
      newState = 'disabled';
      currentState.state = 'disabled';
      currentState.disabledAt = now;
      currentState.blockReason = null;

      // Reset criteria since gate is now disabled
      this.criteriaRecorder.resetCriteria(gateId);
    }

    const event: GateToggleEvent = {
      gateId,
      previousState,
      newState,
      actor,
      timestamp: now,
      rollbackResult,
    };

    this.notifyListeners(event);
    return event;
  }

  /**
   * Clear a rollback block after guided recovery is complete.
   */
  clearRollbackBlock(gateId: EditorChatGateId, actor: string = 'system'): void {
    const currentState = this.gateStates.get(gateId)!;
    if (currentState.state !== 'rollback_blocked') return;

    currentState.state = 'disabled';
    currentState.blockReason = null;
    this.rollbackService.clearBlock(gateId);

    this.notifyListeners({
      gateId,
      previousState: 'rollback_blocked',
      newState: 'disabled',
      actor,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Adapter Access ─────────────────────────────────────────────

  /**
   * Get the compatibility adapter registry.
   */
  getAdapterRegistry(): CompatibilityAdapterRegistry {
    return this.adapters;
  }

  /**
   * Record a deprecation event through an adapter.
   */
  recordDeprecation(adapterId: string, caller: string): DeprecationEvent | null {
    return this.adapters.recordDeprecation(adapterId, caller);
  }

  /**
   * Check if an adapter operation is allowed (respects ownership boundaries).
   */
  isAdapterOperationAllowed(entityType: string, operation: string, gateId: EditorChatGateId): boolean {
    if (!this.isGateEnabled(gateId)) {
      // Gate not enabled, legacy behavior applies
      return true;
    }
    return this.adapters.isOperationAllowed(entityType, operation, gateId);
  }

  // ─── Criteria Access ────────────────────────────────────────────

  /**
   * Get the criteria recorder for recording events.
   */
  getCriteriaRecorder(): RollbackCriteriaRecorder {
    return this.criteriaRecorder;
  }

  /**
   * Get current criteria for a gate.
   */
  getCriteria(gateId: EditorChatGateId): StageRollbackCriteria | undefined {
    return this.criteriaRecorder.getCriteria(gateId);
  }

  /**
   * Get all gates that recommend rollback based on criteria.
   */
  getGatesRecommendingRollback(): EditorChatGateId[] {
    return this.criteriaRecorder.getGatesRecommendingRollback();
  }

  // ─── Rollback Service Access ────────────────────────────────────

  /**
   * Get the rollback compatibility service.
   */
  getRollbackService(): RollbackCompatibilityService {
    return this.rollbackService;
  }

  // ─── Event Listeners ──────────────────────────────────────────

  /**
   * Subscribe to gate toggle events.
   */
  onGateToggle(listener: GateEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(event: GateToggleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
