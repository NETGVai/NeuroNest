/**
 * Runtime Security Wiring — Instantiates and connects all runtime security
 * subsystems into the AgentLoopController via CallbackEngine.
 *
 * Each subsystem is guarded by its feature gate flag. If all flags are disabled,
 * returns null (zero overhead per Req 0.6).
 *
 * Subsystem registration:
 * - RealtimeCodeAnalyzer: before-tool-call hook for file write operations
 * - HackabilityScoringEngine: after-tool-call handler for file writes
 * - ThreatModeler: after-tool-call handler for code generation
 * - AISecurityRuleEngine: after-tool-call handler for file writes
 * - SecurityEvidenceStore: persists events from all subsystems
 * - AttackPathMapper: correlates HackabilityScoringEngine findings
 *
 * Requirements: 1.7, 2.1, 3.1, 4.1, 4.2, 5.1, 6.1
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine, HookContext } from '../pipeline/callback-engine.js';
import type { SuperagentConfig } from '../feature-gate/superagent-config.js';
import type { SecurityEventType } from './types.js';

import { RealtimeCodeAnalyzer } from './realtime-code-analyzer.js';
import {
  HackabilityScoringEngine,
  type HackabilityScoringConfig,
} from './hackability-scoring-engine.js';
import { ThreatModeler, type ThreatModelProfile } from './threat-modeler.js';
import {
  AISecurityRuleEngine,
  type AISecurityRule,
} from './ai-security-rule-engine.js';
import { AttackPathMapper } from './attack-path-mapper.js';
import { SecurityEvidenceStore, type DatabaseLike } from './security-evidence-store.js';

// ─── Runtime Security Context ───────────────────────────────────

/**
 * Holds references to all instantiated runtime security subsystems.
 * Subsystems that are disabled by feature gates will be undefined.
 */
export interface RuntimeSecurityContext {
  realtimeAnalyzer?: RealtimeCodeAnalyzer;
  hackabilityScoring?: HackabilityScoringEngine;
  threatModeler?: ThreatModeler;
  aiSecurityRules?: AISecurityRuleEngine;
  attackPathMapper?: AttackPathMapper;
  evidenceStore?: SecurityEvidenceStore;
}

// ─── Wiring Function ────────────────────────────────────────────

/**
 * Wire all runtime security subsystems into the agent loop via CallbackEngine.
 *
 * Checks each feature gate before instantiating subsystems. If no runtime
 * security feature is enabled, returns null for zero overhead.
 *
 * @param featureGate - The resolved FeatureGateSystem for flag checks.
 * @param callbackEngine - The pipeline's CallbackEngine for hook registration.
 * @param config - SuperagentConfig containing subsystem-specific configuration.
 * @param db - Optional SQLite database for SecurityEvidenceStore persistence.
 * @returns RuntimeSecurityContext with instantiated subsystems, or null if all disabled.
 */
