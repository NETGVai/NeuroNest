/**
 * IPC handler registration for the Automation Pipeline System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, diagnostics-ipc.ts).
 *
 * Channels:
 *   pipeline:define   — define a new pipeline
 *   pipeline:execute  — execute a pipeline by ID with parameters
 *   pipeline:cancel   — cancel a running pipeline execution
 *   pipeline:list     — list all saved pipeline definitions
 *   quickaction:execute — execute a quick action by ID
 *   quickaction:list   — list all quick actions
 *
 * Requirements: 4.3, 5.1
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { PipelineEngine, type PipelineEngineOptions } from '../automation/pipeline-engine.js';
import { QuickActionManager, type QuickActionManagerOptions } from '../automation/quick-action-manager.js';
import type {
  PipelineDefinition,
  PipelineExecution,
  QuickAction,
} from '../shared/feature-integration-types.js';
import type { ToolSystem } from '../tools/tool-system.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface PipelineIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singletons ────────────────────────────────────────────

let pipelineEngine: PipelineEngine | null = null;
let quickActionManager: QuickActionManager | null = null;

function getPipelineEngine(options: PipelineEngineOptions): PipelineEngine {
  if (!pipelineEngine) {
    pipelineEngine = new PipelineEngine(options);
  }
  return pipelineEngine;
}

function getQuickActionManager(options: QuickActionManagerOptions): QuickActionManager {
  if (!quickActionManager) {
    quickActionManager = new QuickActionManager(options);
  }
  return quickActionManager;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): PipelineIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

export interface PipelineIPCOptions {
  projectDir: string;
  toolSystem: ToolSystem;
  callbackEngine: CallbackEngine;
}

export function registerPipelineIPC(
  _mainWindow: BrowserWindow,
  options: PipelineIPCOptions,
): void {
  const engineOptions: PipelineEngineOptions = {
    projectDir: options.projectDir,
    toolSystem: options.toolSystem,
    callbackEngine: options.callbackEngine,
  };

  const engine = getPipelineEngine(engineOptions);

  const quickActionOptions: QuickActionManagerOptions = {
    projectDir: options.projectDir,
    pipelineEngine: engine,
  };

  const quickActions = getQuickActionManager(quickActionOptions);

  // ── pipeline:define ──
  // Requirement 4.3: Display execution trace showing step status in real time
  // (Define enables the pipelines that get executed with trace display)
  ipcMain.handle(
    'pipeline:define',
    async (
      _event,
      args: { name: string; description: string; category: string; steps: unknown[]; triggers?: unknown[]; parameters?: unknown[] },
    ) => {
      try {
        const pipeline = await engine.define({
          name: args.name,
          description: args.description,
          category: args.category,
          steps: args.steps as PipelineDefinition['steps'],
          triggers: (args.triggers ?? []) as PipelineDefinition['triggers'],
          parameters: (args.parameters ?? []) as PipelineDefinition['parameters'],
        });
        return pipeline;
      } catch (err) {
        return makeError('PIPELINE_DEFINE_FAILED', err);
      }
    },
  );

  // ── pipeline:execute ──
  // Requirement 4.3: Execute pipeline and provide execution state for trace display
  ipcMain.handle(
    'pipeline:execute',
    async (_event, args: { pipelineId: string; params?: Record<string, unknown> }) => {
      try {
        const execution = await engine.execute(
          args.pipelineId,
          args.params ?? {},
        );
        return execution;
      } catch (err) {
        return makeError('PIPELINE_EXECUTE_FAILED', err);
      }
    },
  );

  // ── pipeline:cancel ──
  // Requirement 4.5: Allow cancellation of running pipelines
  ipcMain.handle(
    'pipeline:cancel',
    async (_event, args: { executionId: string }) => {
      try {
        await engine.cancel(args.executionId);
        return { success: true };
      } catch (err) {
        return makeError('PIPELINE_CANCEL_FAILED', err);
      }
    },
  );

  // ── pipeline:list ──
  // List all saved pipeline definitions for pipeline panel display
  ipcMain.handle(
    'pipeline:list',
    async () => {
      try {
        const pipelines = await engine.listPipelines();
        return pipelines;
      } catch (err) {
        return makeError('PIPELINE_LIST_FAILED', err);
      }
    },
  );

  // ── quickaction:execute ──
  // Requirement 5.1: Quick action toolbar - execute a quick action by ID
  ipcMain.handle(
    'quickaction:execute',
    async (_event, args: { actionId: string }) => {
      try {
        const execution = await quickActions.execute(args.actionId);
        return execution;
      } catch (err) {
        return makeError('QUICKACTION_EXECUTE_FAILED', err);
      }
    },
  );

  // ── quickaction:list ──
  // Requirement 5.1: List all quick actions for toolbar rendering
  ipcMain.handle(
    'quickaction:list',
    async () => {
      try {
        const actions = quickActions.list();
        return actions;
      } catch (err) {
        return makeError('QUICKACTION_LIST_FAILED', err);
      }
    },
  );
}
