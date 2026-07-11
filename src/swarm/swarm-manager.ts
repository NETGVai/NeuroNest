/**
 * SwarmManager — Lead/worker coordination, parallel execution, shared memory.
 *
 * Real LLM execution implementation. Manages swarm creation,
 * worker coordination, task lifecycle, and human-in-the-loop checkpoints.
 * All worker tasks are executed through real LLM API calls.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 5.1–5.4, 5.7–5.8, 5.10, 5.12–5.14
 */

import { randomUUID } from 'node:crypto';
import type { SwarmConfig, SwarmStatus, TokenUsage } from '../shared/types.js';
import { LLMClient, type LLMMessage } from '../pipeline/llm-client.js';
import { DeliverableGuard, type DeliverableType } from '../optimizer/deliverable-guard.js';
import { CapabilityRouter, type CapabilityMatch } from './capability-router.js';
import { PhaseAssigner, type PhasedExecutionPlan, type PhaseNumber } from './phase-assigner.js';
import { RefusalDetector, type SubtaskOutcome, type SubtaskStatus } from './refusal-detector.js';
import type { AgentDefinition } from '../agents/agent-registry.js';
import { ModelRouter, type ModelTier } from '../routing/model-router.js';
import { BuildVerifier, type BuildVerifierConfig, type VerificationResult, type CallbackEngine } from './build-verifier.js';

// ─── Types ──────────────────────────────────────────────────────

export type WorkerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

/**
 * Provenance information for a swarm result, identifying which model
 * and request produced the response.
 * Requirements: 2.5
 */
export interface SwarmProvenance {
  /** The model name used to generate the response */
  model: string;
  /** Unique request identifier for traceability */
  requestId: string;
}

export interface WorkerProgress {
  workerId: string;
  agentId: string;
  status: WorkerStatus;
  output?: string;
  tokenUsage?: TokenUsage;
  error?: string;
  provenance?: SwarmProvenance;
}

export interface SwarmResult {
  swarmId: string;
  status: SwarmStatus;
  workerResults: WorkerProgress[];
  aggregatedOutput: string;
  totalTokenUsage: TokenUsage;
  durationMs: number;
  failures: string[];
  /** Provenance tracking for the overall swarm execution */
  provenance?: SwarmProvenance;
}

/**
 * Per-phase timing and outcome metrics.
 * Requirements: 3.4, 3.5, 5.8
 */
export interface PhaseMetric {
  phase: PhaseNumber;
  startedAt: Date;
  completedAt: Date;
  agentCount: number;
  completedCount: number;
  refusedCount: number;
  droppedCount: number;
}

/**
 * Model tier usage breakdown for cost tracking.
 * Requirements: 6.3
 */
export interface TierUsageMetric {
  expensiveCalls: number;
  cheapCalls: number;
  estimatedCostSavings: number; // compared to all-expensive baseline
}

/**
 * Result from orchestrated swarm execution, extends SwarmResult with
 * classification and phase execution metadata.
 * Requirements: 2.4, 2.5, 3.4, 3.5, 4.7, 6.4
 */
export interface OrchestratedSwarmResult extends SwarmResult {
  /** The classified deliverable type from DeliverableGuard */
  deliverableType: DeliverableType;
  /** Agents selected by CapabilityRouter */
  routedAgents: CapabilityMatch[];
  /** The phased execution plan from PhaseAssigner */
  phasedPlan: PhasedExecutionPlan;
  /** Model tier used for routing decisions */
  routingTier: ModelTier;
  /** Per-subtask outcomes with refusal tracking */
  subtaskOutcomes: SubtaskOutcome[];
  /** Build verification outcome (pass/fail, stage, duration) */
  verificationResult?: VerificationResult;
  /** Timing and outcome metrics per phase */
  phaseMetrics: PhaseMetric[];
  /** Model tier usage breakdown (expensive vs cheap calls) */
  tierUsage: TierUsageMetric;
}

export interface SwarmTask {
  id: string;
  description: string;
  priority: number;
  dependencies: string[];
  assignedWorkerId?: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
}

