/**
 * Disambiguation — Ambiguity resolution and DisambiguationChip emission.
 *
 * When all three cascade stages fail to resolve intent above the confidence
 * threshold, this module emits a DisambiguationChip with three options and
 * holds the message in a pending state until the user resolves the ambiguity.
 *
 * IPC Channels:
 *   - `intent:disambiguation` (Main → Renderer): emits disambiguation options
 *   - `intent:disambiguation-response` (Renderer → Main): receives user selection
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import type { IntentDecision, IntentLabel, IIntentGate } from '../intent-gate.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DisambiguationOption {
  intent: IntentLabel;
  label: string;
  emoji: string;
}

export interface DisambiguationChipPayload {
  messageHash: string;
  options: DisambiguationOption[];
  originalDecision: IntentDecision;
  timestamp: number;
}

export interface DisambiguationResponse {
  messageHash: string;
  selectedIntent: IntentLabel;
}

export type DisambiguationStatus = 'pending' | 'resolved' | 'expired';

export interface PendingDisambiguation {
  payload: DisambiguationChipPayload;
  status: DisambiguationStatus;
  resolvedIntent: IntentLabel | null;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * Listener for disambiguation events (IPC abstraction).
 * In Electron, this would be wired to ipcMain.handle/BrowserWindow.webContents.send.
 */
export interface DisambiguationIPCBridge {
  /** Send disambiguation options to renderer (Main → Renderer) */
  sendDisambiguation(payload: DisambiguationChipPayload): void;
  /** Register handler for disambiguation responses (Renderer → Main) */
  onDisambiguationResponse(handler: (response: DisambiguationResponse) => void): void;
  /** Remove response handler */
  removeDisambiguationResponseHandler(): void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * The three disambiguation options presented to the user.
 * Matches Requirement 3.1: conversation ("💬 Answer"), quick_action ("⚡ Do it"), build ("🔨 Build it")
 */
export const DISAMBIGUATION_OPTIONS: readonly DisambiguationOption[] = Object.freeze([
  { intent: 'conversation', label: 'Answer', emoji: '💬' },
  { intent: 'quick_action', label: 'Do it', emoji: '⚡' },
  { intent: 'build', label: 'Build it', emoji: '🔨' },
]);

/**
 * Confidence threshold below which disambiguation is triggered.
 * When all stages produce confidence below this value and the intent
 * is 'ambiguous', we emit the DisambiguationChip.
 */
export const DISAMBIGUATION_CONFIDENCE_THRESHOLD = 0.4;

/**
 * IPC channel names for disambiguation communication.
 */
export const IPC_CHANNELS = {
  DISAMBIGUATION: 'intent:disambiguation',
  DISAMBIGUATION_RESPONSE: 'intent:disambiguation-response',
} as const;

// ─── DisambiguationManager ──────────────────────────────────────────────────

/**
 * Manages the disambiguation flow for ambiguous intent decisions.
 *
 * Responsibilities:
 *   1. Detect when disambiguation is needed (intent='ambiguous' && confidence < threshold)
 *   2. Emit DisambiguationChip with three options via IPC
 *   3. Hold the message in pending state (non-blocking)
 *   4. Process user selection and apply override via IntentGate
 *
 * Requirements: 3.1, 3.2, 3.3
 */
export class DisambiguationManager {
  private readonly pendingDisambiguations: Map<string, PendingDisambiguation> = new Map();
  private readonly ipcBridge: DisambiguationIPCBridge;
  private readonly intentGate: IIntentGate;
  private readonly confidenceThreshold: number;

  constructor(
    ipcBridge: DisambiguationIPCBridge,
    intentGate: IIntentGate,
    confidenceThreshold: number = DISAMBIGUATION_CONFIDENCE_THRESHOLD,
  ) {
    this.ipcBridge = ipcBridge;
    this.intentGate = intentGate;
    this.confidenceThreshold = confidenceThreshold;

    // Wire up the response handler
    this.ipcBridge.onDisambiguationResponse(this.handleDisambiguationResponse.bind(this));
  }

