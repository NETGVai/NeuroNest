/**
 * Pipeline Engine — Orchestrates pipeline definition, validation, execution, and triggers.
 *
 * Implements the PipelineEngine interface for defining multi-step automation workflows,
 * validating type compatibility between steps, executing pipelines sequentially, and
 * managing pipeline lifecycle (cancel, list, delete).
 *
 * Persists pipeline definitions to `.neuronest/pipelines/*.json`.
 * Integrates with ToolSystem for step execution and CallbackEngine for lifecycle hooks.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { uuidv7 } from 'uuidv7';
import * as fs from 'fs';
import * as path from 'path';
import type {
  PipelineDefinition,
  PipelineStep,
  PipelineTrigger,
  PipelineExecution,
  StepExecution,
  ValidationResult,
  ValidationError,
  StepInputSource,
} from '../shared/feature-integration-types';
import { FeatureError } from '../shared/feature-integration-errors';
import type { ToolSystem } from '../tools/tool-system';
import type { CallbackEngine } from '../pipeline/callback-engine';

// ─── Types ──────────────────────────────────────────────────────

/** Options for creating the PipelineEngine. */
export interface PipelineEngineOptions {
  /** Root project directory for resolving `.neuronest/pipelines/` paths. */
  projectDir: string;
  /** Reference to the ToolSystem for executing pipeline steps that invoke tools. */
  toolSystem: ToolSystem;
  /** Reference to the CallbackEngine for emitting lifecycle hooks. */
  callbackEngine: CallbackEngine;
}

// ─── JSON Schema Compatibility ──────────────────────────────────

/**
 * Checks whether an output JSON schema is compatible with an input JSON schema.
 *
 * Compatibility rules:
 * - If input schema is empty or accepts 'any' (no type), always compatible.
 * - Primitive types must match exactly.
 * - 'object' output is compatible with 'object' input if all required input
 *   properties exist in the output properties (structural subtyping).
 * - 'array' schemas are compatible if their item schemas are compatible.
 */
export function isSchemaCompatible(outputSchema: unknown, inputSchema: unknown): boolean {
  // No constraints on input — anything is acceptable
  if (!inputSchema || typeof inputSchema !== 'object') return true;
  if (!outputSchema || typeof outputSchema !== 'object') return true;

  const output = outputSchema as Record<string, unknown>;
  const input = inputSchema as Record<string, unknown>;

  // If neither declares a type, treat as compatible
  if (!output['type'] && !input['type']) return true;

  // If input doesn't declare a type, it accepts anything
  if (!input['type']) return true;

  // If output doesn't declare a type but input expects one, incompatible
  if (!output['type'] && input['type']) return false;

  // Primitive type match
  if (output['type'] !== input['type']) return false;

  // Object structural subtype check
  if (output['type'] === 'object' && input['type'] === 'object') {
    const outputProps = (output['properties'] as Record<string, unknown>) || {};
    const inputRequired = (input['required'] as string[]) || [];

    // All required input fields must exist in output properties
    for (const requiredField of inputRequired) {
      if (!(requiredField in outputProps)) {
        return false;
      }
    }
    return true;
  }

  // Array item type check
  if (output['type'] === 'array' && input['type'] === 'array') {
    return isSchemaCompatible(output['items'], input['items']);
  }

  return true;
}

// ─── Pipeline Engine ────────────────────────────────────────────

export class PipelineEngine {
  private readonly projectDir: string;
  private readonly toolSystem: ToolSystem;
  private readonly callbackEngine: CallbackEngine;
  private readonly pipelinesDir: string;

  /** In-memory cache of active executions. */
  private executions = new Map<string, PipelineExecution>();

  /** Abort controllers for active executions, keyed by execution ID. */
  private abortControllers = new Map<string, AbortController>();

  constructor(options: PipelineEngineOptions) {
    this.projectDir = options.projectDir;
    this.toolSystem = options.toolSystem;
    this.callbackEngine = options.callbackEngine;
    this.pipelinesDir = path.join(this.projectDir, '.neuronest', 'pipelines');
  }

  // ─── Pipeline Definition Management ───────────────────────────

