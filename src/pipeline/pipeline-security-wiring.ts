/**
 * Pipeline Security Wiring — Connects the firewall, guardrails, runtime-security,
 * and vulnerability blocker subsystems into the live agent pipeline.
 *
 * This is the single integration point that ensures all security subsystems
 * are active on the hot path when the AgentLoopController is constructed.
 *
 * All wiring is additive — existing pipeline behavior for non-security paths
 * remains unchanged.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine, HookContext } from './callback-engine.js';
import type { SuperagentConfig } from '../feature-gate/superagent-config.js';
import type { DatabaseLike } from '../runtime-security/security-evidence-store.js';
import { FirewallEngine } from '../firewall/firewall-engine.js';
import { wireRuntimeSecurity, type RuntimeSecurityContext } from '../runtime-security/runtime-security-wiring.js';
import { VulnerabilityBlocker, createVulnInterceptor } from '../security/vulnerability-blocker.js';

// ─── Constants ──────────────────────────────────────────────────

/** Tool names that represent package-install operations (npm/yarn/pip/cargo/go/gem). */
const PACKAGE_INSTALL_TOOL_NAMES = new Set([
  'shell_exec',
  'bash',
  'run_command',
  'terminal',
  'execute_command',
]);

// ─── Result Interface ───────────────────────────────────────────

/**
 * Result of pipeline security wiring containing references to all activated
 * subsystems. Subsystems that are disabled will be undefined.
 */
export interface PipelineSecurityWiringResult {
  /** The FirewallEngine instance used for content evaluation */
  firewall: FirewallEngine;
  /** Runtime security subsystem context (analyzer, scoring, etc.) */
  runtimeSecurity: RuntimeSecurityContext | null;
  /** Vulnerability interceptor function for package-install commands */
  vulnInterceptor: ((command: string) => Promise<unknown>) | null;
}

// ─── Configuration ──────────────────────────────────────────────

export interface PipelineSecurityWiringConfig {
  featureGate: FeatureGateSystem;
  callbackEngine: CallbackEngine;
  config: SuperagentConfig;
  db?: DatabaseLike | undefined;
}

// ─── GuardrailsPipeline ─────────────────────────────────────────

/**
 * GuardrailsPipeline — Orchestrator that instantiates and activates all security
 * guardrail subsystems (firewall, runtime-security, vulnerability blocking).
 *
 * Provides a unified entry point for wiring security into the pipeline.
 */
export class GuardrailsPipeline {
  private firewall: FirewallEngine;
  private runtimeSecurityContext: RuntimeSecurityContext | null = null;
  private vulnInterceptor: ((command: string) => Promise<unknown>) | null = null;

  constructor() {
    this.firewall = new FirewallEngine();
  }

  /** Get the firewall engine instance */
  getFirewall(): FirewallEngine {
    return this.firewall;
  }

  /** Get the runtime security context after wiring */
  getRuntimeSecurityContext(): RuntimeSecurityContext | null {
    return this.runtimeSecurityContext;
  }

  /** Get the vulnerability interceptor after wiring */
  getVulnInterceptor(): ((command: string) => Promise<unknown>) | null {
    return this.vulnInterceptor;
  }

  /**
   * Wire all security subsystems into the pipeline via the CallbackEngine.
   * Sets up runtime-security hooks, firewall evaluation hooks, and vulnerability
   * interceptor for package-install tool calls.
   */
  wire(config: PipelineSecurityWiringConfig): PipelineSecurityWiringResult {
    const { featureGate, callbackEngine, config: superagentConfig, db } = config;

    // ─── 1. Wire runtime security subsystems (Req 18.1) ─────────────
    this.runtimeSecurityContext = wireRuntimeSecurity(
      featureGate,
      callbackEngine,
      superagentConfig,
      db,
    );
    console.log('[PipelineSecurity] Runtime security subsystems wired — realtime-analyzer, hackability-scoring, threat-modeler active.');

    // ─── 2. Register firewall as pre-LLM-call hook (Req 18.2) ───────
    callbackEngine.register('before-llm-call', (ctx: HookContext) => {
      if (!ctx.input) return;

      // Extract the inbound message content for firewall evaluation
      const messageContent = extractMessageContent(ctx.input);
      if (!messageContent) return;

      const result = this.firewall.evaluate(messageContent, {
        agentId: ctx.sessionId,
      });

      if (result.blocked) {
        // Attach blocking info to context for upstream handling
        const ctxAny = ctx as unknown as Record<string, unknown>;
        ctxAny['firewallBlocked'] = true;
        ctxAny['firewallEvents'] = result.events;
        console.warn(
          `[PipelineSecurity] Firewall BLOCKED inbound message — tier ${result.tier}, ` +
          `${result.events.filter(e => e.blocked).length} rule(s) triggered.`,
        );
      }
    });
    console.log('[PipelineSecurity] Firewall registered on pre-LLM-call hook — inbound messages evaluated.');

    // ─── 3. Register firewall as before-tool-call hook (Req 18.3) ────
    callbackEngine.register('before-tool-call', (ctx: HookContext) => {
      if (!ctx.input) return;

      // Evaluate tool arguments through the firewall
      const argsContent = typeof ctx.input === 'string'
        ? ctx.input
        : JSON.stringify(ctx.input);

      const result = this.firewall.evaluate(argsContent, {
        agentId: ctx.sessionId,
      });

      if (result.blocked) {
        const ctxAny = ctx as unknown as Record<string, unknown>;
        ctxAny['firewallBlocked'] = true;
        ctxAny['firewallEvents'] = result.events;
        console.warn(
          `[PipelineSecurity] Firewall BLOCKED tool arguments for "${ctx.toolName}" — ` +
          `tier ${result.tier}, ${result.events.filter(e => e.blocked).length} rule(s) triggered.`,
        );
      }
    });
    console.log('[PipelineSecurity] Firewall registered on before-tool-call hook — tool arguments evaluated.');

    // ─── 4. Create and register vulnerability interceptor (Req 18.4) ─
    this.vulnInterceptor = this.setupVulnInterceptor(featureGate, callbackEngine);
    if (this.vulnInterceptor) {
      console.log('[PipelineSecurity] Vulnerability interceptor registered on package-install tool calls (npm/yarn/pip/cargo/go/gem).');
    }

    // ─── 5. Log confirmation of all activated subsystems (Req 18.5) ──
    console.log('[PipelineSecurity] ✓ All security subsystems activated:');
    console.log('[PipelineSecurity]   • Firewall — pre-LLM-call + before-tool-call hooks');
    console.log('[PipelineSecurity]   • Guardrails — runtime-security wiring complete');
    console.log('[PipelineSecurity]   • Realtime Analyzer — before-tool-call write analysis');
    console.log('[PipelineSecurity]   • Vulnerability Blocker — package-install interception');

    return {
      firewall: this.firewall,
      runtimeSecurity: this.runtimeSecurityContext,
      vulnInterceptor: this.vulnInterceptor,
    };
  }

