/**
 * ImpactAnalyzer — Identifies affected entities via multiple methods
 *
 * Combines exact search, semantic shortlist, symbol references,
 * dependency traversal, diagnostics, recent edits, Git diff, and
 * explicit Context_Items to produce impact results with method provenance.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9
 */

import type {
  ImpactEntry,
  ImpactAnalysisResult,
  QueryMethod,
  FileNode,
  SymbolNode,
  DependencyEdge,
  GitState,
} from './types.js';
import type { RepositoryMapService } from './repository-map-service.js';

// ─── Context Item for explicit user-pinned items ─────────────────

export interface ContextItem {
  uri: string;
  reason?: string;
}

// ─── Diagnostic entry ────────────────────────────────────────────

export interface DiagnosticEntry {
  uri: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

// ─── Impact Analyzer Configuration ──────────────────────────────

export interface ImpactAnalyzerConfig {
  /** Maximum results per method */
  maxResultsPerMethod: number;
  /** Confidence threshold for inclusion */
  confidenceThreshold: number;
  /** Maximum depth for dependency traversal */
  maxDependencyDepth: number;
  /** Recent edit window in milliseconds */
  recentEditWindowMs: number;
}

const DEFAULT_CONFIG: ImpactAnalyzerConfig = {
  maxResultsPerMethod: 50,
  confidenceThreshold: 0.3,
  maxDependencyDepth: 3,
  recentEditWindowMs: 3600_000, // 1 hour
};

// ─── Impact Analyzer ─────────────────────────────────────────────

export class ImpactAnalyzer {
  private config: ImpactAnalyzerConfig;
  private repoMap: RepositoryMapService;

  constructor(repoMap: RepositoryMapService, config: Partial<ImpactAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.repoMap = repoMap;
  }

  /**
   * Analyze impact of changes to the given URIs using all available methods.
   */
  analyzeImpact(changedUris: string[], options?: ImpactAnalysisOptions): ImpactAnalysisResult {
    const entries: Map<string, ImpactEntry> = new Map();
    const methods: Set<QueryMethod> = new Set();

    // 1. Exact search (text/path matching)
    if (!options?.excludeMethods?.includes('exact-search')) {
      const exactResults = this.findByExactSearch(changedUris);
      this.mergeEntries(entries, exactResults);
      if (exactResults.length > 0) methods.add('exact-search');
    }

    // 2. Semantic shortlist (similarity)
    if (!options?.excludeMethods?.includes('semantic-shortlist')) {
      const semanticResults = this.findBySemanticShortlist(changedUris);
      this.mergeEntries(entries, semanticResults);
      if (semanticResults.length > 0) methods.add('semantic-shortlist');
    }

    // 3. Symbol references (find usages)
    if (!options?.excludeMethods?.includes('symbol-references')) {
      const symbolResults = this.findBySymbolReferences(changedUris);
      this.mergeEntries(entries, symbolResults);
      if (symbolResults.length > 0) methods.add('symbol-references');
    }

    // 4. Dependency traversal (transitive deps)
    if (!options?.excludeMethods?.includes('dependency-traversal')) {
      const depResults = this.findByDependencyTraversal(changedUris);
      this.mergeEntries(entries, depResults);
      if (depResults.length > 0) methods.add('dependency-traversal');
    }

    // 5. Diagnostics (errors in affected files)
    if (!options?.excludeMethods?.includes('diagnostics') && options?.diagnostics) {
      const diagResults = this.findByDiagnostics(changedUris, options.diagnostics);
      this.mergeEntries(entries, diagResults);
      if (diagResults.length > 0) methods.add('diagnostics');
    }

    // 6. Recent edits (recently modified files)
    if (!options?.excludeMethods?.includes('recent-edits')) {
      const recentResults = this.findByRecentEdits(changedUris);
      this.mergeEntries(entries, recentResults);
      if (recentResults.length > 0) methods.add('recent-edits');
    }

    // 7. Git diff (changed files)
    if (!options?.excludeMethods?.includes('git-diff')) {
      const gitResults = this.findByGitDiff(changedUris);
      this.mergeEntries(entries, gitResults);
      if (gitResults.length > 0) methods.add('git-diff');
    }

    // 8. Explicit Context_Items (user-pinned)
    if (!options?.excludeMethods?.includes('explicit-context') && options?.contextItems) {
      const contextResults = this.findByExplicitContext(options.contextItems);
      this.mergeEntries(entries, contextResults);
      if (contextResults.length > 0) methods.add('explicit-context');
    }

    // Filter by confidence threshold
    const filteredEntries = [...entries.values()].filter(
      (e) => e.confidence >= this.config.confidenceThreshold,
    );

    return {
      affectedEntities: filteredEntries,
      workspaceRevision: this.repoMap.getWorkspaceRevision(),
      timestamp: Date.now(),
      methods: [...methods],
    };
  }

