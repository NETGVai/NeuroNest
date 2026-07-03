/**
 * SpecHandoff — Bridges the spec-interview-engine to the existing execution pipeline.
 *
 * On "Start build" (spec:action IPC with action='build'), this module:
 *   1. Transitions the SynthesizedSpec to 'executing' state
 *   2. Passes the spec to the ExecutionModeRouter with suggestedMode
 *   3. Extracts the implementationPlan as the orchestrator planner's seed input
 *   4. Attaches acceptanceCriteria to the orchestrator's verification step
 *
 * Does NOT modify ExecutionModeRouter's four modes (flash, standard, pro, ultra)
 * or SwarmCoordinator behavior.
 *
 * If handoff fails: spec remains in 'executing' state, failure is logged for diagnosis.
 *
 * Listens for `spec:action` IPC channel with action 'build' from the SpecReviewCard.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { ExecutionModeRouter } from './execution-mode-router.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  SynthesizedSpec,
  AcceptanceCriterion,
  ImplementationStep,
  ExecutionMode,
} from './spec-interview-engine.js';

// ─── IPC Channel Constants ──────────────────────────────────────

export const IPC_CHANNELS = {
  /** Renderer → Main: user acts on a spec/review card */
  SPEC_ACTION: 'spec:action',
  /** Main → Renderer: spec review data */
  SPEC_REVIEW: 'spec:review',
} as const;

// ─── Types ──────────────────────────────────────────────────────

export interface SpecActionPayload {
  specId: string;
  action: 'build' | 'edit' | 'cancel';
}

export interface HandoffResult {
  success: boolean;
  specId: string;
  mode: ExecutionMode;
  taskDescription: string;
  error?: string;
}

export interface HandoffFailure {
  specId: string;
  error: string;
  timestamp: number;
}

/**
 * Verification context attached to orchestration for spec acceptance criteria.
 * Requirement 11.3: acceptance criteria attached to the verification step.
 */
export interface VerificationContext {
  specId: string;
  acceptanceCriteria: AcceptanceCriterion[];
}

/**
 * Planner seed input containing the implementation plan.
 * Requirement 11.2: orchestrator planner receives implementation plan as seed input.
 */
export interface PlannerSeedInput {
  specId: string;
  title: string;
  overview: string;
  implementationPlan: ImplementationStep[];
  filesToChange: string[];
  testingStrategy: string;
}

/**
 * Logger interface for handoff failure diagnostics.
 */
export interface HandoffLogger {
  error(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/**
 * Callback for attaching verification context to the orchestrator's verification step.
 */
export type AttachVerificationCallback = (context: VerificationContext) => void;

/**
 * Callback for providing planner seed input to the orchestrator planner.
 */
export type PlannerSeedCallback = (seed: PlannerSeedInput) => void;

// ─── Default Logger ─────────────────────────────────────────────

const defaultLogger: HandoffLogger = {
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[SpecHandoff] ${message}`, context ?? '');
  },
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[SpecHandoff] ${message}`, context ?? '');
  },
};

// ─── SpecHandoff Dependencies ───────────────────────────────────

export interface SpecHandoffDeps {
  /** Reference to the main BrowserWindow for sending IPC */
  mainWindow: BrowserWindow;
  /** The ExecutionModeRouter instance */
  executionModeRouter: ExecutionModeRouter;
  /** Feature gate system for checking flags */
  featureGate: FeatureGateSystem;
  /** Optional logger for diagnostics */
  logger?: HandoffLogger;
  /** Callback to attach acceptance criteria to orchestration verification step */
  onAttachVerification?: AttachVerificationCallback;
  /** Callback to provide implementation plan as planner seed input */
  onPlannerSeed?: PlannerSeedCallback;
  /** Lookup function to retrieve a SynthesizedSpec by ID */
  getSpec: (specId: string) => SynthesizedSpec | null;
  /** Update function to transition spec status */
  updateSpecStatus: (specId: string, status: SynthesizedSpec['status']) => void;
}

// ─── SpecHandoff Class ──────────────────────────────────────────

export class SpecHandoff {
  private readonly deps: SpecHandoffDeps;
  private readonly logger: HandoffLogger;
  private readonly failures: HandoffFailure[] = [];

  constructor(deps: SpecHandoffDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? defaultLogger;
  }

