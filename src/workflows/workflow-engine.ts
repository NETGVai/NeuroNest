/**
 * Deterministic Workflow Engine — Converts recurring agent workflows into
 * code pipelines with AI at decision points only.
 *
 * Code steps execute in a sandboxed V8 isolate (vm.createContext()).
 * Inference steps route through Multi-Model Cost Router.
 * Steps without dependencies run concurrently (DAG-based scheduling).
 * Failures at code steps trigger agent-assisted diagnosis.
 *
 * Triggers: manual, cron (via existing CronScheduler), file_watch (via chokidar).
 * Token reporting distinguishes generation vs execution tokens.
 * Persistence: workflow_definitions and workflow_executions SQLite tables.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import * as vm from 'node:vm';
import type Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import { createSubsystemError } from '../types/subsystem-error.js';
import type {
  WorkflowEngine,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowExecution,
  StepResult,
  TokenReport,
  DiagnosisResult,
  ValidationResult,
  ChatMessage,
} from '../types/cloudflare-os.js';
import type { CostRouterImpl } from '../providers/cost-router.js';
import type { CronScheduler } from '../scheduler/cron-scheduler.js';

// ─── Types ──────────────────────────────────────────────────────

/** Database row for a workflow definition */
interface WorkflowDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string;
  steps: string; // JSON
  triggers: string; // JSON
  created_at: string;
  updated_at: string;
}

/** Database row for a workflow execution */
interface WorkflowExecutionRow {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  step_results: string | null; // JSON
  tokens_generation: number;
  tokens_execution: number;
}

/** Options for the inference callback */
export interface InferenceCallback {
  (prompt: string, model?: string): Promise<{ text: string; tokensUsed: number }>;
}

/** Options for the diagnosis callback */
export interface DiagnosisCallback {
  (stepId: string, code: string, error: string): Promise<DiagnosisResult>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default timeout for code step execution (30 seconds) */
const DEFAULT_CODE_TIMEOUT_MS = 30_000;

/** Default timeout for inference step execution (60 seconds) */
const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;

// ─── Implementation ─────────────────────────────────────────────

export class WorkflowEngineImpl implements WorkflowEngine {
  private readonly db: Database.Database;
  private readonly costRouter: CostRouterImpl | null;
  private readonly cronScheduler: CronScheduler | null;
  private readonly inferenceCallback: InferenceCallback | null;
  private readonly diagnosisCallback: DiagnosisCallback | null;
  private readonly fileWatchers: Map<string, { close: () => void }> = new Map();
  private readonly activeExecutions: Map<string, WorkflowExecution> = new Map();
  private readonly pausedExecutions: Set<string> = new Set();

