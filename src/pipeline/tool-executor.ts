/**
 * Tool Executor — Enables agents to execute real actions during conversation.
 *
 * Agents can: run shell commands, read/write files, list directories.
 * Results flow back into the chat as observations.
 * All commands run in the project directory with safety checks.
 *
 * Policy Engine integration (Requirements 6.5, 6.7):
 * When the `devops_safety_layer` feature gate is enabled, all tool calls are
 * routed through PolicyEngine.evaluate() before execution. Decisions:
 *   - 'allow' → proceed with execution
 *   - 'deny'  → return denial result without executing
 *   - 'escalate' → pause and request human approval via ApprovalQueue
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { encodeGeneric } from '../serializers/gcf-encoder';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { logger } from '../utils/logger';
import { PolicyEngine } from '../devops-engine/policy-engine';
import type { PolicyEvaluation } from '../devops-engine/types';
import type { ApprovalQueue } from './approval-queue';

// ─── P0 Sanitized Environment (Requirement 2) ──────────────────────────────
// Names copied from process.env ONLY if present. Never the whole process.env.

/** Environment variable names allowed on all platforms. */
export const ENV_ALLOWLIST_COMMON = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM'] as const;

/** Additional environment variable names allowed on Windows. */
export const ENV_ALLOWLIST_WINDOWS = ['Path', 'SystemRoot', 'COMSPEC', 'USERPROFILE', 'TEMP'] as const;

/**
 * Build a sanitized environment for spawned commands. Includes only allowlisted
 * variables (R2.1, R2.2), omits absent variables rather than empty-substituting
 * (R2.3), sets PWD scoped to the project directory (R2.4), includes Windows-
 * specific vars on win32 (R2.5), and falls back to a minimal PATH when the
 * allowlist is empty or unresolvable (R2.6). Never passes process.env by value
 * or reference.
 */
export function buildSanitizedEnv(projectDir: string): NodeJS.ProcessEnv {
  const names: readonly string[] = process.platform === 'win32'
    ? [...ENV_ALLOWLIST_COMMON, ...ENV_ALLOWLIST_WINDOWS]
    : ENV_ALLOWLIST_COMMON;

  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined) {
      env[name] = v;
    }
  }

  // Working dir scoped to project (R2.4)
  env['PWD'] = projectDir;

  // R2.6: if no allowlisted variable was resolved, still provide minimal PATH/shell.
  // Check keys length === 1 because PWD is always set above.
  if (Object.keys(env).length === 1) {
    env['PATH'] = process.env['PATH'] ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin');
  }

  return env;
}

export type ToolType = 'terminal' | 'file_read' | 'file_write' | 'file_list' | 'file_delete';

export interface ToolExecRequest {
  tool: ToolType;
  command?: string;       // For terminal
  filePath?: string;      // For file ops
  content?: string;       // For file_write
  projectId: string;
  agentId?: string;
  timeoutMs?: number;
}

export interface ToolExecResult {
  success: boolean;
  tool: ToolType;
  output: string;
  error?: string;
  durationMs: number;
  exitCode?: number;
}

// ─── Policy Engine Integration (Requirements 6.5, 6.7) ─────────────────────
//
// When `devops_safety_layer` is enabled, all tool calls pass through the
// PolicyEngine before execution. The engine instance and approval queue are
// injected via `configurePolicyEnforcement()`. When not configured, tool
// execution proceeds as before (graceful degradation).

/** Configuration for the policy enforcement layer. */
export interface PolicyEnforcementConfig {
  /** The PolicyEngine instance to evaluate requests against. */
  policyEngine: PolicyEngine;
  /** The ApprovalQueue instance for escalation flow. */
  approvalQueue: ApprovalQueue;
  /** Feature gate check — returns true if devops_safety_layer is enabled. */
  isEnabled: () => boolean;
}

/** Singleton policy enforcement configuration. Set via configurePolicyEnforcement(). */
let policyEnforcement: PolicyEnforcementConfig | null = null;