  /**
   * Check whether a decision requires disambiguation.
   *
   * Disambiguation is triggered when:
   *   - The intent is 'ambiguous'
   *   - The confidence is below the threshold (default 0.4)
   *
   * Requirement 3.1: All three stages failed to resolve above threshold.
   */
  needsDisambiguation(decision: IntentDecision): boolean {
    return decision.intent === 'ambiguous' && decision.confidence < this.confidenceThreshold;
  }

  /**
   * Emit a DisambiguationChip for an ambiguous decision.
   *
   * Sends the disambiguation options to the renderer via IPC and holds
   * the message in a pending state.
   *
   * Requirements: 3.1, 3.3
   *
   * @returns The pending disambiguation record, or null if disambiguation is not needed.
   */
  emitDisambiguation(decision: IntentDecision): PendingDisambiguation | null {
    if (!this.needsDisambiguation(decision)) {
      return null;
    }

    const payload: DisambiguationChipPayload = {
      messageHash: decision.messageHash,
      options: [...DISAMBIGUATION_OPTIONS],
      originalDecision: decision,
      timestamp: Date.now(),
    };

    const pending: PendingDisambiguation = {
      payload,
      status: 'pending',
      resolvedIntent: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };

    this.pendingDisambiguations.set(decision.messageHash, pending);

    // Send to renderer via IPC (non-blocking)
    // Requirement 3.3: SHALL not block message processing
    this.ipcBridge.sendDisambiguation(payload);

    return pending;
  }

  /**
   * Handle a disambiguation response from the renderer.
   *
   * Records the selection as a user_override via IntentGate.applyOverride().
   *
   * Requirement 3.2: Record selection as user_override and route accordingly.
   */
  async handleDisambiguationResponse(response: DisambiguationResponse): Promise<IntentDecision | null> {
    const pending = this.pendingDisambiguations.get(response.messageHash);

    if (!pending || pending.status !== 'pending') {
      return null;
    }

    // Apply the user's selection as an override
    const overriddenDecision = await this.intentGate.applyOverride(
      response.messageHash,
      response.selectedIntent,
    );

    // Update pending record
    pending.status = 'resolved';
    pending.resolvedIntent = response.selectedIntent;
    pending.resolvedAt = Date.now();

    return overriddenDecision;
  }

  /**
   * Get the pending disambiguation for a message hash.
   */
  getPending(messageHash: string): PendingDisambiguation | null {
    return this.pendingDisambiguations.get(messageHash) ?? null;
  }

  /**
   * Check if a message is currently pending disambiguation.
   *
   * Requirement 3.3: Message held in pending state until resolution.
   */
  isPending(messageHash: string): boolean {
    const pending = this.pendingDisambiguations.get(messageHash);
    return pending?.status === 'pending';
  }

  /**
   * Expire a pending disambiguation (e.g., on timeout or cancellation).
   */
  expire(messageHash: string): void {
    const pending = this.pendingDisambiguations.get(messageHash);
    if (pending && pending.status === 'pending') {
      pending.status = 'expired';
    }
  }

  /**
   * Get all pending disambiguations.
   */
  getAllPending(): PendingDisambiguation[] {
    return Array.from(this.pendingDisambiguations.values()).filter(
      (p) => p.status === 'pending',
    );
  }

  /**
   * Clean up resolved/expired disambiguations older than the given age (ms).
   */
  cleanup(maxAgeMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [hash, pending] of this.pendingDisambiguations.entries()) {
      if (pending.status !== 'pending' && (now - pending.createdAt) > maxAgeMs) {
        this.pendingDisambiguations.delete(hash);
      }
    }
  }

  /**
   * Dispose of the manager and remove IPC handlers.
   */
  dispose(): void {
    this.ipcBridge.removeDisambiguationResponseHandler();
    this.pendingDisambiguations.clear();
  }
}
