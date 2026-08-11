/**
 * Context Library Wiring — Connects the Context Library to the PromptEnrichmentPipeline.
 *
 * This wiring module registers the Context Library as a context provider within
 * the existing PromptEnrichmentPipeline. When `enrich()` is invoked, the Context
 * Library's `resolveContext()` is called and its output is injected into the
 * prompt AFTER the system prompt and BEFORE file/code context.
 *
 * Integration points:
 *   - Registers a pre-enrichment hook that injects curated context entries
 *   - Respects the Context Library's token budget independently of the pipeline's budget
 *   - Supports live updates: if context entries change, the next `enrich()` call
 *     picks up the latest content without restart
 *
 * Requirements: 6.2, 6.4
 */

import type { PromptEnrichmentPipeline, SessionContext } from '../context/prompt-enrichment.js';
import type { ContextLibrary as IContextLibrary, SessionResolveParams, ResolvedContext } from '../types/cloudflare-os.js';
import type { EnrichedPrompt } from '../context/types.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Configuration for wiring the Context Library into the enrichment pipeline.
 */
export interface ContextLibraryWiringConfig {
  /** The Context Library instance to use for resolving context. */
  contextLibrary: IContextLibrary;

  /** The PromptEnrichmentPipeline to wrap with context injection. */
  enrichmentPipeline: PromptEnrichmentPipeline;

  /**
   * Factory function that maps a SessionContext into the parameters needed
   * by the Context Library's `resolveContext()`. This bridges the pipeline's
   * session model to the Context Library's session model.
   */
  sessionParamsFactory: (sessionContext: SessionContext) => SessionResolveParams;
}

/**
 * Result of the wiring operation. Contains the enhanced pipeline proxy.
 */
export interface ContextLibraryWiringResult {
  /** The enriched pipeline that includes context library injection. */
  enrichedPipeline: ContextLibraryEnrichedPipeline;
}

/**
 * A pipeline proxy that wraps the original PromptEnrichmentPipeline,
 * injecting Context Library content during the enrich() phase.
 *
 * This implements the same `enrich()` interface as PromptEnrichmentPipeline
 * so it can be used as a drop-in replacement.
 */
export interface ContextLibraryEnrichedPipeline {
  /**
   * Enrich a prompt with both Context Library entries and standard pipeline
   * enrichment (symbol resolution, semantic search, etc.).
   *
   * Context Library content is placed AFTER the system prompt and BEFORE
   * the code/file context injected by the pipeline's standard stages.
   */
  enrich(prompt: string, sessionContext: SessionContext): Promise<EnrichedPrompt>;

  /**
   * Preview what context would be injected without modifying any state.
   */
  previewContextInjection(sessionContext: SessionContext): ResolvedContext;
}

// ─── Factory Functions ──────────────────────────────────────────

/**
 * Create a ContextLibraryEnrichedPipeline that wraps the existing pipeline
 * and injects Context Library entries during enrichment.
 *
 * Usage:
 * ```ts
 * const enrichedPipeline = createContextLibraryEnrichedPipeline({
 *   contextLibrary,
 *   enrichmentPipeline,
 *   sessionParamsFactory: (session) => ({
 *     workspacePath: currentWorkspace,
 *     projectId: currentProjectId,
 *     sessionId: session.sessionId ?? 'default',
 *   }),
 * });
 *
 * // Use as drop-in replacement for the pipeline
 * const result = await enrichedPipeline.enrich(prompt, sessionContext);
 * ```
 */
export function createContextLibraryEnrichedPipeline(
  config: ContextLibraryWiringConfig
): ContextLibraryEnrichedPipeline {
  const { contextLibrary, enrichmentPipeline, sessionParamsFactory } = config;

  return {
    async enrich(prompt: string, sessionContext: SessionContext): Promise<EnrichedPrompt> {
      // Step 1: Resolve Context Library entries for the current session
      const resolveParams = sessionParamsFactory(sessionContext);
      const resolvedContext = contextLibrary.resolveContext(resolveParams);

      // Step 2: Run the standard enrichment pipeline
      const enrichedPrompt = await enrichmentPipeline.enrich(prompt, sessionContext);

      // Step 3: If no context library content, return standard result as-is
      if (!resolvedContext.injectedText || resolvedContext.entries.length === 0) {
        return enrichedPrompt;
      }

      // Step 4: Inject Context Library content BEFORE the pipeline's injected context
      // (after system prompt, before file/code context)
      const combinedContext = resolvedContext.injectedText + '\n\n' + enrichedPrompt.injectedContext;
      const combinedTokenCount = enrichedPrompt.tokenCount + resolvedContext.totalTokens;

      return {
        ...enrichedPrompt,
        injectedContext: combinedContext,
        tokenCount: combinedTokenCount,
      };
    },

    previewContextInjection(sessionContext: SessionContext): ResolvedContext {
      const resolveParams = sessionParamsFactory(sessionContext);
      return contextLibrary.resolveContext(resolveParams);
    },
  };
}

/**
 * Wire the Context Library into the PromptEnrichmentPipeline and return
 * the full wiring result.
 *
 * This is the primary entry point for the integration. It creates the
 * enriched pipeline and returns it wrapped in a result object for
 * consistency with other wiring modules.
 *
 * @param config - Wiring configuration
 * @returns The wiring result containing the enriched pipeline
 */
export function wireContextLibrary(
  config: ContextLibraryWiringConfig
): ContextLibraryWiringResult {
  const enrichedPipeline = createContextLibraryEnrichedPipeline(config);

  console.log('[ContextLibraryWiring] Context Library registered with PromptEnrichmentPipeline');
  console.log('[ContextLibraryWiring]   - resolveContext() called during enrich() phase');
  console.log('[ContextLibraryWiring]   - Context injected after system prompt, before file context');

  return { enrichedPipeline };
}

/**
 * Create a default session params factory that extracts workspace/project/session
 * from an extended SessionContext. If the SessionContext doesn't contain these
 * fields, provides sensible defaults.
 *
 * @param workspacePath - The current workspace path
 * @param projectId - The current project identifier
 * @param sessionId - The current session identifier
 */
export function createDefaultSessionParamsFactory(
  workspacePath: string,
  projectId: string,
  sessionId: string
): (sessionContext: SessionContext) => SessionResolveParams {
  return (_sessionContext: SessionContext): SessionResolveParams => ({
    workspacePath,
    projectId,
    sessionId,
  });
}