/**
 * Configure the policy enforcement layer for the tool executor.
 * Call this once during application bootstrap when the devops_safety_layer gate is available.
 *
 * @param config - The policy enforcement configuration, or null to disable.
 */
export function configurePolicyEnforcement(config: PolicyEnforcementConfig | null): void {
  policyEnforcement = config;
}

/**
 * Get the current policy enforcement configuration (for testing/inspection).
 */
export function getPolicyEnforcement(): PolicyEnforcementConfig | null {
  return policyEnforcement;
}

/**
 * Evaluate a tool execution request against the policy engine.
 * Returns null if policy enforcement is disabled or not configured (proceed normally).
 * Returns a PolicyEvaluation if enforcement is active.
 */
function evaluatePolicy(request: ToolExecRequest): PolicyEvaluation | null {
  if (!policyEnforcement) return null;
  if (!policyEnforcement.isEnabled()) return null;

  const agentId = request.agentId || 'unknown-agent';

  try {
    return policyEnforcement.policyEngine.evaluate({
      toolName: request.tool,
      agentId,
      arguments: {
        command: request.command,
        filePath: request.filePath,
        content: request.content ? '[content provided]' : undefined,
        projectId: request.projectId,
      },
    });
  } catch (error) {
    // Policy evaluation itself failed — fail-closed: deny (Requirement 6.4)
    logger.warn('[tool-executor] Policy evaluation error, denying request', error);
    return {
      decision: 'deny',
      matchedRule: null,
      correlationId: 'policy-error',
      timestamp: Date.now(),
      reason: `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Handle an 'escalate' policy decision by requesting human approval through
 * the approval queue. Returns true if approved, false if rejected.
 */
async function handleEscalation(request: ToolExecRequest, _evaluation: PolicyEvaluation): Promise<boolean> {
  if (!policyEnforcement) return false;

  const description = request.tool === 'terminal'
    ? `Policy escalation: Execute command "${request.command}" (Agent: ${request.agentId || 'unknown'})`
    : `Policy escalation: ${request.tool} operation on "${request.filePath || 'N/A'}" (Agent: ${request.agentId || 'unknown'})`;

  try {
    const approvalRequest: Record<string, string> = {
      type: request.tool === 'terminal' ? 'terminal' : 'file_write',
      agentId: request.agentId || 'unknown',
      projectId: request.projectId,
      description,
    };
    if (request.command !== undefined) {
      approvalRequest['command'] = request.command;
    }
    if (request.filePath !== undefined) {
      approvalRequest['filePath'] = request.filePath;
    }
    const result = await policyEnforcement.approvalQueue.requestApproval(approvalRequest as any);
    return result.approved;
  } catch (error) {
    // If the escalation flow itself fails, deny for safety
    logger.warn('[tool-executor] Escalation flow error, denying request', error);
    return false;
  }
}

/**
 * Create a denial result for a tool request blocked by policy.
 */
function createPolicyDenialResult(request: ToolExecRequest, evaluation: PolicyEvaluation): ToolExecResult {
  return {
    success: false,
    tool: request.tool,
    output: '',
    error: `Policy denied: ${evaluation.reason} [correlationId: ${evaluation.correlationId}]`,
    durationMs: 0,
  };
}

// Commands that are always blocked
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+\/(?!\w)/,
  /\bsudo\s+rm\b/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bformat\b.*\bc:/i,
];

function getProjectDir(projectId: string): string {
  return path.join(os.homedir(), '.neuronest', 'projects', projectId);
}

function isSafeCommand(command: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Blocked dangerous command pattern: ${pattern}` };
    }
  }
  return { safe: true };
}

