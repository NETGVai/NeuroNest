/**
 * GCF Agent Integration — Bridge between GCF and the Agent Pipeline.
 *
 * Provides the glue layer that injects the GCF into agent execution context,
 * wires the Prompt Enrichment Pipeline into prompt assembly, wires the
 * Response Validator into response processing, and emits lifecycle events
 * on the CallbackEngine at each stage.
 *
 * Requirements: 9.2, 9.3, 12.1, 13.1
 */

import type { GCFCore } from './gcf-core.js';
import type { PromptEnrichmentPipeline, SessionContext } from './prompt-enrichment.js';
import type { ResponseValidator, FileTarget, CorrectionResult } from './response-validator.js';
import type { CallbackEngine, HookContext } from '../pipeline/callback-engine.js';
import type { ContextEntry, EnrichedPrompt, ValidationResult } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The execution context injected into an agent at the start of execution.
 * Provides the agent with read/write access to GCF context entries.
 */
export interface AgentGCFContext {
  /** Read context entries filtered by type, source, recency, or priority. */
  queryEntries: GCFCore['queryEntries'];
  /** Store agent-generated context (analysis, summaries, etc.). */
  storeAgentContext: GCFCore['storeAgentContext'];
  /** List all active context sources. */
  listSources: GCFCore['listSources'];
  /** Get aggregated context statistics. */
  getStats: GCFCore['getStats'];
  /** The project directory for the current session. */
  projectDir: string;
}

/**
 * Options for creating a GCFAgentIntegration instance.
 */
export interface GCFAgentIntegrationOptions {
  /** The GCF Core instance managing context lifecycle. */
  gcfCore: GCFCore;
  /** The prompt enrichment pipeline for augmenting prompts. */
  enrichmentPipeline: PromptEnrichmentPipeline;
  /** The response validator for checking LLM outputs. */
  responseValidator: ResponseValidator;
  /** The callback engine for emitting lifecycle events. */
  callbackEngine: CallbackEngine;
  /** Session identifier for the current agent session. */
  sessionId: string;
}

/**
 * Result of enriching a prompt through the GCF pipeline.
 */
export interface GCFEnrichmentResult {
  /** The enriched prompt with injected context. */
  enrichedPrompt: EnrichedPrompt;
  /** Active context entries that were considered during enrichment. */
  activeEntries: ContextEntry[];
}

/**
 * Result of validating a response through the GCF pipeline.
 */
export interface GCFValidationResult {
  /** The validation result from the Response Validator. */
  validation: ValidationResult;
  /** Self-correction result if validation triggered correction. */
  correction?: CorrectionResult;
  /** Whether the response was ultimately accepted (passed or best-effort). */
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// GCF Agent Integration
// ---------------------------------------------------------------------------

/**
 * Bridges the GCF into the agent pipeline.
 *
 * This class is instantiated once per agent session and provides methods
 * to inject context, enrich prompts, and validate responses — emitting
 * CallbackEngine lifecycle events at each stage.
 */
export class GCFAgentIntegration {
  private readonly gcfCore: GCFCore;
  private readonly enrichmentPipeline: PromptEnrichmentPipeline;
  private readonly responseValidator: ResponseValidator;
  private readonly callbackEngine: CallbackEngine;
  private readonly sessionId: string;
  private iteration = 0;

  constructor(options: GCFAgentIntegrationOptions) {
    this.gcfCore = options.gcfCore;
    this.enrichmentPipeline = options.enrichmentPipeline;
    this.responseValidator = options.responseValidator;
    this.callbackEngine = options.callbackEngine;
    this.sessionId = options.sessionId;
  }

  // -------------------------------------------------------------------------
  // Context Injection (Req 9.2)
  // -------------------------------------------------------------------------