  /**
   * Execute the handoff from synthesized spec to orchestration pipeline.
   *
   * Flow:
   *   1. Transition spec to 'executing' state
   *   2. Set the ExecutionModeRouter to the spec's suggestedMode
   *   3. Extract implementationPlan as planner seed input (Req 11.2)
   *   4. Attach acceptanceCriteria to verification step (Req 11.3)
   *   5. Execute the task via ExecutionModeRouter (Req 11.1)
   *
   * On failure: spec stays in 'executing' state, error logged (Req 11.1).
   * Does NOT modify ExecutionModeRouter's four modes or SwarmCoordinator (Req 11.4).
   *
   * Requirements: 11.1, 11.2, 11.3, 11.4
   */
  async handoff(spec: SynthesizedSpec, sessionId: string): Promise<HandoffResult> {
    // Step 1: Transition to 'executing' state
    this.deps.updateSpecStatus(spec.id, 'executing');
    spec.status = 'executing';

    this.logger.info('Starting handoff to orchestration', {
      specId: spec.id,
      mode: spec.suggestedMode,
      planSteps: spec.implementationPlan.length,
    });

    try {
      // Step 2: Set execution mode — uses the spec's suggested mode
      // Does NOT add new modes or modify existing four modes (Req 11.4)
      this.deps.executionModeRouter.setMode(spec.suggestedMode);

      // Step 3: Extract and provide implementation plan as planner seed input (Req 11.2)
      const plannerSeed: PlannerSeedInput = {
        specId: spec.id,
        title: spec.title,
        overview: spec.overview,
        implementationPlan: spec.implementationPlan,
        filesToChange: spec.filesToChange,
        testingStrategy: spec.testingStrategy,
      };

      if (this.deps.onPlannerSeed) {
        this.deps.onPlannerSeed(plannerSeed);
      }

      // Step 4: Attach acceptance criteria to verification step (Req 11.3)
      const verificationContext: VerificationContext = {
        specId: spec.id,
        acceptanceCriteria: spec.acceptanceCriteria,
      };

      if (this.deps.onAttachVerification) {
        this.deps.onAttachVerification(verificationContext);
      }

      // Step 5: Build the task description from the implementation plan
      const taskDescription = this.buildTaskDescription(spec);

      // Step 6: Execute via ExecutionModeRouter (Req 11.1)
      await this.deps.executionModeRouter.execute(taskDescription, sessionId);

      this.logger.info('Handoff completed successfully', {
        specId: spec.id,
        mode: spec.suggestedMode,
      });

      return {
        success: true,
        specId: spec.id,
        mode: spec.suggestedMode,
        taskDescription,
      };
    } catch (error) {
      // On failure: spec remains in 'executing' state, log failure for diagnosis (Req 11.1)
      const errorMessage = error instanceof Error ? error.message : String(error);

      const failure: HandoffFailure = {
        specId: spec.id,
        error: errorMessage,
        timestamp: Date.now(),
      };
      this.failures.push(failure);

      this.logger.error('Handoff to orchestration failed', {
        specId: spec.id,
        mode: spec.suggestedMode,
        error: errorMessage,
      });

      return {
        success: false,
        specId: spec.id,
        mode: spec.suggestedMode,
        taskDescription: '',
        error: errorMessage,
      };
    }
  }

  /**
   * Get recorded handoff failures for diagnostics.
   */
  getFailures(): ReadonlyArray<HandoffFailure> {
    return this.failures;
  }

  /**
   * Clear recorded failures.
   */
  clearFailures(): void {
    this.failures.length = 0;
  }

  /**
   * Build a task description from the spec's implementation plan for the ExecutionModeRouter.
   * Combines the spec overview with ordered implementation steps.
   */
  private buildTaskDescription(spec: SynthesizedSpec): string {
    const lines: string[] = [
      `# ${spec.title}`,
      '',
      spec.overview,
      '',
      '## Implementation Plan',
    ];

    for (const step of spec.implementationPlan) {
      const filesStr = step.files.length > 0 ? ` (${step.files.join(', ')})` : '';
      lines.push(`${step.order}. ${step.description}${filesStr}`);
    }

    if (spec.filesToChange.length > 0) {
      lines.push('');
      lines.push('## Files to Change');
      for (const file of spec.filesToChange) {
        lines.push(`- ${file}`);
      }
    }

    if (spec.testingStrategy) {
      lines.push('');
      lines.push('## Testing Strategy');
      lines.push(spec.testingStrategy);
    }

    return lines.join('\n');
  }
}

// ─── IPC Registration ───────────────────────────────────────────

/**
 * Register the `spec:action` IPC handler for the "Start build" handoff.
 *
 * Listens for `spec:action` from the renderer (SpecReviewCard / InlineConfirmationCard).
 * When action is 'build':
 *   1. Retrieves the spec by ID
 *   2. Validates spec completeness
 *   3. Calls SpecHandoff.handoff() to bridge to ExecutionModeRouter
 *
 * Uses `ipcMain.on` (fire-and-forget) matching the existing renderer send pattern.
 *
 * Requirements: 11.1, 11.2, 11.3
 */
export function registerSpecHandoffIPC(
  specHandoff: SpecHandoff,
  deps: Pick<SpecHandoffDeps, 'featureGate' | 'getSpec'>,
  sessionId: string,
): void {
  ipcMain.on(IPC_CHANNELS.SPEC_ACTION, async (_event, payload: SpecActionPayload) => {
    // Gate behind `spec_review_card` feature flag
    if (!deps.featureGate.isEnabled('spec_review_card')) {
      return;
    }

    // Only handle 'build' action for handoff
    if (!payload || payload.action !== 'build' || !payload.specId) {
      return;
    }

    const spec = deps.getSpec(payload.specId);
    if (!spec) {
      (specHandoff as any).logger?.error('Spec not found for handoff', { specId: payload.specId });
      return;
    }

    // Execute the handoff
    await specHandoff.handoff(spec, sessionId);
  });
}