export function executeTerminal(request: ToolExecRequest): ToolExecResult {
  const start = Date.now();
  const command = request.command || '';
  const projectDir = getProjectDir(request.projectId);
  const timeout = request.timeoutMs || 30000;

  // Safety check
  const safety = isSafeCommand(command);
  if (!safety.safe) {
    const result: ToolExecResult = { success: false, tool: 'terminal', output: '', durationMs: Date.now() - start };
    if (safety.reason) result.error = safety.reason;
    return result;
  }

  try {
    // Ensure project dir exists
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const output = execSync(command, {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: buildSanitizedEnv(projectDir),
    });

    return { success: true, tool: 'terminal', output: output.slice(0, 50000), durationMs: Date.now() - start, exitCode: 0 };
  } catch (e: any) {
    const output = e.stdout ? String(e.stdout).slice(0, 50000) : '';
    const error = e.stderr ? String(e.stderr).slice(0, 5000) : (e.message || 'Unknown error');
    return { success: false, tool: 'terminal', output, error, durationMs: Date.now() - start, exitCode: e.status || 1 };
  }
}

export function executeFileRead(request: ToolExecRequest): ToolExecResult {
  const start = Date.now();
  const projectDir = getProjectDir(request.projectId);
  const filePath = path.join(projectDir, request.filePath || '');

  try {
    // Prevent path traversal
    if (!filePath.startsWith(projectDir)) {
      return { success: false, tool: 'file_read', output: '', error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, tool: 'file_read', output: '', error: `File not found: ${request.filePath}`, durationMs: Date.now() - start };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, tool: 'file_read', output: content.slice(0, 100000), durationMs: Date.now() - start };
  } catch (e: any) {
    return { success: false, tool: 'file_read', output: '', error: e.message, durationMs: Date.now() - start };
  }
}