  /**
   * Inject the GCF instance into an agent's execution context.
   *
   * Called when an agent begins execution to provide read/write access to
   * context entries. Emits a lifecycle event on the CallbackEngine.
   *
   * @returns The agent execution context with GCF access methods.
   */
  injectContext(): AgentGCFContext {
    // Emit lifecycle event: context injected into agent
    this.emitEvent('after-tool-call', {
      toolName: 'gcf:inject-context',
      output: { projectDir: this.gcfCore.projectDir },
    });

    return {
      queryEntries: this.gcfCore.queryEntries.bind(this.gcfCore),
      storeAgentContext: this.gcfCore.storeAgentContext.bind(this.gcfCore),
      listSources: this.gcfCore.listSources.bind(this.gcfCore),
      getStats: this.gcfCore.getStats.bind(this.gcfCore),
      projectDir: this.gcfCore.projectDir,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt Enrichment (Req 12.1)
  // -------------------------------------------------------------------------

  /**
   * Enrich a prompt before LLM submission.
   *
   * Runs the prompt through the Prompt Enrichment Pipeline, injecting
   * resolved symbols, type definitions, import maps, and recent edits.
   * Emits before/after lifecycle events on the CallbackEngine.
   *
   * @param prompt - The raw user prompt to enrich.
   * @param sessionContext - Session context (exchange count, token budget).
   * @returns The enriched prompt and active entries used.
   */
  async enrichPrompt(
    prompt: string,
    sessionContext: SessionContext,
  ): Promise<GCFEnrichmentResult> {
    this.iteration++;

    // Emit before-llm-call event to signal enrichment is starting
    await this.emitEvent('before-llm-call', {
      input: { prompt, sessionContext },
    });

    // Get active context entries
    const activeEntries = this.gcfCore.listSources();

    // Run through enrichment pipeline
    const enrichedPrompt = await this.enrichmentPipeline.enrich(prompt, sessionContext);

    // Emit after-tool-call event to signal enrichment is complete
    await this.emitEvent('after-tool-call', {
      toolName: 'gcf:enrich-prompt',
      input: { prompt },
      output: {
        resolvedSymbols: enrichedPrompt.resolvedSymbols,
        tokenCount: enrichedPrompt.tokenCount,
        durationMs: enrichedPrompt.durationMs,
      },
    });

    return {
      enrichedPrompt,
      activeEntries,
    };
  }

  // -------------------------------------------------------------------------
  // Response Validation (Req 13.1)
  // -------------------------------------------------------------------------

  /**
   * Validate a response after the LLM returns.
   *
   * Runs the response through the Response Validator (type-checking + linting).
   * If validation fails, initiates the self-correction loop. Emits lifecycle
   * events on the CallbackEngine at each stage.
   *
   * @param response - The raw LLM response text.
   * @param targetFiles - File targets extracted from the response.
   * @param originalPrompt - The original prompt for self-correction context.
   * @returns The validation result and whether the response was accepted.
   */
  async validateResponse(
    response: string,
    targetFiles: FileTarget[],
    originalPrompt?: string,
  ): Promise<GCFValidationResult> {
    // Emit event: validation starting
    await this.emitEvent('before-tool-call', {
      toolName: 'gcf:validate-response',
      input: { fileCount: targetFiles.length },
    });

    // Run validation
    const validation = await this.responseValidator.validate(response, targetFiles);

    let correction: CorrectionResult | undefined;
    let accepted = validation.passed;

    // If validation failed and we have the original prompt, attempt self-correction
    if (!validation.passed && originalPrompt && validation.status === 'errors_found') {
      // Emit event: self-correction starting
      await this.emitEvent('before-tool-call', {
        toolName: 'gcf:self-correct',
        input: {
          diagnosticCount: validation.diagnostics.length,
          errorCount: validation.diagnostics.filter((d) => d.severity === 'error').length,
        },
      });

      correction = await this.responseValidator.selfCorrect(
        originalPrompt,
        response,
        validation.diagnostics,
      );

      accepted = correction.passed;

      // Emit event: self-correction complete
      await this.emitEvent('after-tool-call', {
        toolName: 'gcf:self-correct',
        output: {
          passed: correction.passed,
          iterationsUsed: correction.iterationsUsed,
          remainingErrors: correction.diagnostics.filter((d) => d.severity === 'error').length,
        },
      });
    }

    // Emit event: validation complete
    await this.emitEvent('after-tool-call', {
      toolName: 'gcf:validate-response',
      output: {
        passed: validation.passed,
        accepted,
        status: validation.status,
        diagnosticCount: validation.diagnostics.length,
      },
    });

    // If validation failed (even after correction), emit an error event
    if (!accepted) {
      await this.emitEvent('on-error', {
        error: new Error(
          `Response validation failed: ${validation.diagnostics.filter((d) => d.severity === 'error').length} error(s) remaining`,
        ),
      });
    }

    return {
      validation,
      correction,
      accepted,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle Helpers
  // -------------------------------------------------------------------------

  /**
   * Set the current iteration number (used for CallbackEngine context).
   * Called by the agent loop on each iteration.
   */
  setIteration(iteration: number): void {
    this.iteration = iteration;
  }

  /**
   * Get the current iteration number.
   */
  getIteration(): number {
    return this.iteration;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Emit a lifecycle event on the CallbackEngine with proper context.
   */
  private async emitEvent(
    event: HookContext['event'],
    data: Partial<Omit<HookContext, 'event' | 'sessionId' | 'iteration'>>,
  ): Promise<void> {
    await this.callbackEngine.emit({
      event,
      sessionId: this.sessionId,
      iteration: this.iteration,
      ...data,
    });
  }
}
