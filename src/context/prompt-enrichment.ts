/**
 * Prompt Enrichment Pipeline — Multi-stage prompt augmentation.
 *
 * Analyzes a user's prompt to identify referenced symbols, file paths, and
 * concepts. Resolves symbols via AST Analyzer, retrieves relevant snippets from
 * the Semantic Search Index, injects type definitions, function signatures, and
 * import maps, and appends recent edit history for multi-turn conversations.
 *
 * Enrichment stages:
 *   1. Parse prompt for symbol references and file paths
 *   2. Resolve symbols via AST Analyzer (inject signatures/types)
 *   3. Retrieve semantically relevant snippets
 *   4. Include import maps for explicitly mentioned files
 *   5. Append recent edit history (multi-turn only)
 *   6. Deduplicate injected context
 *   7. Enforce token budget with Code_Graph proximity pruning
 *
 * Performance target: ≤200ms for up to 20 symbols.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */

import type { EnrichedPrompt, SymbolInfo } from './types.js';
import type { ASTAnalyzer } from './ast-analyzer.js';
import type { SemanticSearchIndex } from './semantic-search.js';
import type { EditHistoryTracker } from './edit-history.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Approximate characters per token (consistent with context-window-optimizer). */
const CHARS_PER_TOKEN = 4;

/** Default token budget ratio for injected context (30% of available window). */
const DEFAULT_TOKEN_BUDGET_RATIO = 0.3;

/** Maximum number of recent edits to include for multi-turn conversations. */
const MAX_RECENT_EDITS = 5;

/** Threshold of prior exchanges before edit history is included. */
const MULTI_TURN_THRESHOLD = 1;

/** Maximum semantic search results to retrieve. */
const SEMANTIC_SEARCH_TOP_K = 10;

/** Minimum similarity threshold for semantic search results. */
const SEMANTIC_SEARCH_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Session Context Interface
// ---------------------------------------------------------------------------

/**
 * Information about the current session for enrichment decisions.
 */
export interface SessionContext {
  /** Number of prior exchanges in the conversation (0 = first message). */
  exchangeCount: number;
  /** Total token budget available for the entire context window. */
  tokenBudget: number;
}

// ---------------------------------------------------------------------------
// Prompt Enrichment Pipeline
// ---------------------------------------------------------------------------

export class PromptEnrichmentPipeline {
  private readonly astAnalyzer: ASTAnalyzer;
  private readonly searchIndex: SemanticSearchIndex;
  private readonly editHistory: EditHistoryTracker;
  private readonly tokenBudgetRatio: number;

  constructor(options: {
    astAnalyzer: ASTAnalyzer;
    searchIndex: SemanticSearchIndex;
    editHistory: EditHistoryTracker;
    tokenBudgetRatio: number;
  }) {
    this.astAnalyzer = options.astAnalyzer;
    this.searchIndex = options.searchIndex;
    this.editHistory = options.editHistory;
    this.tokenBudgetRatio = options.tokenBudgetRatio ?? DEFAULT_TOKEN_BUDGET_RATIO;
  }