  // ── Method Implementations ──────────────────────────────────────

  /** Exact search: find files whose paths match the changed URIs */
  private findByExactSearch(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    for (const uri of changedUris) {
      results.push({
        uri,
        method: 'exact-search',
        confidence: 1.0,
        reason: `Directly changed file`,
      });
    }
    return results;
  }

  /** Semantic shortlist: find semantically related files (by name similarity) */
  private findBySemanticShortlist(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const snapshot = this.repoMap.getSnapshot();

    for (const changedUri of changedUris) {
      const baseName = this.extractBaseName(changedUri);
      for (const [uri] of snapshot.files) {
        if (uri === changedUri) continue;
        const otherBase = this.extractBaseName(uri);
        // Simple heuristic: test files, related components
        if (this.isSemanticallyRelated(baseName, otherBase)) {
          results.push({
            uri,
            method: 'semantic-shortlist',
            confidence: 0.6,
            reason: `Semantically related to ${changedUri}`,
          });
        }
        if (results.length >= this.config.maxResultsPerMethod) break;
      }
    }
    return results;
  }

  /** Symbol references: find files that reference symbols defined in changed files */
  private findBySymbolReferences(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const snapshot = this.repoMap.getSnapshot();

    for (const changedUri of changedUris) {
      const symbols = snapshot.symbols.get(changedUri);
      if (!symbols) continue;

      const symbolNames = new Set(symbols.map((s) => s.name));

      // Find other files that reference these symbols
      for (const [uri, fileSymbols] of snapshot.symbols) {
        if (uri === changedUri) continue;
        for (const sym of fileSymbols) {
          if (symbolNames.has(sym.containerName ?? '')) {
            results.push({
              uri,
              method: 'symbol-references',
              confidence: 0.9,
              reason: `References symbol "${sym.containerName}" from ${changedUri}`,
            });
            break;
          }
        }
        if (results.length >= this.config.maxResultsPerMethod) break;
      }
    }
    return results;
  }

  /** Dependency traversal: follow the dependency graph transitively */
  private findByDependencyTraversal(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const visited = new Set<string>(changedUris);
    const queue: Array<{ uri: string; depth: number }> = changedUris.map((uri) => ({
      uri,
      depth: 0,
    }));

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= this.config.maxDependencyDepth) continue;

      const reverseDeps = this.repoMap.queryReverseDependencies(item.uri);
      for (const dep of reverseDeps.data) {
        if (visited.has(dep.sourceUri)) continue;
        visited.add(dep.sourceUri);

        const confidence = 1.0 - item.depth * 0.2;
        results.push({
          uri: dep.sourceUri,
          method: 'dependency-traversal',
          confidence: Math.max(confidence, 0.3),
          reason: `Depends on ${item.uri} (depth: ${item.depth + 1})`,
        });

        queue.push({ uri: dep.sourceUri, depth: item.depth + 1 });
        if (results.length >= this.config.maxResultsPerMethod) break;
      }
      if (results.length >= this.config.maxResultsPerMethod) break;
    }