  constructor(options: {
    db: Database.Database;
    costRouter?: CostRouterImpl | null;
    cronScheduler?: CronScheduler | null;
    inferenceCallback?: InferenceCallback | null;
    diagnosisCallback?: DiagnosisCallback | null;
  }) {
    this.db = options.db;
    this.costRouter = options.costRouter ?? null;
    this.cronScheduler = options.cronScheduler ?? null;
    this.inferenceCallback = options.inferenceCallback ?? null;
    this.diagnosisCallback = options.diagnosisCallback ?? null;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Create a new workflow definition from a natural language description.
   * Uses agent inference to generate code pipelines.
   *
   * Requirements: 7.1
   */
  async create(description: string, projectId: string): Promise<WorkflowDefinition> {
    const id = uuidv7();
    const now = new Date().toISOString();

    // Generate workflow steps from description via inference
    let steps: WorkflowStep[] = [];
    if (this.inferenceCallback) {
      const prompt = this.buildCreationPrompt(description);
      const result = await this.inferenceCallback(prompt);
      steps = this.parseGeneratedSteps(result.text);
    } else {
      // Fallback: create a single code step placeholder
      steps = [
        {
          id: uuidv7(),
          name: 'main',
          type: 'code',
          code: `// TODO: Implement workflow for: ${description}\nreturn { result: "placeholder" };`,
          dependsOn: [],
          timeout: DEFAULT_CODE_TIMEOUT_MS,
        },
      ];
    }

    const definition: WorkflowDefinition = {
      id,
      name: this.generateWorkflowName(description),
      description,
      projectId,
      steps,
      triggers: [{ type: 'manual', config: {} }],
      createdAt: now,
      updatedAt: now,
    };

    // Persist to database
    this.persistDefinition(definition);
    return definition;
  }

  /**
   * Validate a workflow definition.
   * Enforces that every step is either 'code' or 'inference' type.
   * Checks for dependency cycles and missing references.
   *
   * Requirements: 7.3
   */
  validate(workflow: WorkflowDefinition): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepIds = new Set(workflow.steps.map((s) => s.id));

    for (const step of workflow.steps) {
      // Every step must be 'code' or 'inference'
      if (step.type !== 'code' && step.type !== 'inference') {
        errors.push(
          `Step "${step.name}" (${step.id}) has invalid type "${step.type}". Must be 'code' or 'inference'.`,
        );
      }

      // Code steps must have code
      if (step.type === 'code' && !step.code) {
        errors.push(`Code step "${step.name}" (${step.id}) is missing code.`);
      }

      // Inference steps must have a prompt
      if (step.type === 'inference' && !step.inferencePrompt) {
        errors.push(
          `Inference step "${step.name}" (${step.id}) is missing inferencePrompt.`,
        );
      }

      // Check dependency references
      for (const depId of step.dependsOn) {
        if (!stepIds.has(depId)) {
          errors.push(
            `Step "${step.name}" (${step.id}) depends on non-existent step "${depId}".`,
          );
        }
      }

      // Warn if timeout is very short
      if (step.timeout < 1000) {
        warnings.push(
          `Step "${step.name}" (${step.id}) has a very short timeout (${step.timeout}ms).`,
        );
      }
    }

    // Check for cycles in the dependency graph
    if (this.hasCycle(workflow.steps)) {
      errors.push('Workflow contains a dependency cycle.');
    }

    // Validate triggers
    for (const trigger of workflow.triggers) {
      if (!['manual', 'cron', 'file_watch'].includes(trigger.type)) {
        errors.push(`Invalid trigger type: "${trigger.type}".`);
      }
      if (trigger.type === 'cron' && !trigger.config.schedule) {
        errors.push('Cron trigger is missing "schedule" config.');
      }
      if (trigger.type === 'file_watch' && !trigger.config.glob) {
        errors.push('File watch trigger is missing "glob" config.');
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Execute a workflow by ID.
   * Code steps run in sandboxed V8; inference steps go through Cost Router.
   * Independent steps run in parallel (DAG-based scheduling).
   *
   * Requirements: 7.2, 7.3, 7.4
   */
  async execute(
    workflowId: string,
    input?: Record<string, unknown>,
  ): Promise<WorkflowExecution> {
    const definition = this.getDefinition(workflowId);
    if (!definition) {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} not found`,
        { recoverable: false, details: { workflowId } },
      );
    }

    // Validate before execution
    const validation = this.validate(definition);
    if (!validation.valid) {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_VALIDATION_FAILED',
        `Workflow validation failed: ${validation.errors.join('; ')}`,
        { recoverable: true, details: { errors: validation.errors } },
      );
    }

    const executionId = uuidv7();
    const now = new Date().toISOString();

    const execution: WorkflowExecution = {
      id: executionId,
      workflowId,
      status: 'running',
      startedAt: now,
      stepResults: new Map(),
      tokenUsage: { generation: 0, execution: 0 },
    };

    this.activeExecutions.set(executionId, execution);
    this.persistExecution(execution);

    try {
      // Execute steps in DAG order with parallel independent steps
      await this.executeDAG(definition.steps, execution, input);

      // Mark as completed
      execution.status = 'completed';
      execution.completedAt = new Date().toISOString();
    } catch (err: any) {
      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
    } finally {
      this.updateExecution(execution);
      this.activeExecutions.delete(executionId);
    }

    return execution;
  }

  /**
   * Pause a running execution. Non-dependent steps already in flight complete;
   * new steps are not started.
   *
   * Requirements: 7.6
   */
  pause(executionId: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'paused';
      this.pausedExecutions.add(executionId);
      this.updateExecution(execution);
    }
  }

  /**
   * Resume a paused execution. Re-runs from the first incomplete step.
   *
   * Requirements: 7.6
   */
  async resume(executionId: string): Promise<WorkflowExecution> {
    this.pausedExecutions.delete(executionId);

    // Load execution from DB
    const execution = this.loadExecution(executionId);
    if (!execution) {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_NOT_FOUND',
        `Execution ${executionId} not found`,
        { recoverable: false, details: { executionId } },
      );
    }

    const definition = this.getDefinition(execution.workflowId);
    if (!definition) {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_NOT_FOUND',
        `Workflow ${execution.workflowId} not found`,
        { recoverable: false },
      );
    }

    execution.status = 'running';
    this.activeExecutions.set(executionId, execution);

    try {
      // Resume from incomplete steps
      const remainingSteps = definition.steps.filter(
        (s) => !execution.stepResults.has(s.id),
      );
      await this.executeDAG(remainingSteps, execution);
      execution.status = 'completed';
      execution.completedAt = new Date().toISOString();
    } catch {
      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
    } finally {
      this.updateExecution(execution);
      this.activeExecutions.delete(executionId);
    }

    return execution;
  }

  /**
   * Get execution history for a workflow.
   *
   * Requirements: 7.7
   */
  getHistory(workflowId: string): WorkflowExecution[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY started_at DESC',
      )
      .all(workflowId) as WorkflowExecutionRow[];

    return rows.map((row) => this.rowToExecution(row));
  }

  /**
   * Get a token usage report distinguishing generation vs execution tokens.
   *
   * Requirements: 7.5
   */
  getTokenReport(workflowId: string): TokenReport {
    const executions = this.getHistory(workflowId);

    let totalGeneration = 0;
    let totalExecution = 0;
    const byStep: TokenReport['byStep'] = [];

    for (const exec of executions) {
      totalGeneration += exec.tokenUsage.generation;
      totalExecution += exec.tokenUsage.execution;

      for (const [stepId, result] of exec.stepResults) {
        if (result.tokensUsed) {
          // Determine step type from the definition
          const definition = this.getDefinition(workflowId);
          const step = definition?.steps.find((s) => s.id === stepId);
          byStep.push({
            stepId,
            tokens: result.tokensUsed,
            type: step?.type ?? 'code',
          });
        }
      }
    }

    return { workflowId, totalGeneration, totalExecution, byStep };
  }

  /**
   * Diagnose a failed workflow step using agent-assisted analysis.
   *
   * Requirements: 7.6
   */
  async diagnose(executionId: string, stepId: string): Promise<DiagnosisResult> {
    const execution = this.loadExecution(executionId);
    if (!execution) {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_NOT_FOUND',
        `Execution ${executionId} not found`,
        { recoverable: false, details: { executionId } },
      );
    }

    const stepResult = execution.stepResults.get(stepId);
    if (!stepResult || stepResult.status !== 'failed') {
      throw createSubsystemError(
        'workflow_engine',
        'WORKFLOW_STEP_FAILED',
        `Step ${stepId} has not failed or does not exist`,
        { recoverable: false, details: { executionId, stepId } },
      );
    }

    // Get the step definition for code context
    const definition = this.getDefinition(execution.workflowId);
    const step = definition?.steps.find((s) => s.id === stepId);

    if (this.diagnosisCallback && step?.code) {
      return this.diagnosisCallback(stepId, step.code, stepResult.error ?? 'Unknown error');
    }

    // Fallback: use inference for diagnosis
    if (this.inferenceCallback && step) {
      const prompt = `Diagnose this workflow step failure:\n\nStep: ${step.name}\nType: ${step.type}\nCode: ${step.code ?? 'N/A'}\nError: ${stepResult.error}\n\nProvide:\n1. Error summary\n2. Suggested fix\n3. Confidence (0-1)`;
      const result = await this.inferenceCallback(prompt);
      return {
        stepId,
        errorSummary: stepResult.error ?? 'Unknown error',
        suggestedFix: result.text,
        confidence: 0.7,
      };
    }

    // No diagnosis capability available
    return {
      stepId,
      errorSummary: stepResult.error ?? 'Unknown error',
      suggestedFix: 'Unable to generate automated diagnosis. Review the error manually.',
      confidence: 0.0,
    };
  }

  // ─── Trigger Management ───────────────────────────────────────

  /**
   * Register triggers for a workflow definition.
   * Supports cron (via CronScheduler), file_watch (via chokidar), and manual.
   */
  registerTriggers(definition: WorkflowDefinition): void {
    for (const trigger of definition.triggers) {
      switch (trigger.type) {
        case 'cron':
          this.registerCronTrigger(definition, trigger);
          break;
        case 'file_watch':
          this.registerFileWatchTrigger(definition, trigger);
          break;
        case 'manual':
          // Manual triggers don't need registration
          break;
      }
    }
  }

  /**
   * Unregister all triggers for a workflow.
   */
  unregisterTriggers(workflowId: string): void {
    // Remove cron job
    if (this.cronScheduler) {
      const jobs = this.cronScheduler.listJobs();
      for (const job of jobs) {
        if (job.name === `workflow_${workflowId}`) {
          this.cronScheduler.removeJob(job.id);
        }
      }
    }

    // Remove file watchers
    const watcher = this.fileWatchers.get(workflowId);
    if (watcher) {
      watcher.close();
      this.fileWatchers.delete(workflowId);
    }
  }

  // ─── DAG Execution ────────────────────────────────────────────

  /**
   * Execute steps in DAG order. Independent steps run concurrently.
   */
  private async executeDAG(
    steps: WorkflowStep[],
    execution: WorkflowExecution,
    input?: Record<string, unknown>,
  ): Promise<void> {
    const completed = new Set<string>(execution.stepResults.keys());
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    while (completed.size < steps.length) {
      // Check if execution is paused
      if (this.pausedExecutions.has(execution.id)) {
        return;
      }

      // Find steps whose dependencies are all satisfied
      const ready = steps.filter(
        (s) =>
          !completed.has(s.id) &&
          s.dependsOn.every((dep) => completed.has(dep)),
      );

      if (ready.length === 0) {
        // No steps ready but not all completed — indicates unresolvable deps
        // (shouldn't happen after validation, but guard against it)
        break;
      }

      // Execute ready steps in parallel
      const results = await Promise.allSettled(
        ready.map((step) => this.executeStep(step, execution, input)),
      );

      // Process results
      for (let i = 0; i < ready.length; i++) {
        const step = ready[i];
        const result = results[i];

        let stepResult: StepResult;
        if (result.status === 'fulfilled') {
          stepResult = result.value;
        } else {
          stepResult = {
            stepId: step.id,
            status: 'failed',
            error: result.reason?.message ?? String(result.reason),
            durationMs: 0,
          };
        }

        execution.stepResults.set(step.id, stepResult);
        completed.add(step.id);

        // If a step failed, skip its dependents
        if (stepResult.status === 'failed') {
          this.skipDependents(step.id, steps, execution, completed);

          // Trigger agent diagnosis for code step failures
          if (step.type === 'code' && this.diagnosisCallback && step.code) {
            // Fire-and-forget diagnosis (don't block execution)
            this.diagnosisCallback(
              step.id,
              step.code,
              stepResult.error ?? 'Unknown error',
            ).catch(() => {});
          }

          // Throw to signal the workflow failed
          throw new Error(
            `Step "${step.name}" failed: ${stepResult.error}`,
          );
        }
      }
    }
  }

  /**
   * Execute a single step in the appropriate sandbox.
   */
  private async executeStep(
    step: WorkflowStep,
    execution: WorkflowExecution,
    input?: Record<string, unknown>,
  ): Promise<StepResult> {
    const startTime = Date.now();

    try {
      if (step.type === 'code') {
        return await this.executeCodeStep(step, execution, input, startTime);
      } else {
        return await this.executeInferenceStep(step, execution, startTime);
      }
    } catch (err: any) {
      return {
        stepId: step.id,
        status: 'failed',
        error: err.message ?? String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a code step in a sandboxed V8 isolate.
   * Uses vm.createContext() for isolation.
   *
   * Requirements: 7.3
   */
  private async executeCodeStep(
    step: WorkflowStep,
    execution: WorkflowExecution,
    input: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<StepResult> {
    if (!step.code) {
      throw new Error(`Code step "${step.name}" has no code to execute.`);
    }

    // Build step results from dependencies as context
    const depResults: Record<string, unknown> = {};
    for (const depId of step.dependsOn) {
      const depResult = execution.stepResults.get(depId);
      if (depResult?.output !== undefined) {
        depResults[depId] = depResult.output;
      }
    }

    // Create sandboxed context
    const sandbox: Record<string, unknown> = {
      input: input ?? {},
      deps: depResults,
      console: { log: () => {}, error: () => {}, warn: () => {} },
      setTimeout: undefined,
      setInterval: undefined,
      process: undefined,
      require: undefined,
    };

    const context = vm.createContext(sandbox);
    const timeout = step.timeout || DEFAULT_CODE_TIMEOUT_MS;

    // Wrap code in an async IIFE so users can use `return`
    const wrappedCode = `(async () => { ${step.code} })()`;

    const script = new vm.Script(wrappedCode, {
      filename: `workflow-step-${step.id}.js`,
    });

    const output = await script.runInContext(context, { timeout });
    const durationMs = Date.now() - startTime;

    // Code steps count as execution tokens (code bytes / 4 as proxy)
    const executionTokens = Math.ceil((step.code.length) / 4);
    execution.tokenUsage.execution += executionTokens;

    return {
      stepId: step.id,
      status: 'success',
      output,
      durationMs,
      tokensUsed: executionTokens,
    };
  }

  /**
   * Execute an inference step through the Cost Router.
   * Never executes code — always routes through AI inference.
   *
   * Requirements: 7.4
   */
  private async executeInferenceStep(
    step: WorkflowStep,
    execution: WorkflowExecution,
    startTime: number,
  ): Promise<StepResult> {
    if (!step.inferencePrompt) {
      throw new Error(`Inference step "${step.name}" has no inferencePrompt.`);
    }

    if (!this.inferenceCallback) {
      throw new Error('No inference callback configured for inference steps.');
    }

    // Route through cost router if available
    let model: string | undefined = step.modelOverride;
    if (this.costRouter && !model) {
      const messages: ChatMessage[] = [
        { role: 'user', content: step.inferencePrompt },
      ];
      const decision = this.costRouter.route(messages, {
        workflowId: execution.workflowId,
        taskHint: step.name,
      });
      model = decision.selectedModel;
    }

    const result = await this.inferenceCallback(step.inferencePrompt, model);
    const durationMs = Date.now() - startTime;

    // Inference tokens count as generation tokens
    execution.tokenUsage.generation += result.tokensUsed;

    return {
      stepId: step.id,
      status: 'success',
      output: result.text,
      durationMs,
      tokensUsed: result.tokensUsed,
    };
  }

  // ─── Helper Methods ───────────────────────────────────────────

  /**
   * Skip all steps that transitively depend on a failed step.
   */
  private skipDependents(
    failedStepId: string,
    steps: WorkflowStep[],
    execution: WorkflowExecution,
    completed: Set<string>,
  ): void {
    const queue = [failedStepId];
    const skipped = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      for (const step of steps) {
        if (
          !skipped.has(step.id) &&
          !completed.has(step.id) &&
          step.dependsOn.includes(currentId)
        ) {
          skipped.add(step.id);
          completed.add(step.id);
          execution.stepResults.set(step.id, {
            stepId: step.id,
            status: 'skipped',
            durationMs: 0,
          });
          queue.push(step.id);
        }
      }
    }
  }

  /**
   * Detect cycles in the step dependency graph using DFS.
   */
  private hasCycle(steps: WorkflowStep[]): boolean {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (stepId: string): boolean => {
      if (inStack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      inStack.add(stepId);

      const step = stepMap.get(stepId);
      if (step) {
        for (const dep of step.dependsOn) {
          if (dfs(dep)) return true;
        }
      }

      inStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (dfs(step.id)) return true;
    }
    return false;
  }

  /**
   * Register a cron trigger with the existing CronScheduler.
   */
  private registerCronTrigger(
    definition: WorkflowDefinition,
    trigger: WorkflowTrigger,
  ): void {
    if (!this.cronScheduler) return;

    const schedule = trigger.config.schedule ?? 'daily';
    this.cronScheduler.addJob(
      definition.projectId,
      `workflow_${definition.id}`,
      schedule,
      `__workflow_execute__:${definition.id}`,
    );
  }

  /**
   * Register a file_watch trigger using chokidar.
   */
  private registerFileWatchTrigger(
    definition: WorkflowDefinition,
    trigger: WorkflowTrigger,
  ): void {
    const glob = trigger.config.glob;
    if (!glob) return;

    // Dynamic import of chokidar (available as dependency)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const chokidar = require('chokidar');
      const watcher = chokidar.watch(glob, {
        ignoreInitial: true,
        persistent: true,
      });

      watcher.on('change', () => {
        this.execute(definition.id).catch((err: any) => {
          console.error(
            `[WorkflowEngine] File watch trigger failed for ${definition.id}:`,
            err.message,
          );
        });
      });

      this.fileWatchers.set(definition.id, watcher);
    } catch (err: any) {
      console.warn(
        `[WorkflowEngine] Could not set up file watcher for ${definition.id}:`,
        err.message,
      );
    }
  }

  // ─── Persistence ──────────────────────────────────────────────

  /**
   * Persist a workflow definition to the database.
   */
  private persistDefinition(definition: WorkflowDefinition): void {
    this.db
      .prepare(
        `INSERT INTO workflow_definitions (id, name, description, project_id, steps, triggers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definition.id,
        definition.name,
        definition.description,
        definition.projectId,
        JSON.stringify(definition.steps),
        JSON.stringify(definition.triggers),
        definition.createdAt,
        definition.updatedAt,
      );
  }

  /**
   * Get a workflow definition by ID.
   */
  getDefinition(workflowId: string): WorkflowDefinition | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_definitions WHERE id = ?')
      .get(workflowId) as WorkflowDefinitionRow | undefined;

    if (!row) return null;
    return this.rowToDefinition(row);
  }

  /**
   * Persist a workflow execution to the database.
   */
  private persistExecution(execution: WorkflowExecution): void {
    this.db
      .prepare(
        `INSERT INTO workflow_executions (id, workflow_id, status, started_at, completed_at, step_results, tokens_generation, tokens_execution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.workflowId,
        execution.status,
        execution.startedAt,
        execution.completedAt ?? null,
        JSON.stringify(Object.fromEntries(execution.stepResults)),
        execution.tokenUsage.generation,
        execution.tokenUsage.execution,
      );
  }

  /**
   * Update an existing execution record.
   */
  private updateExecution(execution: WorkflowExecution): void {
    this.db
      .prepare(
        `UPDATE workflow_executions SET status = ?, completed_at = ?, step_results = ?, tokens_generation = ?, tokens_execution = ?
         WHERE id = ?`,
      )
      .run(
        execution.status,
        execution.completedAt ?? null,
        JSON.stringify(Object.fromEntries(execution.stepResults)),
        execution.tokenUsage.generation,
        execution.tokenUsage.execution,
        execution.id,
      );
  }

  /**
   * Load an execution from the database.
   */
  private loadExecution(executionId: string): WorkflowExecution | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_executions WHERE id = ?')
      .get(executionId) as WorkflowExecutionRow | undefined;

    if (!row) return null;
    return this.rowToExecution(row);
  }

  // ─── Row Conversion ───────────────────────────────────────────

  private rowToDefinition(row: WorkflowDefinitionRow): WorkflowDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      projectId: row.project_id,
      steps: JSON.parse(row.steps) as WorkflowStep[],
      triggers: JSON.parse(row.triggers) as WorkflowTrigger[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToExecution(row: WorkflowExecutionRow): WorkflowExecution {
    const stepResultsObj = row.step_results
      ? (JSON.parse(row.step_results) as Record<string, StepResult>)
      : {};

    return {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status as WorkflowExecution['status'],
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      stepResults: new Map(Object.entries(stepResultsObj)),
      tokenUsage: {
        generation: row.tokens_generation,
        execution: row.tokens_execution,
      },
    };
  }

  // ─── Code Generation Helpers ──────────────────────────────────

  /**
   * Build a prompt for generating workflow steps from a description.
   */
  private buildCreationPrompt(description: string): string {
    return `Create a deterministic workflow from this description. Return a JSON array of steps.
Each step must have: id (unique string), name, type ('code' or 'inference'), dependsOn (array of step IDs), timeout (ms).
Code steps need a 'code' field with TypeScript code. Inference steps need an 'inferencePrompt' field.

Description: ${description}

Return ONLY the JSON array, no explanation.`;
  }

  /**
   * Parse generated steps from inference output.
   */
  private parseGeneratedSteps(text: string): WorkflowStep[] {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as WorkflowStep[];
        // Validate and normalize
        return parsed.map((step) => ({
          id: step.id || uuidv7(),
          name: step.name || 'unnamed',
          type: step.type === 'inference' ? 'inference' : 'code',
          code: step.code,
          inferencePrompt: step.inferencePrompt,
          modelOverride: step.modelOverride,
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
          timeout: step.timeout || DEFAULT_CODE_TIMEOUT_MS,
        }));
      }
    } catch {
      // Parse failure — return placeholder
    }

    return [
      {
        id: uuidv7(),
        name: 'main',
        type: 'code',
        code: '// Could not parse generated workflow\nreturn { error: "parse_failure" };',
        dependsOn: [],
        timeout: DEFAULT_CODE_TIMEOUT_MS,
      },
    ];
  }

  /**
   * Generate a concise workflow name from a description.
   */
  private generateWorkflowName(description: string): string {
    const words = description.split(/\s+/).slice(0, 5);
    return words.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  /**
   * Destroy all file watchers on shutdown.
   */
  destroy(): void {
    for (const [, watcher] of this.fileWatchers) {
      watcher.close();
    }
    this.fileWatchers.clear();
  }
}