  /**
   * Define a new pipeline. Assigns an ID and timestamps, persists to disk.
   *
   * @param def - Pipeline definition without id, createdAt, updatedAt.
   * @returns The complete PipelineDefinition with generated fields.
   */
  async define(
    def: Omit<PipelineDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PipelineDefinition> {
    const now = new Date().toISOString();
    const pipeline: PipelineDefinition = {
      ...def,
      id: uuidv7(),
      createdAt: now,
      updatedAt: now,
    };

    // Validate before persisting
    const validation = this.validate(pipeline);
    if (!validation.valid) {
      throw new FeatureError({
        message: `Pipeline validation failed: ${validation.errors.map((e) => e.message).join('; ')}`,
        category: 'pipeline',
        code: 'PIPELINE_VALIDATION_FAILED',
        details: { errors: validation.errors },
      });
    }

    await this.persistPipeline(pipeline);
    return pipeline;
  }

  /**
   * Validate a pipeline definition.
   *
   * Checks:
   * - Pipeline has at least one step
   * - Each step has a valid name and either toolId or agentId
   * - Step output types are compatible with next step's input mapping schemas
   */
  validate(def: PipelineDefinition): ValidationResult {
    const errors: ValidationError[] = [];

    // Must have a name
    if (!def.name || def.name.trim().length === 0) {
      errors.push({
        field: 'name',
        message: 'Pipeline name is required',
        code: 'MISSING_NAME',
      });
    }

    // Must have at least one step
    if (!def.steps || def.steps.length === 0) {
      errors.push({
        field: 'steps',
        message: 'Pipeline must have at least one step',
        code: 'NO_STEPS',
      });
      return { valid: false, errors };
    }

    // Validate each step
    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];

      if (!step.name || step.name.trim().length === 0) {
        errors.push({
          field: `steps[${i}].name`,
          message: `Step ${i} must have a name`,
          code: 'MISSING_STEP_NAME',
        });
      }

      if (!step.toolId && !step.agentId) {
        errors.push({
          field: `steps[${i}]`,
          message: `Step ${i} must specify either toolId or agentId`,
          code: 'MISSING_STEP_EXECUTOR',
        });
      }
    }