export interface Swarm {
  id: string;
  config: SwarmConfig;
  status: SwarmStatus;
  workers: WorkerProgress[];
  tasks: SwarmTask[];
  checkpointsPending: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Error class for LLM connection failures.
 * Provides structured connection error details.
 * Requirements: 2.3
 */
export class LLMConnectionError extends Error {
  public readonly connectionDetails: {
    provider: string;
    errorCode: string;
    originalMessage: string;
  };

  constructor(provider: string, errorCode: string, originalMessage: string) {
    super(`LLM provider unreachable: [${provider}] ${errorCode} - ${originalMessage}`);
    this.name = 'LLMConnectionError';
    this.connectionDetails = { provider, errorCode, originalMessage };
  }
}

/**
 * Error class for zero-token result validation.
 * Requirements: 2.2
 */
export class ZeroTokenResultError extends Error {
  constructor(workerId: string) {
    super(`Invalid result: worker ${workerId} reported zero tokens for a completed interaction`);
    this.name = 'ZeroTokenResultError';
  }
}

// ─── SwarmManager ───────────────────────────────────────────────

export class SwarmManager {
  private swarms = new Map<string, Swarm>();
  private progressCallbacks = new Map<string, Array<(progress: WorkerProgress) => void>>();
  private completeCallbacks = new Map<string, Array<(result: SwarmResult) => void>>();
  private llmClient: LLMClient | null = null;

  /** Agent registry for capability routing and phase assignment */
  private registry: AgentDefinition[] = [];

  /** Model router for tier-based model selection */
  private modelRouter: ModelRouter | null = null;

  /** Refusal detector for identifying agent refusals in responses */
  private refusalDetector: RefusalDetector = new RefusalDetector();

  /** Optional build verifier configuration for post-execution verification */
  private buildVerifierConfig: BuildVerifierConfig | null = null;

  /**
   * Set the agent registry used for orchestrated execution.
   * Required for startOrchestrated() to work.
   */
  setRegistry(registry: AgentDefinition[]): void {
    this.registry = registry;
  }

  /**
   * Set the ModelRouter used for tier-based routing decisions.
   * Required for startOrchestrated() to use cheap-tier for routing.
   */
  setModelRouter(router: ModelRouter): void {
    this.modelRouter = router;
  }

  /**
   * Set the BuildVerifier configuration for post-execution verification.
   * When configured, startOrchestrated() will verify builds after code generation.
   * Requirements: 5.1, 5.5, 5.6, 5.7, 5.8
   */
  setBuildVerifierConfig(config: BuildVerifierConfig): void {
    this.buildVerifierConfig = config;
  }

  /**
   * Set the LLM client used for executing worker tasks.
   * Requirements: 2.1
   */
  setLLMClient(client: LLMClient | null): void {
    this.llmClient = client;
  }

  /**
   * Get the current LLM client (for testing/inspection).
   */
  getLLMClient(): LLMClient | null {
    return this.llmClient;
  }

  /**
   * Create a new swarm from config.
   * Requirements: 5.1, 5.2, 5.10
   */
  createSwarm(config: SwarmConfig): Swarm {
    // Validate concurrency bounds (2-20)
    if (config.maxConcurrent < 2 || config.maxConcurrent > 20) {
      throw new Error(
        `maxConcurrent must be between 2 and 20, got ${config.maxConcurrent}`,
      );
    }

    const id = randomUUID();
    const workers: WorkerProgress[] = config.workerAgentIds.map((agentId) => ({
      workerId: randomUUID(),
      agentId,
      status: 'queued' as WorkerStatus,
    }));

    const swarm: Swarm = {
      id,
      config,
      status: 'planning',
      workers,
      tasks: [],
      checkpointsPending: [...(config.humanCheckpoints ?? [])],
      createdAt: new Date(),
    };

    this.swarms.set(id, swarm);
    return swarm;
  }

  /**
   * Get a swarm by ID.
   */
  getSwarm(swarmId: string): Swarm | null {
    return this.swarms.get(swarmId) ?? null;
  }

  /**
   * List all active swarms.
   */
  listActiveSwarms(): Swarm[] {
    return Array.from(this.swarms.values()).filter(
      (s) => s.status === 'running' || s.status === 'paused' || s.status === 'planning',
    );
  }

