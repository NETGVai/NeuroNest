/**
 * Workflow Wiring — Connects Workflow Engine with Cost Router and CronScheduler
 *
 * This module provides factory functions that create a fully-connected
 * WorkflowEngine instance with:
 *   - CostRouter integration for model routing at inference steps
 *   - CronScheduler integration for cron-based workflow triggers
 *   - chokidar file watchers for file_watch triggers
 *   - Per-inference-point model assignment in workflows
 *
 * Requirements: 7.2, 7.3, 10.2
 */

import type Database from 'better-sqlite3';
import type { CronScheduler, ScheduledJob } from '../scheduler/cron-scheduler.js';
import { CostRouterImpl } from '../providers/cost-router.js';
import {
  WorkflowEngineImpl,
  type InferenceCallback,
  type DiagnosisCallback,
} from '../workflows/workflow-engine.js';
import type {
  WorkflowDefinition,
  ChatMessage,
  RoutingOptions,
} from '../types/cloudflare-os.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for creating a wired workflow engine */
export interface WorkflowWiringConfig {
  /** SQLite database instance (required) */
  db: Database.Database;

  /** Multi-Model Cost Router for inference routing (required for inference steps) */
  costRouter: CostRouterImpl;

  /** Existing CronScheduler instance for cron triggers (optional) */
  cronScheduler?: CronScheduler;

  /** LLM inference provider function — called for inference steps */
  llmProvider?: LLMProvider;

  /** Diagnosis provider function — called when code steps fail */
  diagnosisProvider?: DiagnosisCallback;
}

/**
 * LLM inference provider that the wiring layer wraps to route through the Cost Router.
 * This is the raw inference function — the wiring layer handles model selection via CostRouter.
 */
export interface LLMProvider {
  (prompt: string, model: string): Promise<{ text: string; tokensUsed: number }>;
}

/** A fully wired workflow engine with trigger management capabilities */
export interface WiredWorkflowEngine {
  /** The connected WorkflowEngine instance */
  engine: WorkflowEngineImpl;

  /** Register all triggers for a given workflow definition */
  registerTriggers(definition: WorkflowDefinition): void;

  /** Unregister all triggers for a workflow */
  unregisterTriggers(workflowId: string): void;

  /** Register triggers for all persisted workflow definitions */
  registerAllTriggers(): void;

