/**
 * Tool Executor — Enables agents to execute real actions during conversation.
 *
 * Agents can: run shell commands, read/write files, list directories.
 * Results flow back into the chat as observations.
 * All commands run in the project directory with safety checks.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { encodeGeneric } from '../serializers/gcf-encoder';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { logger } from '../utils/logger';

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
    return { success: false, tool: 'terminal', output: '', error: safety.reason, durationMs: Date.now() - start };
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
      env: { ...process.env, HOME: os.homedir() },
    });

    return { success: true, tool: 'terminal', output: output.slice(0, 50000), durationMs: Date.now() - start, exitCode: 0 };
  } catch (e: any) {
    const output = e.stdout ? String(e.stdout).slice(0, 50000) : '';
    const error = e.stderr ? String(e.stderr).slice(0, 5000) : e.message;
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
 */
export function executeTool(request: ToolExecRequest): ToolExecResult {
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
