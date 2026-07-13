/**
 * Codebase Analyzer — Main-process orchestrator for all analysis sub-modules.
 *
 * Coordinates dependency parsing, blast radius computation, health scoring,
 * pattern detection, architecture classification, community detection,
 * path tracing, query-based subgraph extraction, and activity heatmap computation.
 *
 * Key behaviors:
 * - Checks cache before running full analysis
 * - Supports incremental analysis for changed files
 * - Emits progress events during analysis
 * - Handles errors gracefully (returns partial results on failure)
 *
 * Requirements: 1.1, 1.6, 1.8, 8.1, 8.2, 8.5
 */
import { EventEmitter } from 'events';
import type {
  AnalysisRequest,
  AnalysisResult,
  BlastRadiusResult,
  CommunityResult,
  DependencyGraph,
  HeatmapResult,
  HealthScoreResult,
  LayerAssignment,
  PathResult,
  PatternDetectionResult,
  ProgressEvent,
  SubgraphResult,
} from './types.js';
import { SUPPORTED_EXTENSIONS } from './types.js';
import { AnalysisCache } from './analysis-cache.js';
import { DependencyParser } from './dependency-parser.js';
import { BlastRadiusEngine } from './blast-radius-engine.js';
import { HealthScorer } from './health-scorer.js';
import { PatternDetector } from './pattern-detector.js';
import { ArchitectureLayerClassifier } from './architecture-classifier.js';
import { CommunityDetector } from './community-detector.js';
import { PathTracer } from './path-tracer.js';
import { QueryEngine } from './query-engine.js';
import { ActivityHeatmapProcessor } from './activity-heatmap.js';

export class CodebaseAnalyzer extends EventEmitter {
  /** Stores the last successful analysis result per project */
  private lastResults: Map<string, AnalysisResult> = new Map();

  constructor(
    private cache: AnalysisCache,
    private parser: DependencyParser,
    private blastEngine: BlastRadiusEngine,
    private healthScorer: HealthScorer,
    private patternDetector: PatternDetector,
    private archClassifier: ArchitectureLayerClassifier,
    private communityDetector: CommunityDetector,
    private pathTracer: PathTracer,
    private queryEngine: QueryEngine,
    private heatmapProcessor: ActivityHeatmapProcessor
  ) {
    super();
  }

  /**
   * Run full or incremental codebase analysis.
   *
   * Flow:
   * 1. Check cache validity (unless forceRefresh)
   * 2. If cache valid, return cached result
   * 3. Otherwise, determine changed files for incremental or do full parse
   * 4. Store result in cache
   * 5. Emit progress events throughout
   */
  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const { projectId, projectPath, options } = request;
    const forceRefresh = options?.forceRefresh ?? false;

    // Phase: checking cache
    this.emitProgress({ percent: 0, phase: 'parsing', filesProcessed: 0, totalFiles: 0 });

    // Step 1: Check cache unless forced refresh
    if (!forceRefresh) {
      try {
        const cacheValid = await this.cache.isValid(projectId, projectPath);
        if (cacheValid) {
          const cached = await this.cache.get(projectId);
          if (cached) {
            const result: AnalysisResult = {
              graph: cached.graph,
              metadata: cached.metadata,
            };
            this.lastResults.set(projectId, result);
            this.emitProgress({ percent: 100, phase: 'complete', filesProcessed: cached.metadata.fileCount, totalFiles: cached.metadata.fileCount });
            return result;
          }
        }
      } catch {
        // Cache check failed — proceed with fresh analysis
      }
    }

    // Step 2: Determine whether to do incremental or full parse
    let graph: DependencyGraph;

    try {
      const changedFiles = await this.cache.getChangedFiles(projectId, projectPath);
      const cachedEntry = await this.cache.get(projectId);

      if (cachedEntry && changedFiles.length > 0 && !forceRefresh && !options?.incrementalOnly) {
        // Incremental parse: only changed files
        this.emitProgress({ percent: 10, phase: 'parsing', filesProcessed: 0, totalFiles: changedFiles.length });
        graph = await this.parser.parseIncremental(projectPath, changedFiles, cachedEntry.graph);
      } else if (cachedEntry && options?.incrementalOnly && changedFiles.length > 0) {
        // Explicit incremental-only mode
        this.emitProgress({ percent: 10, phase: 'parsing', filesProcessed: 0, totalFiles: changedFiles.length });
        graph = await this.parser.parseIncremental(projectPath, changedFiles, cachedEntry.graph);
      } else {
        // Full parse
        this.emitProgress({ percent: 10, phase: 'parsing', filesProcessed: 0, totalFiles: 0 });
        graph = await this.parser.parseProject(projectPath, [...SUPPORTED_EXTENSIONS]);
      }
    } catch (error) {
      // If parsing fails entirely, attempt to return cached data as partial result
      const cachedEntry = await this.cache.get(projectId).catch(() => null);
      if (cachedEntry) {
        const result: AnalysisResult = {
          graph: cachedEntry.graph,
          metadata: cachedEntry.metadata,
        };
        this.lastResults.set(projectId, result);
        this.emitProgress({ percent: 100, phase: 'complete', filesProcessed: cachedEntry.metadata.fileCount, totalFiles: cachedEntry.metadata.fileCount });
        return result;
      }
      throw error;
    }

    this.emitProgress({ percent: 70, phase: 'resolving', filesProcessed: graph.metadata.fileCount, totalFiles: graph.metadata.fileCount });

