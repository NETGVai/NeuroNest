/**
 * Unified Intent Gate IPC — Wires all renderer↔main communication for the
 * Intent Gate, Spec Interview Engine, and Spec Review subsystems.
 *
 * Extracted into a dedicated module (matching registerSkillPacksIPC /
 * registerDiagnosticsIPC patterns) so the channels are independently
 * unit-testable without booting the whole main process.
 *
 * IPC Channel Map (from design.md):
 *   Main → Renderer:
 *     - intent:decision       — IntentDecision broadcast
 *     - intent:disambiguation — Disambiguation options
 *     - interview:turn        — Single interview question (complex depth)
 *     - interview:resume      — Resume a crashed interview
 *     - spec:review           — Synthesized spec for review card
 *
 *   Renderer → Main:
 *     - intent:override-request        — User overrides intent chip
 *     - intent:disambiguation-response — User picks disambiguation option
 *     - interview:answer               — User answers interview question
 *     - interview:action               — User skip/defaults/cancel
 *     - spec:action                    — Already handled by spec-handoff.ts ('build')
 *
 * Requirements: 16.1, 4.1, 4.3, 9.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { IIntentGate, IntentDecision, IntentLabel } from '../pipeline/intent-gate.js';
import type { ISpecInterviewEngine, InterviewTurn, SynthesizedSpec } from '../pipeline/spec-interview-engine.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import {
  serializeIntentDecision,
  deserializeIntentDecision,
  isParseError,
} from '../pipeline/intent-gate/telemetry.js';

// ─── IPC Channel Constants ──────────────────────────────────────────────────

export const INTENT_GATE_IPC_CHANNELS = {
  // Main → Renderer
  INTENT_DECISION: 'intent:decision',
  INTENT_DISAMBIGUATION: 'intent:disambiguation',
  INTERVIEW_TURN: 'interview:turn',
  INTERVIEW_RESUME: 'interview:resume',
  SPEC_REVIEW: 'spec:review',

  // Renderer → Main
  INTENT_OVERRIDE_REQUEST: 'intent:override-request',
  INTENT_DISAMBIGUATION_RESPONSE: 'intent:disambiguation-response',
  INTERVIEW_ANSWER: 'interview:answer',
  INTERVIEW_ACTION: 'interview:action',
  SPEC_ACTION: 'spec:action',
} as const;

// ─── Payload Types ──────────────────────────────────────────────────────────

export interface OverrideRequestPayload {
  messageHash: string;
  newIntent: IntentLabel;
}

export interface DisambiguationOption {
  intent: IntentLabel;
  label: string;
}

export interface DisambiguationPayload {
  messageHash: string;
  options: DisambiguationOption[];
}

export interface DisambiguationResponsePayload {
  messageHash: string;
  selectedIntent: IntentLabel;
}

export interface InterviewAnswerPayload {
  interviewId: string;
  questionIndex: number;
  answer: string;
}

export interface InterviewActionPayload {
  interviewId: string;
  action: 'skip' | 'defaults' | 'cancel';
}

export interface InterviewResumePayload {
  interviewId: string;
  lastTurn: InterviewTurn;
}

export interface SpecActionPayload {
  specId: string;
  action: 'build' | 'edit' | 'cancel';
}

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface UnifiedIntentGateIPCDeps {
  /** Main BrowserWindow for sending IPC to the renderer */
  mainWindow: BrowserWindow;
  /** IntentGate singleton (may be null before initialization) */
  getIntentGate: () => IIntentGate | null;
  /** SpecInterviewEngine singleton (may be null before initialization) */
  getSpecInterviewEngine: () => ISpecInterviewEngine | null;
  /** Feature gate system for flag checks */
  getFeatureGate: () => FeatureGateSystem | null;
}

// ─── Send Helpers (Main → Renderer) ─────────────────────────────────────────

/**
 * Send a validated IntentDecision to the renderer.
 * Serializes using the validated codec to ensure data integrity across the
 * process boundary.
 *
 * Requirements: 16.1, 4.1
 */
export function sendIntentDecision(mainWindow: BrowserWindow, decision: IntentDecision): void {
  const serialized = serializeIntentDecision(decision);
  // Validate round-trip before sending to ensure integrity
  const validated = deserializeIntentDecision(serialized);
  if (isParseError(validated)) {
    console.error('[UnifiedIntentGateIPC] IntentDecision serialization failed:', validated.message);
    return;
  }
  mainWindow.webContents.send(INTENT_GATE_IPC_CHANNELS.INTENT_DECISION, validated);
}

/**
 * Send disambiguation options to the renderer when intent is ambiguous.
 *
 * Requirements: 4.3
 */