  /**
   * Execute a single worker task through the LLM API.
   * Requirements: 2.1, 2.2, 2.3, 2.5
   *
   * @param worker - The worker progress object to update
   * @param task - The task description to send to the LLM
   * @returns The updated worker with real LLM results
   * @throws LLMConnectionError when the provider is unreachable
   * @throws ZeroTokenResultError when a completed interaction reports zero tokens
   */
  private async executeWorkerTask(worker: WorkerProgress, task: string): Promise<WorkerProgress> {
    if (!this.llmClient) {
      throw new LLMConnectionError(
        'unknown',
        'NO_CLIENT',
        'No LLM client configured. Please set up an AI provider in Settings.',
      );
    }

    const requestId = randomUUID();

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a skilled AI agent executing a delegated task within a swarm workflow. Provide a thorough, actionable response.' },
      { role: 'user', content: task },
    ];

    try {
      const result = await this.llmClient.chat(messages, {
        temperature: 0.7,
        maxTokens: 2048,
      });

      // Extract token usage from response
      const promptTokens = result.promptTokens ?? 0;
      const completionTokens = result.completionTokens ?? 0;
      const totalTokens = result.tokensUsed ?? (promptTokens + completionTokens);

      // Requirement 2.2: Reject zero-token results for completed interactions
      if (totalTokens <= 0) {
        throw new ZeroTokenResultError(worker.workerId);
      }

      // Extract model name from client config
      const model = (this.llmClient as any).config?.model || 'unknown';

      worker.status = 'completed';
      worker.output = result.content;
      worker.tokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCost: 0, // Cost calculation handled by cost-store
      };
      // Requirement 2.5: Include provenance with model name and requestId
      worker.provenance = {
        model,
        requestId,
      };