export function wireRuntimeSecurity(
  featureGate: FeatureGateSystem,
  callbackEngine: CallbackEngine,
  config: SuperagentConfig,
  db?: DatabaseLike,
): RuntimeSecurityContext | null {
  const context: RuntimeSecurityContext = {};
  let anyEnabled = false;

  // ─── 1. SecurityEvidenceStore (Req 6.1) ─────────────────────────
  // Instantiate first so other subsystems can record evidence.
  if (featureGate.isEnabled('runtimesecurity_evidence_store') && db) {
    // Initialize the evidence table
    db.exec(SecurityEvidenceStore.getTableCreationSQL());

    context.evidenceStore = new SecurityEvidenceStore(
      db,
      callbackEngine,
    );
    anyEnabled = true;
  }

  // ─── 2. AttackPathMapper (Req 5.1) ─────────────────────────────
  if (featureGate.isEnabled('runtimesecurity_attack_path_mapping')) {
    const criticalThreshold = config.runtimeSecurityAttackPath?.criticalThreshold ?? 80;
    context.attackPathMapper = new AttackPathMapper(
      {
        emit: (event: string, eventCtx: unknown) => {
          // Forward attack path events to evidence store
          if (context.evidenceStore) {
            recordSecurityEvent(context.evidenceStore, 'attack_path_mapper', event, eventCtx);
          }
        },
      },
      criticalThreshold,
    );
    anyEnabled = true;
  }

  // ─── 3. RealtimeCodeAnalyzer (Req 4.1, 4.2) ────────────────────
  // Registers as before-tool-call hook for file write operations.
  if (featureGate.isEnabled('runtimesecurity_realtime_analysis')) {
    const maxLatencyMs = config.runtimeSecurityRealtime?.maxLatencyMs ?? 200;
    const blockOnCriticalOnly = config.runtimeSecurityRealtime?.blockOnCriticalOnly ?? false;

    // Create a CallbackEngine adapter for RealtimeCodeAnalyzer's internal interface
    const analyzerCallbackAdapter = {
      emit: (event: string, ctx: unknown) => {
        // Forward security events to evidence store if available
        if (context.evidenceStore) {
          recordSecurityEvent(context.evidenceStore, 'realtime_code_analyzer', event, ctx);
        }
      },
      on: (event: string, handler: Function) => {
        if (event === 'before-tool-call') {
          callbackEngine.register('before-tool-call', handler as (ctx: HookContext) => void);
        }
      },
      off: (_event: string, _handler: Function) => {
        // Unregister is handled by CallbackEngine.unregister if needed
      },
    };

    context.realtimeAnalyzer = new RealtimeCodeAnalyzer(
      analyzerCallbackAdapter,
      null, // FirewallEngine integration — passed at runtime via analyzeBeforeWrite
      maxLatencyMs,
      blockOnCriticalOnly,
    );

    // Register the hook
    context.realtimeAnalyzer.registerHook();
    anyEnabled = true;
  }

  // ─── 4. HackabilityScoringEngine (Req 2.1) ─────────────────────
  // Registers as after-tool-call handler for file writes.
  if (featureGate.isEnabled('runtimesecurity_hackability_scoring')) {
    const hackabilityConfig: HackabilityScoringConfig = {
      weights: {
        injectionRisk: 20,
        secretsExposure: 20,
        authenticationWeakness: 20,
        dataValidation: 20,
        aiSpecificRisk: 20,
      },
      criticalThreshold: config.runtimeSecurityHackability?.criticalThreshold ?? 75,
      warningThreshold: config.runtimeSecurityHackability?.warningThreshold ?? 40,
      maxLatencyMs: 500,
    };

    // Create a CallbackEngine adapter that also forwards to evidence store
    const hackabilityCallbackAdapter = {
      emit: (event: string, ctx: unknown) => {
        // Forward findings to AttackPathMapper if available
        if (context.attackPathMapper && event === 'security-score-computed') {
          forwardToAttackPathMapper(context.attackPathMapper, ctx);
        }
        // Persist to evidence store
        if (context.evidenceStore) {
          recordSecurityEvent(context.evidenceStore, 'hackability_scoring', event, ctx);
        }
      },
    };

    context.hackabilityScoring = new HackabilityScoringEngine(
      hackabilityConfig,
      hackabilityCallbackAdapter,
      null, // FirewallEngine — provided at call time if available
      null, // SecurityScanner — provided at call time if available
    );

    // Register after-tool-call hook for file writes
    callbackEngine.register('after-tool-call', (hookCtx: HookContext) => {
      if (isFileWriteToolCall(hookCtx) && context.hackabilityScoring) {
        const { filePath, content } = extractFileWriteDetails(hookCtx);
        if (filePath && content) {
          // Fire and forget — scoring is async but non-blocking
          void context.hackabilityScoring.scoreFile(filePath, content, hookCtx.sessionId);
        }
      }
    });

    anyEnabled = true;
  }

  // ─── 5. ThreatModeler (Req 3.1) ────────────────────────────────
  // Registers as after-tool-call handler for code generation.
  if (featureGate.isEnabled('runtimesecurity_threat_modeling')) {
    const profile: ThreatModelProfile = config.runtimeSecurityThreatModeling?.profile ?? {
      usesExternalLLMApis: true,
      acceptsUserPrompts: true,
      storesConversationHistory: false,
      handlesFinancialData: false,
      handlesPII: true,
    };

    // Create a CallbackEngine adapter that also forwards to evidence store
    const threatModelerCallbackAdapter = {
      emit: (event: string, ctx: unknown) => {
        if (context.evidenceStore) {
          recordSecurityEvent(context.evidenceStore, 'threat_modeler', event, ctx);
        }
      },
    };

    context.threatModeler = new ThreatModeler(
      profile,
      threatModelerCallbackAdapter,
      null, // FirewallEngine — provided at call time if available
    );

    // Register after-tool-call hook for code generation (file writes)
    callbackEngine.register('after-tool-call', (hookCtx: HookContext) => {
      if (isFileWriteToolCall(hookCtx) && context.threatModeler) {
        const { filePath, content } = extractFileWriteDetails(hookCtx);
        if (filePath && content) {
          void context.threatModeler.analyze(
            [{ path: filePath, content }],
            hookCtx.sessionId,
          );
        }
      }
    });

    anyEnabled = true;
  }

  // ─── 6. AISecurityRuleEngine (Req 7.1) ─────────────────────────
  // Registers as after-tool-call handler for file writes.
  if (featureGate.isEnabled('runtimesecurity_ai_security_rules')) {
    const rules: AISecurityRule[] = AISecurityRuleEngine.getDefaultRules();

    // Create a CallbackEngine adapter that also forwards to evidence store
    const aiRulesCallbackAdapter = {
      emit: (event: string, ctx: unknown) => {
        if (context.evidenceStore) {
          recordSecurityEvent(context.evidenceStore, 'ai_security_rules', event, ctx);
        }
      },
    };

    context.aiSecurityRules = new AISecurityRuleEngine(
      rules,
      aiRulesCallbackAdapter,
      null, // FirewallEngine coverage — provided at call time if available
    );

    // Register after-tool-call hook for file writes
    callbackEngine.register('after-tool-call', (hookCtx: HookContext) => {
      if (isFileWriteToolCall(hookCtx) && context.aiSecurityRules) {
        const { filePath, content } = extractFileWriteDetails(hookCtx);
        if (filePath && content) {
          context.aiSecurityRules.evaluate(filePath, content, hookCtx.sessionId);
        }
      }
    });

    anyEnabled = true;
  }

  // If no subsystem was enabled, return null (zero overhead)
  if (!anyEnabled) {
    return null;
  }

  return context;
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Determine if a hook context represents a file write tool call.
 */
function isFileWriteToolCall(ctx: HookContext): boolean {
  return ctx.toolName === 'write_file' ||
    ctx.toolName === 'create_file' ||
    ctx.toolName === 'edit_file' ||
    ctx.toolName === 'fs_write';
}

/**
 * Extract file path and content from a file write hook context.
 */
function extractFileWriteDetails(ctx: HookContext): { filePath: string | undefined; content: string | undefined } {
  const input = ctx.input as Record<string, unknown> | undefined;
  const output = ctx.output as Record<string, unknown> | undefined;

  const filePath = (input?.['filePath'] ?? input?.['path'] ?? input?.['file']) as string | undefined;
  const content = (input?.['content'] ?? input?.['text'] ?? output?.['content']) as string | undefined;

  return { filePath, content };
}

/**
 * Forward hackability scoring findings to AttackPathMapper for correlation.
 */
function forwardToAttackPathMapper(
  mapper: AttackPathMapper,
  ctx: unknown,
): void {
  const event = ctx as {
    filePath?: string;
    score?: number;
    contributingFactors?: string[];
    breakdown?: Record<string, number>;
  } | undefined;

  if (!event?.filePath || !event.contributingFactors) {
    return;
  }

  // Create vulnerability nodes from contributing factors
  for (let i = 0; i < event.contributingFactors.length; i++) {
    const factor = event.contributingFactors[i]!;
    const severity = (event.score ?? 0) > 75 ? 'critical' as const
      : (event.score ?? 0) > 40 ? 'high' as const
        : 'medium' as const;

    mapper.addFinding({
      id: `hackability-${event.filePath}-${i}-${Date.now()}`,
      file: event.filePath,
      line: 0, // Line-level detail not available from scoring summary
      category: inferCategoryFromFactor(factor),
      severity,
      source: 'hackability',
    });
  }
}

/**
 * Infer a vulnerability category from a contributing factor description.
 */
function inferCategoryFromFactor(factor: string): string {
  const lowerFactor = factor.toLowerCase();
  if (lowerFactor.includes('injection') || lowerFactor.includes('eval') || lowerFactor.includes('exec')) {
    return 'injectionRisk';
  }
  if (lowerFactor.includes('secret') || lowerFactor.includes('key') || lowerFactor.includes('token') || lowerFactor.includes('password')) {
    return 'secretsExposure';
  }
  if (lowerFactor.includes('auth') || lowerFactor.includes('jwt') || lowerFactor.includes('session') || lowerFactor.includes('cors')) {
    return 'authenticationWeakness';
  }
  if (lowerFactor.includes('validation') || lowerFactor.includes('parse') || lowerFactor.includes('redirect') || lowerFactor.includes('input')) {
    return 'dataValidation';
  }
  if (lowerFactor.includes('ai') || lowerFactor.includes('prompt') || lowerFactor.includes('pii') || lowerFactor.includes('llm')) {
    return 'aiSpecificRisk';
  }
  return 'dataValidation'; // default category
}

/**
 * Record a security event to the SecurityEvidenceStore.
 * Gracefully handles any errors to avoid disrupting the pipeline.
 */
function recordSecurityEvent(
  store: SecurityEvidenceStore,
  subsystem: string,
  event: string,
  ctx: unknown,
): void {
  try {
    const eventData = ctx as Record<string, unknown> | undefined;
    if (!eventData) return;

    const severity = (eventData['severity'] as string) ?? 'medium';
    const filePath = (eventData['filePath'] as string) ?? '';
    const sessionId = (eventData['sessionId'] as string) ?? '';
    const decision = event.includes('blocked') ? 'blocked' as const
      : event.includes('warned') ? 'warned' as const
        : 'allowed' as const;

    // Map event names to SecurityEventType
    const eventType: SecurityEventType = mapEventToType(event);

    store.record({
      sourceSubsystem: subsystem,
      eventType,
      severity: severity as 'critical' | 'high' | 'medium' | 'low',
      affectedFiles: filePath ? [filePath] : [],
      findingDetails: JSON.stringify(eventData),
      decision,
      sessionId,
    });
  } catch {
    // Graceful degradation — evidence recording failure must not block the pipeline
  }
}

/**
 * Map a security event name to a SecurityEventType enum value.
 */
function mapEventToType(event: string): SecurityEventType {
  if (event.includes('score')) return 'hackability_score';
  if (event.includes('threat')) return 'threat_finding';
  if (event.includes('blocked')) return 'realtime_block';
  if (event.includes('warned')) return 'realtime_warning';
  if (event.includes('attack-path')) return 'attack_path_detected';
  if (event.includes('ai-rule')) return 'ai_rule_finding';
  return 'realtime_warning';
}