export function sendDisambiguation(mainWindow: BrowserWindow, payload: DisambiguationPayload): void {
  mainWindow.webContents.send(INTENT_GATE_IPC_CHANNELS.INTENT_DISAMBIGUATION, payload);
}

/**
 * Send an interview turn to the renderer (complex depth, one-per-turn).
 *
 * Requirements: 9.3
 */
export function sendInterviewTurn(mainWindow: BrowserWindow, turn: InterviewTurn): void {
  mainWindow.webContents.send(INTENT_GATE_IPC_CHANNELS.INTERVIEW_TURN, turn);
}

/**
 * Send an interview resume notification to the renderer after crash recovery.
 *
 * Requirements: 9.3
 */
export function sendInterviewResume(mainWindow: BrowserWindow, payload: InterviewResumePayload): void {
  mainWindow.webContents.send(INTENT_GATE_IPC_CHANNELS.INTERVIEW_RESUME, payload);
}

/**
 * Send a synthesized spec to the renderer for review.
 */
export function sendSpecReview(mainWindow: BrowserWindow, spec: SynthesizedSpec): void {
  mainWindow.webContents.send(INTENT_GATE_IPC_CHANNELS.SPEC_REVIEW, spec);
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register all Unified Intent Gate IPC channels.
 *
 * Renderer → Main handlers:
 *   - intent:override-request → IntentGate.applyOverride() → sends back intent:decision
 *   - intent:disambiguation-response → records as user_override → sends back intent:decision
 *   - interview:answer → SpecInterviewEngine.answerQuestion()
 *   - interview:action → routes to skipToSpec/buildWithDefaults/cancelInterview
 *   - spec:action → already handled by spec-handoff.ts (only 'edit'/'cancel' handled here)
 *
 * All handlers are gated behind their respective feature flags.
 *
 * Requirements: 16.1, 4.1, 4.3, 9.3
 */
export function registerUnifiedIntentGateIPC(deps: UnifiedIntentGateIPCDeps): void {
  const { mainWindow, getIntentGate, getSpecInterviewEngine, getFeatureGate } = deps;

  // ── intent:override-request (Renderer → Main) ─────────────────────────────
  // User taps an IntentChip to override the classification.
  // Calls IntentGate.applyOverride() and sends back the new intent:decision.
  //
  // Requirements: 4.5, 3.2
  ipcMain.on(
    INTENT_GATE_IPC_CHANNELS.INTENT_OVERRIDE_REQUEST,
    async (_event, payload: OverrideRequestPayload) => {
      try {
        const featureGate = getFeatureGate();
        if (!featureGate || !featureGate.isEnabled('unified_intent_gate')) return;
        if (!featureGate.isEnabled('intent_chip_ux')) return;

        if (!payload || typeof payload.messageHash !== 'string' || typeof payload.newIntent !== 'string') {
          console.warn('[UnifiedIntentGateIPC] Invalid override-request payload');
          return;
        }

        const intentGate = getIntentGate();
        if (!intentGate) {
          console.warn('[UnifiedIntentGateIPC] IntentGate not initialized');
          return;
        }

        // Apply override: reclassify with user_override stage, then reroute
        const newDecision = await intentGate.applyOverride(payload.messageHash, payload.newIntent);
        sendIntentDecision(mainWindow, newDecision);
      } catch (err) {
        console.error('[UnifiedIntentGateIPC] override-request handler error:', err);
      }
    },
  );

  // ── intent:disambiguation-response (Renderer → Main) ──────────────────────
  // User selects an option from the DisambiguationChip.
  // Records selection as user_override and routes accordingly.
  //
  // Requirements: 3.2, 4.5
  ipcMain.on(
    INTENT_GATE_IPC_CHANNELS.INTENT_DISAMBIGUATION_RESPONSE,
    async (_event, payload: DisambiguationResponsePayload) => {
      try {
        const featureGate = getFeatureGate();
        if (!featureGate || !featureGate.isEnabled('unified_intent_gate')) return;

        if (!payload || typeof payload.messageHash !== 'string' || typeof payload.selectedIntent !== 'string') {
          console.warn('[UnifiedIntentGateIPC] Invalid disambiguation-response payload');
          return;
        }

        const intentGate = getIntentGate();
        if (!intentGate) {
          console.warn('[UnifiedIntentGateIPC] IntentGate not initialized');
          return;
        }

        // Record disambiguation selection as user_override
        const newDecision = await intentGate.applyOverride(payload.messageHash, payload.selectedIntent);
        sendIntentDecision(mainWindow, newDecision);
      } catch (err) {
        console.error('[UnifiedIntentGateIPC] disambiguation-response handler error:', err);
      }
    },
  );

  // ── interview:answer (Renderer → Main) ────────────────────────────────────
  // User answers an interview question.
  // Calls SpecInterviewEngine.answerQuestion().
  //
  // Requirements: 9.3
  ipcMain.on(
    INTENT_GATE_IPC_CHANNELS.INTERVIEW_ANSWER,
    async (_event, payload: InterviewAnswerPayload) => {
      try {
        const featureGate = getFeatureGate();
        if (!featureGate || !featureGate.isEnabled('spec_interview_engine')) return;

        if (
          !payload ||
          typeof payload.interviewId !== 'string' ||
          typeof payload.questionIndex !== 'number' ||
          typeof payload.answer !== 'string'
        ) {
          console.warn('[UnifiedIntentGateIPC] Invalid interview:answer payload');
          return;
        }

        const engine = getSpecInterviewEngine();
        if (!engine) {
          console.warn('[UnifiedIntentGateIPC] SpecInterviewEngine not initialized');
          return;
        }

        const updatedState = await engine.answerQuestion(
          payload.interviewId,
          payload.questionIndex,
          payload.answer,
        );

        // If there are more unanswered questions, send the next turn to the renderer
        const nextUnanswered = updatedState.turns.find((t) => t.answer === null);
        if (nextUnanswered && updatedState.status === 'active') {
          sendInterviewTurn(mainWindow, nextUnanswered);
        }
      } catch (err) {
        console.error('[UnifiedIntentGateIPC] interview:answer handler error:', err);
      }
    },
  );

  // ── interview:action (Renderer → Main) ────────────────────────────────────
  // User performs an interview action: skip to spec, build with defaults, or cancel.
  // Routes to the appropriate SpecInterviewEngine method.
  //
  // Requirements: 9.3
  ipcMain.on(
    INTENT_GATE_IPC_CHANNELS.INTERVIEW_ACTION,
    async (_event, payload: InterviewActionPayload) => {
      try {
        const featureGate = getFeatureGate();
        if (!featureGate || !featureGate.isEnabled('spec_interview_engine')) return;

        if (
          !payload ||
          typeof payload.interviewId !== 'string' ||
          !['skip', 'defaults', 'cancel'].includes(payload.action)
        ) {
          console.warn('[UnifiedIntentGateIPC] Invalid interview:action payload');
          return;
        }

        const engine = getSpecInterviewEngine();
        if (!engine) {
          console.warn('[UnifiedIntentGateIPC] SpecInterviewEngine not initialized');
          return;
        }

        switch (payload.action) {
          case 'skip': {
            const spec = await engine.skipToSpec(payload.interviewId);
            sendSpecReview(mainWindow, spec);
            break;
          }
          case 'defaults': {
            const spec = await engine.buildWithDefaults(payload.interviewId);
            sendSpecReview(mainWindow, spec);
            break;
          }
          case 'cancel': {
            engine.cancelInterview(payload.interviewId);
            break;
          }
        }
      } catch (err) {
        console.error('[UnifiedIntentGateIPC] interview:action handler error:', err);
      }
    },
  );

  // ── spec:action (Renderer → Main) ─────────────────────────────────────────
  // Handles 'edit' and 'cancel' actions from the SpecReviewCard.
  // The 'build' action is handled by spec-handoff.ts's registerSpecHandoffIPC.
  //
  // Requirements: 10.3, 10.5
  ipcMain.on(
    INTENT_GATE_IPC_CHANNELS.SPEC_ACTION,
    async (_event, payload: SpecActionPayload) => {
      try {
        const featureGate = getFeatureGate();
        if (!featureGate || !featureGate.isEnabled('spec_review_card')) return;

        if (!payload || typeof payload.specId !== 'string' || typeof payload.action !== 'string') {
          console.warn('[UnifiedIntentGateIPC] Invalid spec:action payload');
          return;
        }

        // 'build' is handled by spec-handoff.ts — skip here to avoid double-handling
        if (payload.action === 'build') return;

        // 'edit' and 'cancel' are handled here
        // For now, these are acknowledged — the renderer handles the UX transition
        // (edit opens editor view, cancel discards spec). Future tasks may add
        // persistence updates here.
        if (payload.action === 'edit') {
          console.log('[UnifiedIntentGateIPC] spec:action edit for', payload.specId);
        } else if (payload.action === 'cancel') {
          console.log('[UnifiedIntentGateIPC] spec:action cancel for', payload.specId);
        }
      } catch (err) {
        console.error('[UnifiedIntentGateIPC] spec:action handler error:', err);
      }
    },
  );

  console.log('[UnifiedIntentGateIPC] All channels registered');
}