  /**
   * Set up vulnerability interceptor and register it on package-install
   * tool calls via the before-tool-call hook.
   */
  private setupVulnInterceptor(
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
  ): ((command: string) => Promise<unknown>) | null {
    // Create VulnerabilityBlocker with default config
    const blocker = new VulnerabilityBlocker({
      primaryApiUrl: 'https://api.osv.dev/v1/query',
      cacheTtlHours: 24,
      cacheDir: '.neuronest/vuln-cache',
    });

    // Create the interceptor — feature-gate checked on each invocation
    const interceptor = createVulnInterceptor(
      blocker,
      () => featureGate.isEnabled('vulnerability_blocking'),
    );

    // Register on before-tool-call to intercept package-install commands
    callbackEngine.register('before-tool-call', async (ctx: HookContext) => {
      // Only intercept shell/command tools that might run install commands
      if (!ctx.toolName || !PACKAGE_INSTALL_TOOL_NAMES.has(ctx.toolName)) {
        return;
      }

      // Extract command string from tool input
      const command = extractCommandFromInput(ctx.input);
      if (!command) return;

      const report = await interceptor(command);
      if (report && typeof report === 'object' && 'decision' in report) {
        const vulnReport = report as { decision: string; vulnerabilities?: unknown[] };
        if (vulnReport.decision === 'blocked') {
          const ctxAny = ctx as unknown as Record<string, unknown>;
          ctxAny['vulnBlocked'] = true;
          ctxAny['vulnReport'] = vulnReport;
          console.warn(
            `[PipelineSecurity] Vulnerability blocker BLOCKED package install: "${command}"`,
          );
        }
      }
    });

    return interceptor;
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Extract message content from LLM call input for firewall evaluation.
 * Handles both string inputs and structured message arrays.
 */
function extractMessageContent(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    // Extract user messages from message array
    const userMessages = input
      .filter((msg): msg is { role: string; content: string } =>
        typeof msg === 'object' && msg !== null && 'content' in msg && msg.role === 'user',
      )
      .map(msg => msg.content);

    if (userMessages.length > 0) {
      return userMessages.join('\n');
    }
  }

  if (typeof input === 'object' && input !== null && 'content' in input) {
    const content = (input as { content: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
  }

  return null;
}

/**
 * Extract a command string from tool input (for shell/command tools).
 */
function extractCommandFromInput(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    // Common field names for command-execution tools
    if (typeof obj['command'] === 'string') return obj['command'];
    if (typeof obj['cmd'] === 'string') return obj['cmd'];
    if (typeof obj['script'] === 'string') return obj['script'];
    if (typeof obj['args'] === 'string') return obj['args'];
  }

  return null;
}

// ─── Main Wiring Function ───────────────────────────────────────

/**
 * Wire all security subsystems into the live pipeline.
 *
 * Creates a GuardrailsPipeline instance and activates all security hooks
 * on the provided CallbackEngine. This is the primary entry point called
 * during AgentLoopController construction.
 *
 * All changes are additive — non-security paths remain unchanged.
 *
 * @param featureGate - Feature gate system for checking enabled subsystems
 * @param callbackEngine - Pipeline callback engine for hook registration
 * @param config - Superagent configuration with subsystem settings
 * @param db - Optional database for evidence persistence
 * @returns The wiring result with references to all activated subsystems
 */
export function wirePipelineSecurity(
  featureGate: FeatureGateSystem,
  callbackEngine: CallbackEngine,
  config: SuperagentConfig,
  db?: DatabaseLike,
): PipelineSecurityWiringResult {
  const guardrails = new GuardrailsPipeline();

  return guardrails.wire({
    featureGate,
    callbackEngine,
    config,
    db,
  });
}
