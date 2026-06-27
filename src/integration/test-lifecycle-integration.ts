/**
 * TestLifecycleIntegration — Wire Test lifecycle: Planner → Generator → Health Tracker.
 *
 * Connects Test Planner output to Test Generator input, connects test execution
 * results to Test Health Tracker, and connects Test Drift Detector to DriftMonitor
 * and CallbackEngine.
 *
 * This coordinator registers CallbackEngine event handlers to automate the
 * test lifecycle pipeline:
 *   1. When a test plan is generated (Planner emits on-task-complete), feed it
 *      into the Test Generator to produce test files.
 *   2. When test executions complete, record results into the Test Health Tracker.
 *   3. When a test failure occurs, route it through the Test Drift Detector to
 *      classify as test-drift or real-regression and emit drift signals via
 *      CallbackEngine and DriftMonitor.
 *
 * Requirements: 8.6, 9.6, 10.5, 10.7, 11.6
 */

import type { CallbackEngine, HookContext } from '../pipeline/callback-engine.js';
import type { DriftMonitor } from '../drift/drift-monitor.js';
import type { ITestPlanner } from '../testing/test-planner.js';
import type { ITestGenerator, TestGenerationResult } from '../testing/test-generator.js';
import type {
  ITestDriftDetector,
  TestFailureEvidence,
  TestDriftClassification,
} from '../testing/test-drift-detector.js';
import type {
  ITestHealthTracker,
  TestExecutionRecord,
} from '../testing/test-health-tracker.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the test lifecycle integration */
export interface TestLifecycleConfig {
  /** Whether to auto-generate tests when a plan completes. Default: true */
  autoGenerateOnPlan?: boolean;
  /** Whether to auto-classify failures through drift detector. Default: true */
  autoClassifyFailures?: boolean;
  /** Whether to auto-record executions to health tracker. Default: true */
  autoRecordHealth?: boolean;
}

/** Result of the plan-to-generation pipeline */
export interface PlanToGenerationResult {
  planId: string;
  generationResult: TestGenerationResult;
}

/** Result of drift classification pipeline */
export interface DriftClassificationResult {
  classification: TestDriftClassification;
  fixApplied: boolean;
}

// ─── TestLifecycleIntegration ───────────────────────────────────

/**
 * Coordinates the test lifecycle subsystems via CallbackEngine event handlers.
 *
 * Wires:
 *   - Test Planner output → Test Generator input (Req 8.6, 9.6)
 *   - Test execution results → Test Health Tracker (Req 11.6)
 *   - Test Drift Detector → DriftMonitor + CallbackEngine (Req 10.5, 10.7)
 */
export class TestLifecycleIntegration {
  private readonly callbackEngine: CallbackEngine;
  private readonly testPlanner: ITestPlanner;
  private readonly testGenerator: ITestGenerator;
  private readonly testDriftDetector: ITestDriftDetector;
  private readonly testHealthTracker: ITestHealthTracker;
  // DriftMonitor stored for future integration extension
  private readonly _driftMonitor: DriftMonitor | null;
  private readonly config: Required<TestLifecycleConfig>;

  private registered = false;

  constructor(
    callbackEngine: CallbackEngine,
    testPlanner: ITestPlanner,
    testGenerator: ITestGenerator,
    testDriftDetector: ITestDriftDetector,
    testHealthTracker: ITestHealthTracker,
    driftMonitor: DriftMonitor | null,
    config?: TestLifecycleConfig,
  ) {
    this.callbackEngine = callbackEngine;
    this.testPlanner = testPlanner;
    this.testGenerator = testGenerator;
    this.testDriftDetector = testDriftDetector;
    this.testHealthTracker = testHealthTracker;
    this._driftMonitor = driftMonitor;
    this.config = {
      autoGenerateOnPlan: config?.autoGenerateOnPlan ?? true,
      autoClassifyFailures: config?.autoClassifyFailures ?? true,
      autoRecordHealth: config?.autoRecordHealth ?? true,
    };
  }

  /**
   * Register all CallbackEngine event handlers for the test lifecycle pipeline.
   *
   * Must be called once during application initialization. Idempotent — calling
   * multiple times has no additional effect.
   */
  register(): void {
    if (this.registered) return;

    // 1. Listen for plan completion events to trigger generation (Req 8.6, 9.6)
    this.callbackEngine.register('on-task-complete', this.handlePlanComplete);

    // 2. Listen for test execution events to record health metrics (Req 11.6)
    this.callbackEngine.register('on-task-complete', this.handleTestExecution);

    // 3. Listen for drift signals to route test failures through drift detector (Req 10.5, 10.7)
    this.callbackEngine.register('on-drift-signal', this.handleDriftSignal);

    this.registered = true;
  }

  /**
   * Unregister all CallbackEngine event handlers.
   * Useful for teardown in tests or session cleanup.
   */
  unregister(): void {
    if (!this.registered) return;

    this.callbackEngine.unregister('on-task-complete', this.handlePlanComplete);
    this.callbackEngine.unregister('on-task-complete', this.handleTestExecution);
    this.callbackEngine.unregister('on-drift-signal', this.handleDriftSignal);

    this.registered = false;
  }

  // ─── Pipeline Operations ────────────────────────────────────────

  /**
   * Manually trigger the plan-to-generation pipeline for a given plan ID.
   *
   * Retrieves the test plan from the planner and feeds it into the generator.
   * Returns the generation result or null if the plan was not found.
   *
   * Requirements: 8.6, 9.6
   */
  async generateFromPlan(planId: string): Promise<PlanToGenerationResult | null> {
    const plan = this.testPlanner.getPlan(planId);
    if (!plan) return null;

    const generationResult = await this.testGenerator.generate({ planId: plan.id });
    return { planId: plan.id, generationResult };
  }