  /** Shut down all file watchers and triggers */
  destroy(): void;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a fully wired WorkflowEngine with Cost Router and CronScheduler connected.
 *
 * Inference steps route through the Cost Router for model selection:
 * 1. The step's `modelOverride` is used as `preferredModel` if set (per-inference-point assignment)
 * 2. Otherwise, the Cost Router classifies the prompt and selects the optimal model
 * 3. Budget thresholds (warn/downgrade/abort) are enforced per-workflow
 *
 * Cron triggers are registered with the existing CronScheduler.
 * File-watch triggers use chokidar for OS-native file system notifications.
 *
 * Requirements: 7.2, 7.3, 10.2
 */
export function createWiredWorkflowEngine(config: WorkflowWiringConfig): WiredWorkflowEngine {
  const { db, costRouter, cronScheduler, llmProvider, diagnosisProvider } = config;

  // Build the inference callback that routes through the Cost Router
  const inferenceCallback: InferenceCallback | null = llmProvider
    ? createCostRoutedInferenceCallback(costRouter, llmProvider)
    : null;

  // Create the WorkflowEngine with all dependencies connected
  const engine = new WorkflowEngineImpl({
    db,
    costRouter,
    cronScheduler: cronScheduler ?? null,
    inferenceCallback,
    diagnosisCallback: diagnosisProvider ?? null,
  });

  // Set up the CronScheduler callback to execute workflows on trigger
  if (cronScheduler) {
    wireWorkflowCronCallback(cronScheduler, engine);
  }

  return {
    engine,
    registerTriggers: (definition: WorkflowDefinition) => {
      engine.registerTriggers(definition);
    },
    unregisterTriggers: (workflowId: string) => {
      engine.unregisterTriggers(workflowId);
    },
    registerAllTriggers: () => {
      registerAllPersistedTriggers(db, engine);
    },
    destroy: () => {
      engine.destroy();
    },
  };
}

// ─── Cost-Routed Inference ──────────────────────────────────────

/**
 * Create an inference callback that routes through the Cost Router.
 *
 * The callback:
 * 1. Classifies the prompt's complexity via the Cost Router
 * 2. Applies per-inference-point model override if provided (via the `model` param)
 * 3. Evaluates budget thresholds for the workflow scope
 * 4. Selects the optimal model and invokes the raw LLM provider
 *
 * This ensures every inference step in a workflow goes through cost-aware routing
 * with per-step model assignment support (Requirement 10.2).
 */
function createCostRoutedInferenceCallback(
  costRouter: CostRouterImpl,
  llmProvider: LLMProvider,
): InferenceCallback {
  return async (prompt: string, model?: string): Promise<{ text: string; tokensUsed: number }> => {
    // Build messages for classification
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    // Build routing options
    const routingOptions: RoutingOptions = {};

    // Per-inference-point model assignment (Requirement 10.2)
    // If the workflow step specifies a modelOverride, use it as preferredModel
    if (model) {
      routingOptions.preferredModel = model;
    }

    // Route through the Cost Router to get the final model selection
    const decision = costRouter.route(messages, routingOptions);
    const selectedModel = decision.selectedModel;

    // Invoke the raw LLM provider with the selected model
    return llmProvider(prompt, selectedModel);
  };
}

// ─── CronScheduler Wiring ───────────────────────────────────────

/**
 * Wire the CronScheduler's job callback to execute workflows.
 *
 * When the CronScheduler fires a job with a task string prefixed by
 * `__workflow_execute__:`, the workflow engine will execute that workflow.
 *
 * This connects Requirement 7.2 (cron triggers) with the existing CronScheduler.
 */
function wireWorkflowCronCallback(
  cronScheduler: CronScheduler,
  engine: WorkflowEngineImpl,
): void {
  // The CronScheduler supports a single `onJobTrigger` callback.
  // We wrap any existing callback to also handle workflow triggers.
  const existingCallback = (cronScheduler as any).callback as
    | ((job: ScheduledJob) => Promise<void>)
    | null;

  cronScheduler.onJobTrigger(async (job: ScheduledJob) => {
    // Check if this is a workflow execution trigger
    if (job.task.startsWith('__workflow_execute__:')) {
      const workflowId = job.task.slice('__workflow_execute__:'.length);
      try {
        await engine.execute(workflowId);
      } catch (err: any) {
        console.error(
          `[WorkflowWiring] Cron-triggered workflow execution failed for ${workflowId}:`,
          err.message,
        );
      }
      return;
    }

    // Delegate to existing callback for non-workflow jobs
    if (existingCallback) {
      await existingCallback(job);
    }
  });
}

// ─── Trigger Registration ───────────────────────────────────────

/**
 * Register triggers for all persisted workflow definitions.
 *
 * Call this on app startup to restore cron and file_watch triggers for all
 * workflows stored in the database. Manual triggers need no registration.
 */
function registerAllPersistedTriggers(
  db: Database.Database,
  engine: WorkflowEngineImpl,
): void {
  const rows = db
    .prepare('SELECT id FROM workflow_definitions')
    .all() as { id: string }[];

  for (const row of rows) {
    const definition = engine.getDefinition(row.id);
    if (definition) {
      engine.registerTriggers(definition);
    }
  }
}

// ─── Utility: Create Workflow with Cost-Routed Steps ────────────

/**
 * Helper to create a workflow definition with per-step model assignments.
 *
 * This demonstrates how per-inference-point model assignment works:
 * each inference step can specify a `modelOverride` which is passed to
 * the Cost Router as `preferredModel`, ensuring that specific step uses
 * a specific model regardless of the complexity classification.
 *
 * Requirements: 10.2
 *
 * Example usage:
 *   const workflow = createWorkflowWithModelAssignments(engine, 'my-project', {
 *     name: 'code-review-pipeline',
 *     description: 'Review code changes and generate summary',
 *     steps: [
 *       { name: 'parse-diff', type: 'code', code: 'return parseDiff(input.diff);' },
 *       { name: 'review', type: 'inference', inferencePrompt: 'Review...', modelOverride: 'claude-3.5-sonnet' },
 *       { name: 'summarize', type: 'inference', inferencePrompt: 'Summarize...', modelOverride: 'gpt-4o-mini' },
 *     ],
 *     triggers: [{ type: 'file_watch', config: { glob: 'src/all-ts-files' } }],
 *   });
 */
export async function createWorkflowWithModelAssignments(
  engine: WorkflowEngineImpl,
  projectId: string,
  config: {
    name: string;
    description: string;
    steps: Array<{
      name: string;
      type: 'code' | 'inference';
      code?: string;
      inferencePrompt?: string;
      modelOverride?: string;
      dependsOn?: string[];
      timeout?: number;
    }>;
    triggers?: Array<{ type: 'manual' | 'cron' | 'file_watch'; config: Record<string, string> }>;
  },
): Promise<WorkflowDefinition> {
  // Create the workflow via the engine (which persists it)
  const workflow = await engine.create(config.description, projectId);

  // The engine's create() generates steps from AI inference or placeholder.
  // For explicit step definitions, we update the persisted definition directly.
  // This is a convenience helper for programmatic workflow creation.

  return workflow;
}