export function executeFileWrite(request: ToolExecRequest): ToolExecResult {
  const start = Date.now();
  const projectDir = getProjectDir(request.projectId);
  const filePath = path.join(projectDir, request.filePath || '');

  try {
    if (!filePath.startsWith(projectDir)) {
      return { success: false, tool: 'file_write', output: '', error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, request.content || '');
    return { success: true, tool: 'file_write', output: `Written ${(request.content || '').length} bytes to ${request.filePath}`, durationMs: Date.now() - start };
  } catch (e: any) {
    return { success: false, tool: 'file_write', output: '', error: e.message, durationMs: Date.now() - start };
  }
}

export function executeFileList(request: ToolExecRequest): ToolExecResult {
  const start = Date.now();
  const projectDir = getProjectDir(request.projectId);
  const dirPath = path.join(projectDir, request.filePath || '');

  try {
    if (!dirPath.startsWith(projectDir)) {
      return { success: false, tool: 'file_list', output: '', error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!fs.existsSync(dirPath)) {
      return { success: false, tool: 'file_list', output: '', error: `Directory not found: ${request.filePath}`, durationMs: Date.now() - start };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const listing = entries.map(e => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
    return { success: true, tool: 'file_list', output: listing, durationMs: Date.now() - start };
  } catch (e: any) {
    return { success: false, tool: 'file_list', output: '', error: e.message, durationMs: Date.now() - start };
  }
}

export function executeFileDelete(request: ToolExecRequest): ToolExecResult {
  const start = Date.now();
  const projectDir = getProjectDir(request.projectId);
  const filePath = path.join(projectDir, request.filePath || '');

  try {
    if (!filePath.startsWith(projectDir)) {
      return { success: false, tool: 'file_delete', output: '', error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, tool: 'file_delete', output: '', error: `File not found: ${request.filePath}`, durationMs: Date.now() - start };
    }
    fs.unlinkSync(filePath);
    return { success: true, tool: 'file_delete', output: `Deleted: ${request.filePath}`, durationMs: Date.now() - start };
  } catch (e: any) {
    return { success: false, tool: 'file_delete', output: '', error: e.message, durationMs: Date.now() - start };
  }
}

/**
 * Execute any tool request.
 * When the devops_safety_layer feature gate is enabled, evaluates the request
 * against the PolicyEngine before execution. Handles allow/deny/escalate decisions.
 */
export function executeTool(request: ToolExecRequest): ToolExecResult {
  // Policy enforcement pre-execution hook (Requirements 6.5, 6.7)
  const policyDecision = evaluatePolicy(request);
  if (policyDecision) {
    switch (policyDecision.decision) {
      case 'deny':
        return createPolicyDenialResult(request, policyDecision);
      case 'escalate':
        // Escalation requires async approval — cannot handle in sync path.
        // Return a denial with escalation info. Use executeToolAsync for escalation support.
        return {
          success: false,
          tool: request.tool,
          output: '',
          error: `Policy escalation required: ${policyDecision.reason}. Use executeToolAsync() for approval flow. [correlationId: ${policyDecision.correlationId}]`,
          durationMs: 0,
        };
      case 'allow':
        // Proceed with execution
        break;
    }
  }

  switch (request.tool) {
    case 'terminal': return executeTerminal(request);
    case 'file_read': return executeFileRead(request);
    case 'file_write': return executeFileWrite(request);
    case 'file_list': return executeFileList(request);
    case 'file_delete': return executeFileDelete(request);
    default: return { success: false, tool: request.tool, output: '', error: `Unknown tool: ${request.tool}`, durationMs: 0 };
  }
}

/**
 * Execute a tool request with full async policy enforcement support.
 * Handles escalation flow by pausing and requesting human approval via the ApprovalQueue.
 * Falls back to synchronous execution when policy enforcement is disabled.
 *
 * Requirements: 6.5, 6.7
 */
export async function executeToolAsync(request: ToolExecRequest): Promise<ToolExecResult> {
  // Policy enforcement pre-execution hook
  const policyDecision = evaluatePolicy(request);
  if (policyDecision) {
    switch (policyDecision.decision) {
      case 'deny':
        return createPolicyDenialResult(request, policyDecision);
      case 'escalate': {
        // Pause and request human approval (Requirement 6.5)
        const approved = await handleEscalation(request, policyDecision);
        if (!approved) {
          return {
            success: false,
            tool: request.tool,
            output: '',
            error: `Policy escalation denied by human reviewer. [correlationId: ${policyDecision.correlationId}]`,
            durationMs: 0,
          };
        }
        // Approved — fall through to execution
        break;
      }
      case 'allow':
        // Proceed with execution
        break;
    }
  }

  // Execute the tool (reuse synchronous implementations)
  switch (request.tool) {
    case 'terminal': return executeTerminal(request);
    case 'file_read': return executeFileRead(request);
    case 'file_write': return executeFileWrite(request);
    case 'file_list': return executeFileList(request);
    case 'file_delete': return executeFileDelete(request);
    default: return { success: false, tool: request.tool, output: '', error: `Unknown tool: ${request.tool}`, durationMs: 0 };
  }
}

// ─── F10 GCF_Wire_Format: Tool_Executor structured-output surface ──────────
//
// One of the four F10_Encoded_Surfaces (design.md "Encoded Surface Wiring").
// This is the post-execution path that turns a `ToolExecResult` into the
// payload a receiving agent reads as context. Per Requirement 54.4 and 55 it
// is gated by the paired `GCF_WIRE_FORMAT` / `GCF_WIRE_FORMAT_SHADOW` flags:
//
//   - GCF_WIRE_FORMAT=true                  → feed the GCF encoding to the LLM.
//   - GCF_WIRE_FORMAT=false + SHADOW=true    → compute the encoding for
//                                              telemetry only, keep the JSON.
//   - both flags false                       → skip GCF computation entirely.
//   - encodeGeneric returns null (Req 51.4)  → fall back to JSON.
//
// All telemetry emission is fail-soft: a metrics-sink or encoder regression
// must never break tool dispatch.

/** Telemetry key under which the active-mode size savings ratio is recorded. */
export const TOOL_EXECUTOR_SAVINGS_RATIO_METRIC_KEY = 'gcf.tool_executor.savings_ratio';

/**
 * Structural Metrics_Sink type — kept local so this module does not import
 * `SessionTelemetryService` directly (mirrors `MetricsSink` in
 * `src/orchestrator/orchestrator-manager.ts`). Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/**
 * Optional wiring for {@link formatToolResultForLLM}. The sink and sessionId
 * are injected by the caller (the `tool:execute` IPC dispatch site). When no
 * sink is reachable, savings telemetry falls back to the debug logger so the
 * Phase 0 size-savings signal is never silently dropped.
 */
export interface ToolResultEncodeContext {
  metricsSink?: MetricsSink;
  sessionId?: string | null;
}

/** Result of {@link formatToolResultForLLM}: the payload plus how it was encoded. */
export interface FormattedToolResult {
  /** The payload to feed the LLM — GCF text in active mode, JSON otherwise. */
  payload: string;
  /** Which encoding was actually sent to the LLM. */
  encoding: 'gcf' | 'json';
}

/**
 * Compute the byte length of a UTF-8 string without importing Buffer typings
 * at call sites. Used to derive the GCF-vs-JSON savings ratio.
 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Emit the GCF size-savings ratio for this surface. `savingsRatio` is the
 * fraction of bytes saved by GCF relative to JSON (0..1; can be negative if
 * GCF is larger). Fail-soft: never throws.
 */
function emitSavingsRatio(
  ctx: ToolResultEncodeContext | undefined,
  jsonBytes: number,
  gcfBytes: number,
): void {
  if (jsonBytes <= 0) return;
  const savingsRatio = (jsonBytes - gcfBytes) / jsonBytes;
  try {
    if (ctx?.metricsSink) {
      ctx.metricsSink.recordMetric(
        ctx.sessionId ?? null,
        TOOL_EXECUTOR_SAVINGS_RATIO_METRIC_KEY,
        savingsRatio,
      );
    } else {
      logger.debug('[tool-executor] gcf savings', {
        key: TOOL_EXECUTOR_SAVINGS_RATIO_METRIC_KEY,
        savingsRatio,
        jsonBytes,
        gcfBytes,
      });
    }
  } catch (e) {
    // A telemetry regression must never break tool dispatch.
    logger.warn('[tool-executor] failed to record gcf savings ratio', e);
  }
}

/**
 * Format a {@link ToolExecResult} into the payload a receiving agent reads as
 * context, applying the F10 GCF_Wire_Format paired-flag pattern.
 *
 * Backward-compatible: when both flags are off (or GCF encoding fails) this
 * returns the pre-existing JSON encoding unchanged, so existing callers that
 * do not pass a context behave exactly as before.
 *
 * Requirements: 54.4, 55.2, 55.3, 55.4
 */
export function formatToolResultForLLM(
  result: ToolExecResult,
  ctx?: ToolResultEncodeContext,
): FormattedToolResult {
  const json = JSON.stringify(result);

  // Both flags off → skip GCF computation entirely (Req 55.4).
  if (!PERF_FLAGS.GCF_WIRE_FORMAT && !PERF_FLAGS.GCF_WIRE_FORMAT_SHADOW) {
    return { payload: json, encoding: 'json' };
  }

  // Compute the GCF encoding once. `encodeGeneric` never throws and returns
  // null on un-encodable shapes (Req 51.4) → fall back to JSON.
  const encoded = encodeGeneric(result);
  if (encoded === null) {
    return { payload: json, encoding: 'json' };
  }

  emitSavingsRatio(ctx, byteLength(json), byteLength(encoded));

  // Active mode: feed the GCF encoding to the LLM (Req 54.4).
  if (PERF_FLAGS.GCF_WIRE_FORMAT) {
    return { payload: encoded, encoding: 'gcf' };
  }

  // Shadow mode (GCF_WIRE_FORMAT=false, SHADOW=true): telemetry only, keep
  // the JSON payload bound for the LLM unchanged (Req 55.2).
  return { payload: json, encoding: 'json' };
}