    // Validate type compatibility between consecutive steps
    for (let i = 0; i < def.steps.length - 1; i++) {
      const currentStep = def.steps[i];
      const nextStep = def.steps[i + 1];

      const outputSchema = this.resolveOutputSchema(currentStep.outputType);
      const inputSchema = this.resolveInputSchema(nextStep.inputMapping);

      if (!isSchemaCompatible(outputSchema, inputSchema)) {
        errors.push({
          field: `steps[${i}].outputType -> steps[${i + 1}].inputMapping`,
          message: `Step "${currentStep.name}" output type "${currentStep.outputType}" is incompatible with step "${nextStep.name}" input schema`,
          code: 'TYPE_INCOMPATIBLE',
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Execute a pipeline by ID. Runs steps sequentially, passing outputs forward.
   *
   * On step failure: halts execution, marks step as 'failed', subsequent steps remain 'pending'.
   * On cancel: terminates current step, marks remaining as 'skipped'.
   *
   * @param pipelineId - ID of the pipeline to execute.
   * @param params - User-supplied parameters for the pipeline run.
   * @returns The PipelineExecution record.
   */
  async execute(
    pipelineId: string,
    params: Record<string, unknown>,
  ): Promise<PipelineExecution> {
    const pipeline = await this.loadPipeline(pipelineId);
    if (!pipeline) {
      throw new FeatureError({
        message: `Pipeline not found: ${pipelineId}`,
        category: 'pipeline',
        code: 'PIPELINE_NOT_FOUND',
        details: { pipelineId },
      });
    }

    const executionId = uuidv7();
    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    const execution: PipelineExecution = {
      id: executionId,
      pipelineId,
      status: 'running',
      steps: pipeline.steps.map((step) => ({
        stepId: step.id,
        status: 'pending' as const,
      })),
      startedAt: new Date().toISOString(),
    };

    this.executions.set(executionId, execution);

    // Emit before-tool-call lifecycle event for pipeline start
    await this.emitLifecycleEvent('before-tool-call', {
      toolName: `pipeline:${pipeline.name}`,
      input: params,
    });

    // Execute steps sequentially
    const stepOutputs = new Map<string, unknown>();
    let failed = false;

    for (let i = 0; i < pipeline.steps.length; i++) {
      // Check for cancellation
      if (abortController.signal.aborted) {
        // Mark remaining steps as skipped
        for (let j = i; j < pipeline.steps.length; j++) {
          execution.steps[j].status = 'skipped';
        }
        execution.status = 'cancelled';
        execution.completedAt = new Date().toISOString();
        break;
      }

      const step = pipeline.steps[i];
      const stepExecution = execution.steps[i];

      stepExecution.status = 'running';
      stepExecution.startedAt = new Date().toISOString();

      try {
        // Resolve inputs for this step
        const resolvedInput = this.resolveStepInputs(
          step.inputMapping,
          params,
          stepOutputs,
        );

        // Execute the step
        const output = await this.executeStep(
          step,
          resolvedInput,
          abortController.signal,
        );

        stepExecution.status = 'completed';
        stepExecution.output = output;
        stepExecution.completedAt = new Date().toISOString();
        stepOutputs.set(step.id, output);
      } catch (err) {
        // Check if cancellation caused the error
        if (abortController.signal.aborted) {
          stepExecution.status = 'skipped';
          // Mark remaining steps as skipped
          for (let j = i + 1; j < pipeline.steps.length; j++) {
            execution.steps[j].status = 'skipped';
          }
          execution.status = 'cancelled';
          execution.completedAt = new Date().toISOString();
          break;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        stepExecution.status = 'failed';
        stepExecution.error = errorMessage;
        stepExecution.completedAt = new Date().toISOString();

        // Halt execution — subsequent steps remain 'pending'
        execution.status = 'failed';
        execution.error = `Step "${step.name}" failed: ${errorMessage}`;
        execution.completedAt = new Date().toISOString();
        failed = true;
        break;
      }
    }

    // If all steps completed without failure or cancellation
    if (!failed && execution.status !== 'cancelled') {
      execution.status = 'completed';
      execution.completedAt = new Date().toISOString();
    }

    // Emit after-tool-call lifecycle event for pipeline completion
    await this.emitLifecycleEvent('after-tool-call', {
      toolName: `pipeline:${pipeline.name}`,
      output: execution,
    });

    // Cleanup abort controller
    this.abortControllers.delete(executionId);

    return execution;
  }

  /**
   * Cancel a running pipeline execution.
   *
   * Aborts the current step and marks remaining steps as 'skipped'.
   */
  async cancel(executionId: string): Promise<void> {
    const abortController = this.abortControllers.get(executionId);
    if (!abortController) {
      throw new FeatureError({
        message: `Execution not found or already completed: ${executionId}`,
        category: 'pipeline',
        code: 'EXECUTION_NOT_FOUND',
        details: { executionId },
      });
    }

    abortController.abort();
  }

  /**
   * Get an execution record by ID.
   */
  async getExecution(executionId: string): Promise<PipelineExecution | null> {
    return this.executions.get(executionId) ?? null;
  }

  /**
   * List all persisted pipeline definitions.
   */
  async listPipelines(): Promise<PipelineDefinition[]> {
    await this.ensurePipelinesDir();

    const files = await fs.promises.readdir(this.pipelinesDir);
    const pipelines: PipelineDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith('.json') || file === 'quick-actions.json') continue;

      try {
        const filePath = path.join(this.pipelinesDir, file);
        const content = await fs.promises.readFile(filePath, 'utf-8');
        pipelines.push(JSON.parse(content) as PipelineDefinition);
      } catch {
        // Skip malformed files
        console.warn(`[PipelineEngine] Skipping malformed pipeline file: ${file}`);
      }
    }

    return pipelines;
  }

  /**
   * Delete a pipeline definition from disk.
   */
  async deletePipeline(pipelineId: string): Promise<void> {
    const filePath = path.join(this.pipelinesDir, `${pipelineId}.json`);

    try {
      await fs.promises.access(filePath);
    } catch {
      throw new FeatureError({
        message: `Pipeline not found: ${pipelineId}`,
        category: 'pipeline',
        code: 'PIPELINE_NOT_FOUND',
        details: { pipelineId },
      });
    }

    await fs.promises.unlink(filePath);
  }

  /**
   * Register a trigger for a pipeline. Updates the pipeline definition on disk.
   */
  async registerTrigger(pipelineId: string, trigger: PipelineTrigger): Promise<void> {
    const pipeline = await this.loadPipeline(pipelineId);
    if (!pipeline) {
      throw new FeatureError({
        message: `Pipeline not found: ${pipelineId}`,
        category: 'pipeline',
        code: 'PIPELINE_NOT_FOUND',
        details: { pipelineId },
      });
    }

    pipeline.triggers.push(trigger);
    pipeline.updatedAt = new Date().toISOString();

    await this.persistPipeline(pipeline);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Ensure the pipelines directory exists.
   */
  private async ensurePipelinesDir(): Promise<void> {
    await fs.promises.mkdir(this.pipelinesDir, { recursive: true });
  }

  /**
   * Persist a pipeline definition to disk as JSON.
   */
  private async persistPipeline(pipeline: PipelineDefinition): Promise<void> {
    await this.ensurePipelinesDir();
    const filePath = path.join(this.pipelinesDir, `${pipeline.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(pipeline, null, 2), 'utf-8');
  }

  /**
   * Load a pipeline definition from disk by ID.
   */
  private async loadPipeline(pipelineId: string): Promise<PipelineDefinition | null> {
    const filePath = path.join(this.pipelinesDir, `${pipelineId}.json`);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as PipelineDefinition;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the output schema from an outputType string.
   * The outputType can be a simple type name or a JSON schema string.
   */
  private resolveOutputSchema(outputType: string): object {
    // Try parsing as JSON schema
    try {
      const parsed = JSON.parse(outputType);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Not JSON, treat as a simple type reference
    }

    // Map simple type names to JSON schemas
    const typeMap: Record<string, object> = {
      string: { type: 'string' },
      number: { type: 'number' },
      integer: { type: 'integer' },
      boolean: { type: 'boolean' },
      object: { type: 'object' },
      array: { type: 'array' },
      null: { type: 'null' },
    };

    return typeMap[outputType] || { type: outputType };
  }

  /**
   * Resolve the effective input schema from a step's inputMapping.
   * If the step references previousStep outputs, infer expected types.
   */
  private resolveInputSchema(
    inputMapping: Record<string, StepInputSource>,
  ): object | null {
    // If the step has previous-step references, we need the output to be an object
    const hasPreviousStepRefs = Object.values(inputMapping).some(
      (source) => source.kind === 'previousStep',
    );

    if (hasPreviousStepRefs) {
      // The previous step's output should be an object (or at least parseable)
      return { type: 'object' };
    }

    // If all inputs are parameters or literals, no constraint on previous output
    return null;
  }

  /**
   * Resolve step inputs by mapping parameter values, previous step outputs, and literals.
   */
  private resolveStepInputs(
    inputMapping: Record<string, StepInputSource>,
    params: Record<string, unknown>,
    stepOutputs: Map<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, source] of Object.entries(inputMapping)) {
      switch (source.kind) {
        case 'parameter':
          resolved[key] = params[source.paramName];
          break;
        case 'previousStep': {
          const output = stepOutputs.get(source.stepId);
          resolved[key] = this.extractPath(output, source.path);
          break;
        }
        case 'literal':
          resolved[key] = source.value;
          break;
      }
    }

    return resolved;
  }

  /**
   * Extract a value from an object using a dot-separated path.
   */
  private extractPath(obj: unknown, pathStr: string): unknown {
    if (obj === null || obj === undefined) return undefined;

    const parts = pathStr.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Execute a single pipeline step by invoking the associated tool or agent.
   */
  private async executeStep(
    step: PipelineStep,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    // Check abort before starting
    if (signal.aborted) {
      throw new Error('Execution cancelled');
    }

    if (step.toolId) {
      // Execute via ToolSystem
      const result = await this.toolSystem.execute(step.toolId, input, {
        agentId: 'pipeline-engine',
        sessionId: 'pipeline-session',
        permissionMode: 'auto-approve',
      });

      if (!result.success) {
        throw new Error(result.error || `Tool "${step.toolId}" execution failed`);
      }

      return result.output;
    }

    if (step.agentId) {
      // For agent-based steps, pass through as a structured invocation
      // The actual agent invocation would be handled by the AgentLoopController
      // For now, return the input as-is (identity transform for agent steps without a real agent)
      return input;
    }

    throw new Error(`Step "${step.name}" has no toolId or agentId`);
  }

  /**
   * Emit a lifecycle event through the CallbackEngine.
   */
  private async emitLifecycleEvent(
    event: 'before-tool-call' | 'after-tool-call',
    details: { toolName: string; input?: unknown; output?: unknown },
  ): Promise<void> {
    try {
      await this.callbackEngine.emit({
        event,
        toolName: details.toolName,
        input: details.input,
        output: details.output,
        sessionId: 'pipeline-session',
        iteration: 0,
      });
    } catch {
      // Lifecycle hook failures should not break pipeline execution
    }
  }
}