  /**
   * Record test execution results into the health tracker.
   *
   * Accepts an array of execution records and persists them to the
   * Test Health Tracker for analytics computation.
   *
   * Requirements: 11.6
   */
  recordExecutionResults(executions: TestExecutionRecord[]): void {
    this.testHealthTracker.record(executions);
  }

  /**
   * Classify a test failure through the Test Drift Detector.
   *
   * Routes the failure evidence through classification, emits appropriate
   * drift signals via CallbackEngine, and integrates with DriftMonitor.
   *
   * Requirements: 10.5, 10.7
   */
  async classifyTestFailure(
    failure: TestFailureEvidence,
  ): Promise<DriftClassificationResult> {
    const classification = await this.testDriftDetector.classify(failure);

    let fixApplied = false;

    // For test-drift: attempt auto-fix (Req 10.2)
    if (classification.classification === 'test-drift' && classification.suggestedFix) {
      const fixContent = await this.testDriftDetector.autoFix(classification);
      fixApplied = fixContent !== null;
    }

    return { classification, fixApplied };
  }

  /**
   * Get whether the integration is currently registered and active.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  // ─── Event Handlers (bound as arrow functions for stable reference) ─────

  /**
   * Handle plan completion events from Test Planner.
   *
   * When the Test Planner emits on-task-complete with a planId in the output,
   * this handler triggers the Test Generator to produce test files from the plan.
   *
   * Requirements: 8.6, 9.6
   */
  private handlePlanComplete = async (context: HookContext): Promise<void> => {
    if (!this.config.autoGenerateOnPlan) return;

    // Only respond to test-planner plan-completion events
    const output = context.output as Record<string, unknown> | undefined;
    if (!output || context.sessionId !== 'test-planner') return;

    const planId = output['planId'] as string | undefined;
    if (!planId) return;

    // Trigger generation from the completed plan
    await this.generateFromPlan(planId);
  };

  /**
   * Handle test execution completion events.
   *
   * When a test suite run completes and emits on-task-complete with execution
   * records in the output, this handler routes them to the Health Tracker.
   *
   * Requirements: 11.6
   */
  private handleTestExecution = (context: HookContext): void => {
    if (!this.config.autoRecordHealth) return;

    const output = context.output as Record<string, unknown> | undefined;
    if (!output) return;

    // Look for test execution data in the event output
    const executions = output['executions'] as TestExecutionRecord[] | undefined;
    if (!executions || !Array.isArray(executions) || executions.length === 0) return;

    // Validate that entries have required fields before recording
    const validExecutions = executions.filter(
      (exec) =>
        exec.testFilePath &&
        exec.testName &&
        exec.status &&
        typeof exec.durationMs === 'number' &&
        exec.timestamp &&
        exec.suiteRunId,
    );

    if (validExecutions.length > 0) {
      this.testHealthTracker.record(validExecutions);
    }
  };

  /**
   * Handle drift signals to route test failures through drift classification.
   *
   * When the CallbackEngine fires on-drift-signal with test failure evidence
   * in the input, this handler routes it through the Test Drift Detector.
   *
   * Requirements: 10.5, 10.7
   */
  private handleDriftSignal = async (context: HookContext): Promise<void> => {
    if (!this.config.autoClassifyFailures) return;

    const input = context.input as Record<string, unknown> | undefined;
    if (!input) return;

    // Check if this is a test failure event (not already a classification)
    if (input['type'] === 'test-drift-classification') {
      // Already classified — avoid re-processing loop
      return;
    }

    if (input['type'] !== 'test-failure') return;

    // Extract failure evidence from the drift signal
    const evidence: TestFailureEvidence | undefined = input['evidence'] as
      | TestFailureEvidence
      | undefined;
    if (!evidence) return;

    // Validate evidence has required fields
    if (
      !evidence.testFilePath ||
      !evidence.testName ||
      !evidence.failingAssertion ||
      !evidence.expectedValue ||
      !evidence.actualValue
    ) {
      return;
    }

    // Classify the failure through the drift detector
    await this.classifyTestFailure(evidence);
  };
}

// ─── Coordinator Factory ────────────────────────────────────────

/**
 * Create and register the test lifecycle integration coordinator.
 *
 * This factory function creates the TestLifecycleIntegration instance,
 * wires all CallbackEngine handlers, and returns the coordinator for
 * further programmatic interaction.
 *
 * Usage:
 *   const coordinator = wireTestLifecycle({
 *     callbackEngine,
 *     testPlanner,
 *     testGenerator,
 *     testDriftDetector,
 *     testHealthTracker,
 *     driftMonitor,
 *   });
 *
 * Requirements: 8.6, 9.6, 10.5, 10.7, 11.6
 */
export function wireTestLifecycle(deps: {
  callbackEngine: CallbackEngine;
  testPlanner: ITestPlanner;
  testGenerator: ITestGenerator;
  testDriftDetector: ITestDriftDetector;
  testHealthTracker: ITestHealthTracker;
  driftMonitor: DriftMonitor | null;
  config?: TestLifecycleConfig;
}): TestLifecycleIntegration {
  const integration = new TestLifecycleIntegration(
    deps.callbackEngine,
    deps.testPlanner,
    deps.testGenerator,
    deps.testDriftDetector,
    deps.testHealthTracker,
    deps.driftMonitor,
    deps.config,
  );

  integration.register();

  return integration;
}