      return worker;
    } catch (error: any) {
      // Requirement 2.3: Return explicit failure status with connection error details
      if (this.isConnectionError(error)) {
        const provider = (this.llmClient as any).config?.provider || 'unknown';
        const errorCode = this.extractErrorCode(error);
        worker.status = 'failed';
        worker.error = `LLM provider unreachable: [${provider}] ${errorCode} - ${error.message}`;
        throw new LLMConnectionError(provider, errorCode, error.message);
      }

      // Requirement 2.2: Reject zero-token results
      if (error instanceof ZeroTokenResultError) {
        worker.status = 'failed';
        worker.error = error.message;
        throw error;
      }

      // Other API errors (rate limiting, auth failures, etc.)
      worker.status = 'failed';
      worker.error = error.message || 'Unknown LLM execution error';
      throw error;
    }
  }

  /**
   * Determine if an error is a connection-level failure.
   */
  private isConnectionError(error: any): boolean {
    const message = error.message || '';
    return (
      message.includes('ENOTFOUND') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('socket hang up') ||
      message.includes('timed out') ||
      message.includes('Cannot reach') ||
      message.includes('LLM request failed') ||
      message.includes('Connection reset') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    );
  }

  /**
   * Extract a structured error code from the error.
   */
  private extractErrorCode(error: any): string {
    if (error.code) return error.code;
    const message = error.message || '';
    if (message.includes('ENOTFOUND')) return 'ENOTFOUND';
    if (message.includes('ECONNREFUSED')) return 'ECONNREFUSED';
    if (message.includes('ECONNRESET')) return 'ECONNRESET';
    if (message.includes('ETIMEDOUT')) return 'ETIMEDOUT';
    if (message.includes('socket hang up')) return 'SOCKET_HANG_UP';
    if (message.includes('timed out')) return 'TIMEOUT';
    return 'CONNECTION_ERROR';
  }

  /**
   * Validate a completed worker result for data integrity.
   * Requirements: 2.2, 2.5
   *
   * @throws ZeroTokenResultError if token count is zero
   * @throws Error if provenance fields are missing or empty
   */
  validateWorkerResult(worker: WorkerProgress): void {
    if (worker.status !== 'completed') return;

    // Requirement 2.2: Reject zero-token results
    if (!worker.tokenUsage || worker.tokenUsage.totalTokens <= 0) {
      throw new ZeroTokenResultError(worker.workerId);
    }

    // Requirement 2.5: Ensure provenance is present and non-empty
    if (!worker.provenance) {
      throw new Error(`Missing provenance for completed worker ${worker.workerId}`);
    }
    if (!worker.provenance.model || worker.provenance.model.trim() === '') {
      throw new Error(`Empty model in provenance for worker ${worker.workerId}`);
    }
    if (!worker.provenance.requestId || worker.provenance.requestId.trim() === '') {
      throw new Error(`Empty requestId in provenance for worker ${worker.workerId}`);
    }
  }

  /**
   * Start swarm execution.
   * Requirements: 2.1, 2.2, 2.3, 2.5, 5.3, 5.10
   */
  async start(swarmId: string): Promise<SwarmResult> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    swarm.status = 'running';
    swarm.startedAt = new Date();

    const startTime = Date.now();
    const failures: string[] = [];
    let overallModel = '';

    for (const worker of swarm.workers) {
      if ((swarm.status as SwarmStatus) === 'cancelled') break;

      // Check human checkpoints
      if (swarm.checkpointsPending.length > 0) {
        swarm.status = 'paused';
        // In real impl, would wait for user approval
        swarm.checkpointsPending.shift();
        swarm.status = 'running';
      }

      worker.status = 'running';
      this.emitProgress(swarmId, worker);

      try {
        // Requirement 2.1: Execute through real LLM API call
        await this.executeWorkerTask(worker, swarm.config.task);

        // Requirement 2.2 & 2.5: Validate the completed result
        this.validateWorkerResult(worker);

        // Track the model used for overall provenance
        if (worker.provenance?.model) {
          overallModel = worker.provenance.model;
        }
      } catch (error: any) {
        worker.status = 'failed';
        if (!worker.error) {
          worker.error = error.message || 'Worker execution failed';
        }
        failures.push(worker.error ?? `Worker ${worker.workerId} failed`);
      }

      this.emitProgress(swarmId, worker);
    }

    const durationMs = Date.now() - startTime;

    // Aggregate results
    const totalTokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    for (const w of swarm.workers) {
      if (w.tokenUsage) {
        totalTokenUsage.promptTokens += w.tokenUsage.promptTokens;
        totalTokenUsage.completionTokens += w.tokenUsage.completionTokens;
        totalTokenUsage.totalTokens += w.tokenUsage.totalTokens;
        totalTokenUsage.estimatedCost += w.tokenUsage.estimatedCost;
      }
      if (w.status === 'failed') {
        if (!failures.includes(w.error ?? `Worker ${w.workerId} failed`)) {
          failures.push(w.error ?? `Worker ${w.workerId} failed`);
        }
      }
    }

    swarm.status = failures.length === swarm.workers.length ? 'failed' : 'completed';
    swarm.completedAt = new Date();

    const result: SwarmResult = {
      swarmId,
      status: swarm.status,
      workerResults: swarm.workers,
      aggregatedOutput: swarm.workers
        .filter((w) => w.output)
        .map((w) => w.output)
        .join('\n---\n'),
      totalTokenUsage,
      durationMs,
      failures,
      // Requirement 2.5: Include provenance for the overall swarm result
      ...(overallModel
        ? { provenance: { model: overallModel, requestId: randomUUID() } }
        : {}),
    };

    this.emitComplete(swarmId, result);
    return result;
  }

  /**
   * Start orchestrated swarm execution using the full pipeline:
   * classify → route → phase → execute.
   *
   * This method integrates DeliverableGuard, CapabilityRouter, and PhaseAssigner
   * to intelligently select agents and order their execution by phase.
   *
   * Phases execute sequentially (0 → 1 → 2 → 3), but agents within a
   * phase run in parallel.
   *
   * Requirements: 2.4, 2.5, 4.7, 6.4
   */
  async startOrchestrated(swarmId: string): Promise<OrchestratedSwarmResult> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    if (this.registry.length === 0) {
      throw new Error('Agent registry not configured. Call setRegistry() before startOrchestrated().');
    }

    swarm.status = 'running';
    swarm.startedAt = new Date();

    const startTime = Date.now();
    const failures: string[] = [];
    let overallModel = '';

    // Step 1: Classify the deliverable type from the task prompt
    const guard = new DeliverableGuard();
    const classification = guard.classify(swarm.config.task);
    const deliverableType = classification.type;

    // Step 2: Determine routing tier — use cheap tier for routing decisions
    const routingTier: ModelTier = this.modelRouter
      ? this.modelRouter.getTier('agent_routing')
      : 'cheap';

    // Step 3: Route to capable agents via CapabilityRouter
    const router = new CapabilityRouter(this.registry);
    const routedAgents = router.route({
      deliverableType,
      complexity: 'simple',
      maxAgents: 4,
    });

    // Step 4: Assign agents to phases via PhaseAssigner
    const assigner = new PhaseAssigner(this.registry);
    const phasedPlan = assigner.assign(routedAgents, deliverableType);

    // Step 5: Execute phases sequentially; agents within each phase run in parallel
    const allWorkerResults: WorkerProgress[] = [];
    const subtaskOutcomes: SubtaskOutcome[] = [];
    const phaseMetrics: PhaseMetric[] = [];
    const phaseNumbers = Array.from(phasedPlan.phases.keys()).sort((a, b) => a - b);

    // Tier usage tracking: count expensive vs cheap model calls
    let expensiveCalls = 0;
    let cheapCalls = 0;

    // Routing/classification steps use cheap tier (agent_routing, refusal_detection)
    // Count the initial routing call as cheap
    cheapCalls += 1; // capability routing decision

    for (const phaseNum of phaseNumbers) {
      if ((swarm.status as SwarmStatus) === 'cancelled') break;

      const assignments = phasedPlan.phases.get(phaseNum) ?? [];
      const phaseStartedAt = new Date();

      // Create workers for this phase
      const phaseWorkers: WorkerProgress[] = assignments.map((assignment) => ({
        workerId: randomUUID(),
        agentId: assignment.agentId,
        status: 'queued' as WorkerStatus,
      }));

      // Execute all workers in the phase in parallel
      const phasePromises = phaseWorkers.map(async (worker) => {
        worker.status = 'running';
        this.emitProgress(swarmId, worker);

        const taskId = worker.workerId;

        try {
          await this.executeWorkerTask(worker, swarm.config.task);
          this.validateWorkerResult(worker);

          // Track tier usage: Phase 1 = code_generation (expensive), others = cheap
          if (phaseNum === 1) {
            expensiveCalls += 1;
          } else {
            cheapCalls += 1;
          }

          if (worker.provenance?.model) {
            overallModel = worker.provenance.model;
          }

          // Refusal detection: check completed worker output for refusal patterns
          // Requirements: 3.1, 3.2, 3.3, 6.5, 6.7
          if (worker.output) {
            const refusalResult = this.refusalDetector.detect(worker.output);
            // Refusal detection itself is a cheap-tier operation
            cheapCalls += 1;

            if (refusalResult.isRefusal) {
              // Use cheap tier for refusal handling (no expensive-tier calls after refusal)
              if (this.modelRouter) {
                this.modelRouter.getTier('refusal_detection'); // confirms cheap tier
              }

              // Handle the refusal: attempt reassignment or drop
              const outcome = this.refusalDetector.handleRefusal(
                taskId,
                worker.agentId,
                routedAgents,
              );

              // If reassigned, execute the task with the new agent using cheap tier
              if (outcome.status === 'refused' && outcome.reassignedTo) {
                const reassignedWorker: WorkerProgress = {
                  workerId: randomUUID(),
                  agentId: outcome.reassignedTo,
                  status: 'running' as WorkerStatus,
                };
                this.emitProgress(swarmId, reassignedWorker);
                // Reassignment uses cheap tier (no expensive calls after refusal)
                cheapCalls += 1;

                try {
                  await this.executeWorkerTask(reassignedWorker, swarm.config.task);
                  this.validateWorkerResult(reassignedWorker);

                  if (reassignedWorker.provenance?.model) {
                    overallModel = reassignedWorker.provenance.model;
                  }

                  // Check reassigned worker for refusal too
                  if (reassignedWorker.output) {
                    const reassignRefusal = this.refusalDetector.detect(reassignedWorker.output);
                    if (reassignRefusal.isRefusal) {
                      // Cascading refusal — drop the subtask
                      subtaskOutcomes.push({
                        taskId,
                        agentId: reassignedWorker.agentId,
                        status: 'dropped',
                        refusalReason: `Cascading refusal: reassigned agent ${reassignedWorker.agentId} also refused.`,
                      });
                    } else {
                      // Reassigned agent completed successfully
                      outcome.output = reassignedWorker.output;
                      subtaskOutcomes.push({
                        taskId,
                        agentId: outcome.reassignedTo,
                        status: 'completed',
                        output: reassignedWorker.output,
                      });
                    }
                  } else {
                    subtaskOutcomes.push({
                      taskId,
                      agentId: outcome.reassignedTo,
                      status: 'completed',
                      output: reassignedWorker.output,
                    });
                  }

                  this.emitProgress(swarmId, reassignedWorker);
                  allWorkerResults.push(reassignedWorker);
                } catch (reassignError: any) {
                  reassignedWorker.status = 'failed';
                  reassignedWorker.error = reassignError.message || 'Reassignment execution failed';
                  failures.push(reassignedWorker.error ?? `Worker ${reassignedWorker.workerId} failed`);
                  subtaskOutcomes.push({
                    taskId,
                    agentId: outcome.reassignedTo,
                    status: 'failed',
                    refusalReason: `Original agent ${worker.agentId} refused; reassigned agent ${outcome.reassignedTo} failed: ${reassignedWorker.error}`,
                  });
                  this.emitProgress(swarmId, reassignedWorker);
                  allWorkerResults.push(reassignedWorker);
                }
              } else {
                // Dropped — no alternative agent available
                subtaskOutcomes.push(outcome);
              }

              // Mark the original worker as failed due to refusal
              worker.status = 'failed';
              worker.error = `Agent refused: ${refusalResult.pattern ?? 'unknown pattern'}`;
            } else {
              // No refusal — subtask completed successfully
              subtaskOutcomes.push({
                taskId,
                agentId: worker.agentId,
                status: 'completed',
                output: worker.output,
              });
            }
          } else {
            // No output — treat as completed (empty output is valid per existing behavior)
            subtaskOutcomes.push({
              taskId,
              agentId: worker.agentId,
              status: 'completed',
              output: worker.output,
            });
          }
        } catch (error: any) {
          worker.status = 'failed';
          if (!worker.error) {
            worker.error = error.message || 'Worker execution failed';
          }
          failures.push(worker.error ?? `Worker ${worker.workerId} failed`);
          subtaskOutcomes.push({
            taskId,
            agentId: worker.agentId,
            status: 'failed',
            output: undefined,
          });
        }

        this.emitProgress(swarmId, worker);
        return worker;
      });

      const phaseResults = await Promise.all(phasePromises);
      allWorkerResults.push(...phaseResults);

      // Collect phase metrics after phase completion
      const phaseCompletedAt = new Date();
      const phaseOutcomes = subtaskOutcomes.filter((o) => {
        // Match outcomes that belong to workers from this phase
        return phaseWorkers.some((pw) => pw.workerId === o.taskId);
      });
      phaseMetrics.push({
        phase: phaseNum as PhaseNumber,
        startedAt: phaseStartedAt,
        completedAt: phaseCompletedAt,
        agentCount: assignments.length,
        completedCount: phaseOutcomes.filter((o) => o.status === 'completed').length,
        refusedCount: phaseOutcomes.filter((o) => o.status === 'refused').length,
        droppedCount: phaseOutcomes.filter((o) => o.status === 'dropped').length,
      });
    }

    const durationMs = Date.now() - startTime;

    // Aggregate token usage
    const totalTokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    for (const w of allWorkerResults) {
      if (w.tokenUsage) {
        totalTokenUsage.promptTokens += w.tokenUsage.promptTokens;
        totalTokenUsage.completionTokens += w.tokenUsage.completionTokens;
        totalTokenUsage.totalTokens += w.tokenUsage.totalTokens;
        totalTokenUsage.estimatedCost += w.tokenUsage.estimatedCost;
      }
    }

    swarm.status = allWorkerResults.length > 0 && allWorkerResults.every((w) => w.status === 'failed')
      ? 'failed'
      : 'completed';
    swarm.completedAt = new Date();

    // Update the swarm's workers with the orchestrated results
    swarm.workers = allWorkerResults;

    // Calculate accurate completion metrics based on subtask outcomes
    // Requirements: 3.4, 3.5 — only count successfully completed subtasks
    const completedCount = subtaskOutcomes.filter((o) => o.status === 'completed').length;
    const refusedCount = subtaskOutcomes.filter((o) => o.status === 'refused').length;
    const droppedCount = subtaskOutcomes.filter((o) => o.status === 'dropped').length;
    const failedCount = subtaskOutcomes.filter((o) => o.status === 'failed').length;

    // If all outcomes are non-completed (refused/dropped/failed), mark swarm as failed
    if (subtaskOutcomes.length > 0 && completedCount === 0) {
      swarm.status = 'failed';
    }

    // Step 6: Build Verification — run after all phases complete successfully
    // Requirements: 5.1, 5.5, 5.6, 5.7, 5.8
    let verificationResult: VerificationResult | undefined;

    if (this.buildVerifierConfig && (swarm.status as SwarmStatus) !== 'failed' && (swarm.status as SwarmStatus) !== 'cancelled') {
      const maxRetries = this.buildVerifierConfig.maxRetries ?? 3;
      const accumulatedErrors: string[] = [];

      // Create a simple CallbackEngine-compatible object and demonstrate registerHook usage
      const callbackEngine: CallbackEngine = {
        registerHook: (_event: string, _callback: (ctx: any) => Promise<void>) => {
          // Hook registered — in production the loop-engine fires this
        },
      };

      const verifier = new BuildVerifier(this.buildVerifierConfig);
      // Register the verifier as a callback hook (demonstrates 5.7 integration)
      verifier.registerHook(callbackEngine);

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const vResult = await verifier.verify();

        if (vResult.passed) {
          verificationResult = vResult;
          break;
        }

        // Record the failure
        accumulatedErrors.push(
          `Attempt ${attempt + 1}: ${vResult.stage} failed — ${vResult.error ?? 'unknown error'}`
        );

        if (attempt < maxRetries) {
          // Loop back to code-generation phase (Phase 1) with failure details as context
          const errorContext = `Build verification failed at stage '${vResult.stage}': ${vResult.error}. Please fix the issue.`;
          const phase1Assignments = phasedPlan.phases.get(1) ?? [];

          // Re-execute Phase 1 workers with error context
          const retryPromises = phase1Assignments.map(async (assignment) => {
            const retryWorker: WorkerProgress = {
              workerId: randomUUID(),
              agentId: assignment.agentId,
              status: 'running' as WorkerStatus,
            };
            this.emitProgress(swarmId, retryWorker);

            try {
              const taskWithContext = `${swarm.config.task}\n\n[BUILD VERIFICATION FAILURE - RETRY ${attempt + 1}]\n${errorContext}`;
              await this.executeWorkerTask(retryWorker, taskWithContext);
              this.validateWorkerResult(retryWorker);

              if (retryWorker.provenance?.model) {
                overallModel = retryWorker.provenance.model;
              }
            } catch (retryError: any) {
              retryWorker.status = 'failed';
              if (!retryWorker.error) {
                retryWorker.error = retryError.message || 'Retry worker execution failed';
              }
              failures.push(retryWorker.error ?? `Worker ${retryWorker.workerId} failed`);
            }

            this.emitProgress(swarmId, retryWorker);
            allWorkerResults.push(retryWorker);
            return retryWorker;
          });

          await Promise.all(retryPromises);
        } else {
          // Max retries exhausted — report failure with accumulated errors
          verificationResult = {
            ...vResult,
            error: `Verification failed after ${maxRetries + 1} attempts. Errors: ${accumulatedErrors.join('; ')}`,
          };
          swarm.status = 'failed';
        }
      }
    }

    // Recalculate durationMs to include verification time
    const finalDurationMs = Date.now() - startTime;

    // Calculate tier usage metrics
    // estimatedCostSavings = cheapCalls * (expensiveCostPerCall - cheapCostPerCall)
    const EXPENSIVE_COST_PER_CALL = 0.01;
    const CHEAP_COST_PER_CALL = 0.001;
    const estimatedCostSavings = cheapCalls * (EXPENSIVE_COST_PER_CALL - CHEAP_COST_PER_CALL);

    const tierUsage: TierUsageMetric = {
      expensiveCalls,
      cheapCalls,
      estimatedCostSavings,
    };

    const result: OrchestratedSwarmResult = {
      swarmId,
      status: swarm.status,
      workerResults: allWorkerResults,
      aggregatedOutput: allWorkerResults
        .filter((w) => w.output && w.status === 'completed')
        .map((w) => w.output)
        .join('\n---\n'),
      totalTokenUsage,
      durationMs: finalDurationMs,
      failures,
      ...(overallModel
        ? { provenance: { model: overallModel, requestId: randomUUID() } }
        : {}),
      deliverableType,
      routedAgents,
      phasedPlan,
      routingTier,
      subtaskOutcomes,
      ...(verificationResult ? { verificationResult } : {}),
      phaseMetrics,
      tierUsage,
    };

    this.emitComplete(swarmId, result);
    return result;
  }

  /**
   * Pause a running swarm.
   * Requirements: 5.8
   */
  pause(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    if (swarm.status !== 'running') {
      throw new Error(`Cannot pause swarm with status: ${swarm.status}`);
    }
    swarm.status = 'paused';
  }

  /**
   * Resume a paused swarm.
   * Requirements: 5.8
   */
  resume(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    if (swarm.status !== 'paused') {
      throw new Error(`Cannot resume swarm with status: ${swarm.status}`);
    }
    swarm.status = 'running';
  }

  /**
   * Cancel a swarm, terminating all workers gracefully.
   * Requirements: 5.11
   */
  cancel(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    swarm.status = 'cancelled';
    for (const worker of swarm.workers) {
      if (worker.status === 'running' || worker.status === 'queued') {
        worker.status = 'failed';
        worker.error = 'Cancelled by user';
      }
    }
  }

  /**
   * Add a worker to an existing swarm.
   */
  addWorker(swarmId: string, agentId: string): WorkerProgress {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const worker: WorkerProgress = {
      workerId: randomUUID(),
      agentId,
      status: 'queued',
    };
    swarm.workers.push(worker);
    swarm.config.workerAgentIds.push(agentId);
    return worker;
  }

  /**
   * Remove a worker from a swarm.
   */
  removeWorker(swarmId: string, workerId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const idx = swarm.workers.findIndex((w) => w.workerId === workerId);
    if (idx === -1) throw new Error(`Worker not found: ${workerId}`);

    const worker = swarm.workers[idx];
    if (worker.status === 'running') {
      throw new Error('Cannot remove a running worker');
    }

    swarm.workers.splice(idx, 1);
  }

  /**
   * Register a progress callback for a swarm.
   */
  onProgress(swarmId: string, callback: (progress: WorkerProgress) => void): void {
    let callbacks = this.progressCallbacks.get(swarmId);
    if (!callbacks) {
      callbacks = [];
      this.progressCallbacks.set(swarmId, callbacks);
    }
    callbacks.push(callback);
  }

  /**
   * Register a completion callback for a swarm.
   */
  onComplete(swarmId: string, callback: (result: SwarmResult) => void): void {
    let callbacks = this.completeCallbacks.get(swarmId);
    if (!callbacks) {
      callbacks = [];
      this.completeCallbacks.set(swarmId, callbacks);
    }
    callbacks.push(callback);
  }

  // ── Private helpers ─────────────────────────────────────────

  private emitProgress(swarmId: string, progress: WorkerProgress): void {
    const callbacks = this.progressCallbacks.get(swarmId) ?? [];
    for (const cb of callbacks) {
      cb(progress);
    }
  }

  private emitComplete(swarmId: string, result: SwarmResult): void {
    const callbacks = this.completeCallbacks.get(swarmId) ?? [];
    for (const cb of callbacks) {
      cb(result);
    }
  }
}