  /**
   * Enrich a user prompt with relevant context from the codebase.
   *
   * Performs symbol resolution, semantic search, import map injection,
   * edit history inclusion, deduplication, and token budget enforcement.
   */
  async enrich(prompt: string, sessionContext: SessionContext): Promise<EnrichedPrompt> {
    const startTime = performance.now();

    // Stage 1: Parse prompt for symbol references and file paths
    const { symbols: referencedSymbols, filePaths: referencedFiles } = this.parsePrompt(prompt);

    // Stage 2: Resolve symbols via AST Analyzer
    const resolvedSymbols = this.resolveSymbols(referencedSymbols);

    // Stage 3: Retrieve semantically relevant snippets
    const semanticSnippets = await this.searchIndex.search(
      prompt,
      SEMANTIC_SEARCH_TOP_K,
      SEMANTIC_SEARCH_THRESHOLD,
    );

    // Stage 4: Build import maps for explicitly mentioned files
    const importMaps = this.buildImportMaps(referencedFiles);

    // Stage 5: Include recent edit history for multi-turn conversations
    const recentEdits = this.getRecentEdits(sessionContext);

    // Stage 6: Deduplicate injected context
    const deduplicatedContext = this.deduplicateContext(
      resolvedSymbols,
      semanticSnippets.map((s) => s.symbol),
    );

    // Stage 7: Enforce token budget with Code_Graph proximity pruning
    const maxTokens = Math.floor(sessionContext.tokenBudget * this.tokenBudgetRatio);
    const prunedContext = this.enforceTokenBudget(
      deduplicatedContext,
      referencedSymbols,
      maxTokens,
    );

    // Assemble final enriched context
    const injectedParts: string[] = [];

    // Add resolved symbol signatures/types
    if (prunedContext.length > 0) {
      injectedParts.push('// Resolved symbols:');
      for (const sym of prunedContext) {
        injectedParts.push(sym.signature);
      }
    }

    // Add import maps
    if (importMaps.length > 0) {
      injectedParts.push('');
      injectedParts.push('// Import maps:');
      for (const map of importMaps) {
        injectedParts.push(map);
      }
    }

    // Add recent edits
    if (recentEdits.length > 0) {
      injectedParts.push('');
      injectedParts.push('// Recent edits:');
      for (const edit of recentEdits) {
        injectedParts.push(edit);
      }
    }

    const injectedContext = injectedParts.join('\n');
    const tokenCount = Math.ceil(injectedContext.length / CHARS_PER_TOKEN);
    const durationMs = performance.now() - startTime;

    return {
      originalPrompt: prompt,
      injectedContext,
      resolvedSymbols: prunedContext.map((s) => s.name),
      importMaps,
      recentEdits,
      tokenCount,
      durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 1: Prompt Parsing
  // -------------------------------------------------------------------------

  /**
   * Parse the prompt text to identify referenced symbols and file paths.
   *
   * Recognizes:
   * - PascalCase identifiers (likely class/interface/type names)
   * - camelCase identifiers (likely function/variable names)
   * - File path patterns (relative or absolute paths with extensions)
   * - Backtick-quoted code identifiers
   */
  parsePrompt(prompt: string): { symbols: string[]; filePaths: string[] } {
    const symbols = new Set<string>();
    const filePaths = new Set<string>();

    // Extract backtick-quoted identifiers (highest confidence)
    const backtickPattern = /`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickPattern.exec(prompt)) !== null) {
      const identifier = match[1]!;
      // If it contains dots, split and add parts
      if (identifier.includes('.')) {
        for (const part of identifier.split('.')) {
          if (this.isLikelySymbol(part)) {
            symbols.add(part);
          }
        }
      } else if (this.isLikelySymbol(identifier)) {
        symbols.add(identifier);
      }
    }

    // Extract file paths (patterns like ./path/to/file.ts or src/file.js)
    const filePathPattern = /(?:^|\s|["'`(])([./]?(?:[\w-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json))(?:\s|["'`)]|$)/g;
    while ((match = filePathPattern.exec(prompt)) !== null) {
      filePaths.add(match[1]!);
    }

    // Extract PascalCase identifiers (likely types/classes/interfaces)
    const pascalPattern = /\b([A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]*)*)\b/g;
    while ((match = pascalPattern.exec(prompt)) !== null) {
      const name = match[1]!;
      // Filter out common English words that happen to be PascalCase
      if (this.isLikelySymbol(name) && !this.isCommonWord(name)) {
        symbols.add(name);
      }
    }

    // Extract camelCase identifiers (likely functions/variables)
    const camelPattern = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
    while ((match = camelPattern.exec(prompt)) !== null) {
      const name = match[1]!;
      if (this.isLikelySymbol(name)) {
        symbols.add(name);
      }
    }

    return {
      symbols: [...symbols],
      filePaths: [...filePaths],
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: Symbol Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve identified symbols via the AST Analyzer.
   * Returns SymbolInfo for each symbol found in the Code_Graph.
   */
  private resolveSymbols(symbolNames: string[]): SymbolInfo[] {
    const resolved: SymbolInfo[] = [];

    for (const name of symbolNames) {
      const symbol = this.astAnalyzer.getSymbol(name);
      if (symbol) {
        resolved.push(symbol);
      }
    }

    return resolved;
  }

  // -------------------------------------------------------------------------
  // Stage 4: Import Map Building
  // -------------------------------------------------------------------------

  /**
   * Build import maps for explicitly mentioned files.
   * Uses the AST Analyzer's code graph to find import relationships.
   */
  private buildImportMaps(filePaths: string[]): string[] {
    const importMaps: string[] = [];
    const codeGraph = this.astAnalyzer.getCodeGraph();

    for (const filePath of filePaths) {
      // Find all symbols in this file
      const fileSymbols: string[] = [];
      for (const [name, symbol] of codeGraph.nodes) {
        if (symbol.filePath === filePath || symbol.filePath.endsWith(filePath)) {
          fileSymbols.push(name);
        }
      }

      // For each symbol in the file, collect its imports
      const fileImports = new Set<string>();
      for (const symbolName of fileSymbols) {
        const edges = codeGraph.edges.get(symbolName);
        if (edges) {
          for (const imp of edges.imports) {
            const impSymbol = codeGraph.nodes.get(imp);
            if (impSymbol) {
              fileImports.add(`import { ${imp} } from '${impSymbol.filePath}'`);
            }
          }
        }
      }

      if (fileImports.size > 0) {
        importMaps.push(`// ${filePath}:`);
        for (const imp of fileImports) {
          importMaps.push(`  ${imp}`);
        }
      }
    }

    return importMaps;
  }

  // -------------------------------------------------------------------------
  // Stage 5: Edit History
  // -------------------------------------------------------------------------

  /**
   * Get recent edits for multi-turn conversations.
   * Only includes edits when the conversation has more than 1 prior exchange.
   */
  private getRecentEdits(sessionContext: SessionContext): string[] {
    if (sessionContext.exchangeCount <= MULTI_TURN_THRESHOLD) {
      return [];
    }

    const edits = this.editHistory.getRecentEdits({ limit: MAX_RECENT_EDITS });
    return edits.map((edit) => {
      const revertedMarker = edit.reverted ? ' [REVERTED]' : '';
      return `${edit.filePath} (${edit.actor})${revertedMarker}: ${this.summarizeDiff(edit.diff)}`;
    });
  }

  /**
   * Produce a brief one-line summary of a diff.
   */
  private summarizeDiff(diff: string): string {
    const lines = diff.split('\n');
    const additions = lines.filter((l) => l.startsWith('+')).length;
    const deletions = lines.filter((l) => l.startsWith('-')).length;
    return `+${additions}/-${deletions} lines`;
  }

  // -------------------------------------------------------------------------
  // Stage 6: Deduplication
  // -------------------------------------------------------------------------

  /**
   * Deduplicate symbols so each signature/type is included only once.
   * Merges resolved symbols with semantic search results.
   */
  private deduplicateContext(
    resolvedSymbols: SymbolInfo[],
    semanticSymbols: SymbolInfo[],
  ): SymbolInfo[] {
    const seen = new Map<string, SymbolInfo>();

    // Resolved symbols take priority (directly referenced in prompt)
    for (const sym of resolvedSymbols) {
      if (!seen.has(sym.name)) {
        seen.set(sym.name, sym);
      }
    }

    // Add semantic search results that aren't already included
    for (const sym of semanticSymbols) {
      if (!seen.has(sym.name)) {
        seen.set(sym.name, sym);
      }
    }

    return [...seen.values()];
  }

  // -------------------------------------------------------------------------
  // Stage 7: Token Budget Enforcement
  // -------------------------------------------------------------------------

  /**
   * Enforce the token budget by pruning symbols based on Code_Graph proximity.
   * When the total injected context exceeds the budget, discard the most distant
   * symbols (those with fewest edges connecting them to referenced symbols).
   */
  private enforceTokenBudget(
    symbols: SymbolInfo[],
    referencedSymbolNames: string[],
    maxTokens: number,
  ): SymbolInfo[] {
    // Calculate current token usage
    let currentTokens = this.estimateTokens(symbols);

    if (currentTokens <= maxTokens) {
      return symbols;
    }

    // Score each symbol by proximity to referenced symbols in the Code_Graph
    const proximityScores = this.computeProximityScores(symbols, referencedSymbolNames);

    // Sort by proximity (highest first = closest to referenced symbols)
    const scored = symbols.map((sym, idx) => ({
      symbol: sym,
      proximity: proximityScores[idx] ?? 0,
    }));
    scored.sort((a, b) => b.proximity - a.proximity);

    // Greedily include symbols until budget is exhausted
    const included: SymbolInfo[] = [];
    let usedTokens = 0;

    for (const { symbol } of scored) {
      const symbolTokens = Math.ceil(symbol.signature.length / CHARS_PER_TOKEN);
      if (usedTokens + symbolTokens <= maxTokens) {
        included.push(symbol);
        usedTokens += symbolTokens;
      }
    }

    return included;
  }

  /**
   * Estimate the total tokens for a set of symbols based on their signatures.
   */
  private estimateTokens(symbols: SymbolInfo[]): number {
    let total = 0;
    for (const sym of symbols) {
      total += Math.ceil(sym.signature.length / CHARS_PER_TOKEN);
    }
    return total;
  }

  /**
   * Compute proximity scores for each symbol relative to the referenced symbols.
   * Uses the Code_Graph to determine how closely connected each symbol is.
   *
   * Scoring:
   * - Direct reference in prompt: score 3
   * - Direct dependency/dependent of a referenced symbol: score 2
   * - Transitive (2-hop) dependency/dependent: score 1
   * - No connection: score 0
   */
  private computeProximityScores(
    symbols: SymbolInfo[],
    referencedSymbolNames: string[],
  ): number[] {
    const referenceSet = new Set(referencedSymbolNames);
    const codeGraph = this.astAnalyzer.getCodeGraph();

    // Build adjacency sets for 1-hop and 2-hop neighbors of referenced symbols
    const directNeighbors = new Set<string>();
    const transitiveNeighbors = new Set<string>();

    for (const refName of referencedSymbolNames) {
      // Get outgoing edges (dependencies)
      const edges = codeGraph.edges.get(refName);
      if (edges) {
        const allDeps = [...edges.imports, ...edges.calls, ...edges.inherits, ...edges.typeRefs];
        for (const dep of allDeps) {
          directNeighbors.add(dep);
          // 2-hop: get dependencies of dependencies
          const depEdges = codeGraph.edges.get(dep);
          if (depEdges) {
            const transitiveDeps = [...depEdges.imports, ...depEdges.calls, ...depEdges.inherits, ...depEdges.typeRefs];
            for (const td of transitiveDeps) {
              transitiveNeighbors.add(td);
            }
          }
        }
      }

      // Get incoming edges (dependents)
      for (const [name, nodeEdges] of codeGraph.edges) {
        const allRefs = [...nodeEdges.imports, ...nodeEdges.calls, ...nodeEdges.inherits, ...nodeEdges.typeRefs];
        if (allRefs.includes(refName)) {
          directNeighbors.add(name);
        }
      }
    }

    // Score each symbol
    return symbols.map((sym) => {
      if (referenceSet.has(sym.name)) return 3;
      if (directNeighbors.has(sym.name)) return 2;
      if (transitiveNeighbors.has(sym.name)) return 1;
      return 0;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Check if an identifier is likely a code symbol (not a common English word).
   */
  private isLikelySymbol(name: string): boolean {
    // Must be at least 2 characters
    if (name.length < 2) return false;
    // Must start with a letter or underscore
    if (!/^[a-zA-Z_$]/.test(name)) return false;
    // Must contain only valid identifier characters
    if (!/^[a-zA-Z0-9_$]+$/.test(name)) return false;
    return true;
  }

  /**
   * Check if a PascalCase word is actually a common English word (not a symbol).
   */
  private isCommonWord(name: string): boolean {
    const commonWords = new Set([
      'The', 'This', 'That', 'When', 'Where', 'Which', 'What', 'How',
      'Why', 'Who', 'Can', 'Could', 'Would', 'Should', 'Will', 'May',
      'Might', 'Must', 'Shall', 'Have', 'Has', 'Had', 'Does', 'Did',
      'Are', 'Was', 'Were', 'Been', 'Being', 'Each', 'Every', 'All',
      'Both', 'Few', 'More', 'Most', 'Other', 'Some', 'Such', 'Than',
      'Too', 'Very', 'Just', 'But', 'And', 'For', 'Not', 'Any',
      'Also', 'After', 'Before', 'Between', 'From', 'Into', 'About',
    ]);
    return commonWords.has(name);
  }
}