    return results;
  }

  /** Diagnostics: find files with errors that relate to changed files */
  private findByDiagnostics(changedUris: string[], diagnostics: DiagnosticEntry[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const changedSet = new Set(changedUris);

    for (const diag of diagnostics) {
      if (changedSet.has(diag.uri)) continue;

      results.push({
        uri: diag.uri,
        method: 'diagnostics',
        confidence: diag.severity === 'error' ? 0.9 : 0.6,
        reason: `Has ${diag.severity}: ${diag.message}`,
      });

      if (results.length >= this.config.maxResultsPerMethod) break;
    }
    return results;
  }

  /** Recent edits: find recently modified files that may be related */
  private findByRecentEdits(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const snapshot = this.repoMap.getSnapshot();
    const now = Date.now();
    const changedSet = new Set(changedUris);

    for (const [uri, file] of snapshot.files) {
      if (changedSet.has(uri)) continue;
      const age = now - file.lastModified;
      if (age <= this.config.recentEditWindowMs) {
        const confidence = Math.max(0.3, 0.7 - (age / this.config.recentEditWindowMs) * 0.4);
        results.push({
          uri,
          method: 'recent-edits',
          confidence,
          reason: `Recently edited (${Math.round(age / 1000)}s ago)`,
        });
      }
      if (results.length >= this.config.maxResultsPerMethod) break;
    }
    return results;
  }

  /** Git diff: find files changed in the current Git working tree */
  private findByGitDiff(changedUris: string[]): ImpactEntry[] {
    const results: ImpactEntry[] = [];
    const gitResult = this.repoMap.queryGitState();
    const gitState = gitResult.data;
    if (!gitState) return results;

    const changedSet = new Set(changedUris);
    const allDirty = [...gitState.dirtyFiles, ...gitState.untrackedFiles];

    for (const uri of allDirty) {
      if (changedSet.has(uri)) continue;
      results.push({
        uri,
        method: 'git-diff',
        confidence: 0.7,
        reason: `Changed in Git working tree`,
      });
      if (results.length >= this.config.maxResultsPerMethod) break;
    }
    return results;
  }

  /** Explicit context: include user-pinned items directly */
  private findByExplicitContext(items: ContextItem[]): ImpactEntry[] {
    return items.map((item) => ({
      uri: item.uri,
      method: 'explicit-context' as QueryMethod,
      confidence: 1.0,
      reason: item.reason ?? 'Explicitly included by user',
    }));
  }

  // ── Utilities ───────────────────────────────────────────────────

  private extractBaseName(uri: string): string {
    const parts = uri.split('/');
    const fileName = parts[parts.length - 1] ?? '';
    return fileName.replace(/\.[^.]+$/, '').toLowerCase();
  }

  private isSemanticallyRelated(name1: string, name2: string): boolean {
    // Test file detection
    if (name2 === `${name1}.test` || name2 === `${name1}.spec`) return true;
    if (name1 === `${name2}.test` || name1 === `${name2}.spec`) return true;
    // Same base name with different suffixes (e.g., service vs service.test)
    if (name1.includes(name2) || name2.includes(name1)) {
      return name1 !== name2;
    }
    return false;
  }

  private mergeEntries(target: Map<string, ImpactEntry>, entries: ImpactEntry[]): void {
    for (const entry of entries) {
      const existing = target.get(entry.uri);
      if (!existing || entry.confidence > existing.confidence) {
        target.set(entry.uri, entry);
      }
    }
  }
}

// ─── Options ─────────────────────────────────────────────────────

export interface ImpactAnalysisOptions {
  /** Methods to exclude from analysis */
  excludeMethods?: QueryMethod[];
  /** Current diagnostics for diagnostic-based impact */
  diagnostics?: DiagnosticEntry[];
  /** Explicit context items from user */
  contextItems?: ContextItem[];
}