    // Step 3: Store result in cache
    try {
      const fileHashes = new Map<string, string>();
      // Build file hashes from the graph's nodes for cache storage
      for (const [nodeId] of graph.nodes) {
        try {
          const node = graph.nodes.get(nodeId);
          if (node) {
            const hash = await this.cache.hashFile(node.filePath);
            fileHashes.set(nodeId, hash);
          }
        } catch {
          // Skip files that can't be hashed
        }
      }

      await this.cache.set(projectId, {
        projectId,
        timestamp: Date.now(),
        fileHashes,
        graph,
        metadata: graph.metadata,
      });
    } catch {
      // Cache write failure is non-fatal
    }

    this.emitProgress({ percent: 90, phase: 'analyzing', filesProcessed: graph.metadata.fileCount, totalFiles: graph.metadata.fileCount });

    const result: AnalysisResult = {
      graph,
      metadata: graph.metadata,
    };

    this.lastResults.set(projectId, result);
    this.emitProgress({ percent: 100, phase: 'complete', filesProcessed: graph.metadata.fileCount, totalFiles: graph.metadata.fileCount });

    return result;
  }

  /**
   * Compute blast radius for a given file.
   * Triggers analysis if no graph is available for the project.
   */
  async getBlastRadius(projectId: string, fileId: string, maxDepth?: number): Promise<BlastRadiusResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      return this.blastEngine.computeBlastRadius(graph, fileId, maxDepth);
    } catch (error) {
      // Return empty result on failure
      return {
        sourceFile: fileId,
        directDependents: [],
        transitiveDependents: [],
        totalAffected: 0,
        maxDepthReached: 0,
      };
    }
  }

  /**
   * Compute composite health score for the project.
   * Triggers analysis if no graph is available.
   */
  async getHealthScore(projectId: string): Promise<HealthScoreResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      // Need patterns for the security metric
      const patterns = await this.detectPatterns(projectId);
      return this.healthScorer.computeHealthScore(graph, patterns);
    } catch (error) {
      // Return a failing health score on error
      return {
        grade: 'F',
        compositeScore: 0,
        metrics: {
          deadCode: { rawValue: 0, normalizedScore: 0, details: [] },
          circularDependencies: { rawValue: 0, normalizedScore: 0, details: [] },
          coupling: { rawValue: 0, normalizedScore: 0, details: [] },
          securityIssues: { rawValue: 0, normalizedScore: 0, details: [] },
        },
      };
    }
  }

  /**
   * Detect design patterns and anti-patterns in the project.
   * Triggers analysis if no graph is available.
   */
  async detectPatterns(projectId: string): Promise<PatternDetectionResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      return await this.patternDetector.detectPatterns(graph, new Map());
    } catch (error) {
      // Return empty pattern result on failure
      return {
        patterns: [],
        antiPatterns: [],
        skippedFiles: [],
        summary: {},
      };
    }
  }

  /**
   * Classify all files into architectural layers.
   * Triggers analysis if no graph is available.
   */
  async getArchitectureLayers(projectId: string): Promise<LayerAssignment[]> {
    const graph = await this.ensureGraph(projectId);
    try {
      return this.archClassifier.classifyFiles(graph);
    } catch {
      return [];
    }
  }

  /**
   * Detect communities (clusters) in the dependency graph.
   * Triggers analysis if no graph is available.
   */
  async detectCommunities(projectId: string): Promise<CommunityResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      return this.communityDetector.detectCommunities(graph);
    } catch {
      return { communities: [], godNodes: [], modularity: 0 };
    }
  }

  /**
   * Trace shortest path between two files.
   * Triggers analysis if no graph is available.
   */
  async tracePath(projectId: string, sourceId: string, targetId: string): Promise<PathResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      return this.pathTracer.findShortestPath(graph, sourceId, targetId);
    } catch {
      return { found: false, hops: 0, path: [] };
    }
  }

  /**
   * Query the dependency graph for matching subgraph.
   * Triggers analysis if no graph is available.
   */
  async querySubgraph(projectId: string, query: string): Promise<SubgraphResult> {
    const graph = await this.ensureGraph(projectId);
    try {
      return this.queryEngine.querySubgraph(graph, query);
    } catch {
      return {
        matchedNodes: [],
        expandedNodes: [],
        edges: [],
        totalNodes: 0,
        totalEdges: 0,
        matchCount: 0,
      };
    }
  }

  /**
   * Compute activity heatmap from Git history.
   * Uses project path from the last analysis result.
   */
  async getActivityHeatmap(projectId: string, days?: number): Promise<HeatmapResult> {
    const result = this.lastResults.get(projectId);
    const projectPath = result?.metadata.projectPath ?? '';

    if (!projectPath) {
      return { files: [], timeWindow: { startDate: '', endDate: '', days: days ?? 90 }, hasGitRepo: false };
    }

    try {
      return await this.heatmapProcessor.computeHeatmap(projectPath, days);
    } catch {
      return { files: [], timeWindow: { startDate: '', endDate: '', days: days ?? 90 }, hasGitRepo: false };
    }
  }

  /**
   * Ensure a graph is available for the project.
   * If no stored result exists, trigger a fresh analysis using stored project path.
   * Throws if no graph can be produced.
   */
  private async ensureGraph(projectId: string): Promise<DependencyGraph> {
    const existing = this.lastResults.get(projectId);
    if (existing) {
      return existing.graph;
    }

    // Attempt to load from cache
    try {
      const cached = await this.cache.get(projectId);
      if (cached) {
        const result: AnalysisResult = {
          graph: cached.graph,
          metadata: cached.metadata,
        };
        this.lastResults.set(projectId, result);
        return cached.graph;
      }
    } catch {
      // Cache retrieval failed
    }

    throw new Error(
      `No analysis result available for project "${projectId}". Call analyze() first.`
    );
  }

  /**
   * Emit a progress event to listeners.
   */
  private emitProgress(event: ProgressEvent): void {
    this.emit('progress', event);
  }
}
