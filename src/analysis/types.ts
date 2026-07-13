/**
 * Shared type definitions for codebase analysis modules.
 * Used across: dependency-parser, blast-radius-engine, health-scorer,
 * pattern-detector, architecture-classifier, community-detector,
 * path-tracer, query-engine, activity-heatmap, analysis-cache,
 * and codebase-analyzer orchestrator.
 */

// ─── Edge Confidence & Relationship Types ────────────────────────────────────

/**
 * Indicates whether an edge relationship was explicitly found in source code
 * or inferred by analysis heuristics.
 *
 * - EXTRACTED: Relationship is explicitly declared via import, require, or export-from
 * - INFERRED: Relationship was resolved by convention, dynamic import analysis, or basename matching
 */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED';

/**
 * The type of dependency relationship an edge represents.
 */
export type RelationshipType =
  | 'imports'
  | 'calls'
  | 'inherits'
  | 'implements'
  | 'mixes_in'
  | 're_exports'
  | 'references';

// ─── Core Graph Data Structures ──────────────────────────────────────────────

/**
 * A single file node in the dependency graph.
 */
export interface DependencyNode {
  /** Unique file identifier (relative path from project root) */
  id: string;
  /** Absolute path on the filesystem */
  filePath: string;
  /** Display name (filename without directory) */
  label: string;
  /** File extension including dot (e.g. '.ts') */
  extension: string;
  /** Total line count of the file */
  lineCount: number;
  /** Number of exported symbols */
  exportCount: number;
  /** Number of import statements */
  importCount: number;
}

/**
 * A directed edge representing a dependency between two files.
 */
export interface DependencyEdge {
  /** Unique edge identifier (source->target hash) */
  id: string;
  /** Source node ID (the file that depends) */
  source: string;
  /** Target node ID (the file being depended upon) */
  target: string;
  /** Whether this edge was explicitly found or inferred */
  confidence: EdgeConfidence;
  /** The type of dependency relationship */
  relationshipType: RelationshipType;
  /** Source location of the import statement, if available */
  sourceLocation?: { line: number; column: number };
}

/**
 * Metadata about an analysis run.
 */
export interface AnalysisMetadata {
  /** Unique identifier for the project */
  projectId: string;
  /** Absolute path to the project root */
  projectPath: string;
  /** ISO 8601 timestamp when analysis was performed */
  analyzedAt: string;
  /** Total number of files included in the graph */
  fileCount: number;
  /** Total number of edges in the graph */
  edgeCount: number;
  /** Number of files that failed to parse */
  parseErrors: number;
  /** Wall-clock time of analysis in milliseconds */
  analysisTimeMs: number;
}

/**
 * The complete dependency graph data structure.
 */
export interface DependencyGraph {
  /** Map of node ID → DependencyNode */
  nodes: Map<string, DependencyNode>;
  /** All directed edges in the graph */
  edges: DependencyEdge[];
  /** Adjacency list: fileId → array of file IDs it imports */
  adjacency: Map<string, string[]>;
  /** Reverse adjacency: fileId → array of file IDs that import this file */
  reverseAdjacency: Map<string, string[]>;
  /** Metadata about the analysis */
  metadata: AnalysisMetadata;
}

// ─── Blast Radius Types ──────────────────────────────────────────────────────

/**
 * A node within the blast radius result, annotated with BFS depth and opacity.
 */
export interface BlastRadiusNode {
  /** The file node ID */
  fileId: string;
  /** Absolute file path */
  filePath: string;
  /** BFS depth from the source file (1 = direct dependent) */
  depth: number;
  /** Visual opacity: 1.0 for depth 1, decreasing for deeper nodes, minimum 0.3 */
  opacity: number;
}

/**
 * Result of a blast radius computation for a given source file.
 */
export interface BlastRadiusResult {
  /** The source file from which blast radius was computed */
  sourceFile: string;
  /** Files that directly depend on the source (depth === 1) */
  directDependents: BlastRadiusNode[];
  /** Files that transitively depend on the source (depth >= 2) */
  transitiveDependents: BlastRadiusNode[];
  /** Total number of affected files */
  totalAffected: number;
  /** Maximum BFS depth reached during traversal */
  maxDepthReached: number;
}

// ─── Health Score Types ──────────────────────────────────────────────────────

/**
 * Letter grade for project health (A = highest quality, F = lowest).
 */
export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/**
 * An individual metric's score and details.
 */
export interface MetricScore {
  /** The raw measured value (e.g. count, percentage) */
  rawValue: number;
  /** Normalized score 0–100, where 100 = perfect health */
  normalizedScore: number;
  /** File paths or descriptions contributing to this metric */
  details: string[];
}

/**
 * Composite health score result for a project.
 */
export interface HealthScoreResult {
  /** Overall letter grade */
  grade: HealthGrade;
  /** Composite numeric score 0–100 */
  compositeScore: number;
  /** Breakdown by individual metrics */
  metrics: {
    deadCode: MetricScore;
    circularDependencies: MetricScore;
    coupling: MetricScore;
    securityIssues: MetricScore;
  };
}

// ─── Pattern Detection Types ─────────────────────────────────────────────────

/**
 * Recognized design patterns detected via AST analysis.
 */
export type DesignPattern = 'singleton' | 'factory' | 'observer' | 'react-hook';

/**
 * Recognized anti-patterns detected via metrics or AST analysis.
 */
export type AntiPattern = 'god-object' | 'high-coupling';

/**
 * A single pattern or anti-pattern match in a file.
 */
export interface PatternMatch {
  /** Node ID of the file containing the pattern */
  fileId: string;
  /** Absolute path to the file */
  filePath: string;
  /** The detected pattern or anti-pattern type */
  patternType: DesignPattern | AntiPattern;
  /** Confidence of the detection (0.0–1.0) */
  confidence: number;
  /** Human-readable description of why this file matches */
  evidence: string;
  /** Optional line range where the pattern occurs */
  lineRange?: { start: number; end: number };
}

/**
 * Aggregated result of pattern detection across the project.
 */
export interface PatternDetectionResult {
  /** Design pattern matches */
  patterns: PatternMatch[];
  /** Anti-pattern matches */
  antiPatterns: PatternMatch[];
  /** Files skipped due to missing tree-sitter grammar */
  skippedFiles: string[];
  /** Summary: pattern type → occurrence count */
  summary: Record<string, number>;
}

// ─── Architecture Layer Types ────────────────────────────────────────────────

/**
 * The architectural layers files can be assigned to.
 */
export type ArchitectureLayer = 'UI' | 'Services' | 'Utils' | 'Data' | 'Config' | 'Tests';

/**
 * The method used to classify a file into an architecture layer.
 */
export type ClassificationMethod = 'directory-convention' | 'content-heuristic' | 'default';

/**
 * Assignment of a file to an architectural layer.
 */
export interface LayerAssignment {
  /** Node ID of the file */
  fileId: string;
  /** Absolute file path */
  filePath: string;
  /** The assigned architectural layer */
  layer: ArchitectureLayer;
  /** How the classification was determined */
  method: ClassificationMethod;
}

// ─── Community Detection Types ───────────────────────────────────────────────

/**
 * A detected community (cluster of related files).
 */
export interface Community {
  /** Numeric community ID */
  id: number;
  /** Auto-generated label from representative file/directory paths */
  label: string;
  /** Distinct hex color assigned to this community */
  color: string;
  /** IDs of all nodes belonging to this community */
  nodeIds: string[];
  /** Number of nodes in this community */
  nodeCount: number;
}

/**
 * Information about a "god node" — a node with extremely high connectivity.
 */
export interface GodNodeInfo {
  /** Node ID of the god node */
  fileId: string;
  /** Absolute file path */
  filePath: string;
  /** Total degree (in-degree + out-degree) */
  totalDegree: number;
  /** Community this node belongs to */
  communityId: number;
  /** Top 5 most-connected file paths */
  topConnections: string[];
}

/**
 * Result of community detection on the dependency graph.
 */
export interface CommunityResult {
  /** All detected communities */
  communities: Community[];
  /** Identified god nodes (top percentile by degree) */
  godNodes: GodNodeInfo[];
  /** Modularity score — quality metric for the partition */
  modularity: number;
}

// ─── Path Tracing Types ──────────────────────────────────────────────────────

/**
 * A node in a traced path.
 */
export interface PathNode {
  /** Node ID */
  fileId: string;
  /** Absolute file path */
  filePath: string;
  /** Whether this is an intermediate node (not source or target) */
  isIntermediate: boolean;
}

/**
 * Result of a shortest-path computation between two nodes.
 */
export interface PathResult {
  /** Whether a path was found */
  found: boolean;
  /** Number of hops in the path (0 for same-node) */
  hops: number;
  /** Ordered list of nodes from source to target */
  path: PathNode[];
}

// ─── Query Engine Types ──────────────────────────────────────────────────────

/**
 * A node matched by the query engine, annotated with match reason.
 */
export interface QueryMatchNode {
  /** Node ID of the matched file */
  fileId: string;
  /** Why this node was matched */
  matchReason: 'file-name' | 'function-name' | 'class-name' | 'relationship-label';
  /** The term that triggered the match */
  matchedTerm: string;
}

/**
 * Result of a query-based subgraph extraction.
 */
export interface SubgraphResult {
  /** Nodes that directly matched the query terms */
  matchedNodes: QueryMatchNode[];
  /** Node IDs within 2 hops of any matched node */
  expandedNodes: string[];
  /** All edges between included nodes */
  edges: DependencyEdge[];
  /** Total node count in the full graph */
  totalNodes: number;
  /** Total edge count in the full graph */
  totalEdges: number;
  /** Number of directly matched nodes */
  matchCount: number;
}

// ─── Activity Heatmap Types ──────────────────────────────────────────────────

/**
 * Commit activity data for a single file.
 */
export interface FileActivity {
  /** Node ID of the file */
  fileId: string;
  /** Absolute file path */
  filePath: string;
  /** Number of commits modifying this file within the time window */
  commitCount: number;
  /** ISO timestamp of the most recent commit, or null if no commits */
  lastCommitDate: string | null;
  /** Percentile rank among files with commits, or null for zero-commit files */
  percentile: number | null;
  /** Computed color from the gradient mapping */
  color: string;
}

/**
 * Result of activity heatmap computation.
 */
export interface HeatmapResult {
  /** Activity data per file */
  files: FileActivity[];
  /** Time window used for the computation */
  timeWindow: { startDate: string; endDate: string; days: number };
  /** Whether a Git repository was found at the project path */
  hasGitRepo: boolean;
}

// ─── Analysis Request/Result Types ───────────────────────────────────────────

/**
 * Options for an analysis request.
 */
export interface AnalysisOptions {
  /** Force re-analysis even if cache is valid */
  forceRefresh?: boolean;
  /** Only reparse modified files (requires prior cache) */
  incrementalOnly?: boolean;
}

/**
 * Request to analyze a project's codebase.
 */
export interface AnalysisRequest {
  /** Unique identifier for the project */
  projectId: string;
  /** Absolute path to the project root */
  projectPath: string;
  /** Analysis options */
  options?: AnalysisOptions;
}

/**
 * Result of a full codebase analysis.
 */
export interface AnalysisResult {
  /** The computed dependency graph */
  graph: DependencyGraph;
  /** Metadata about the analysis run */
  metadata: AnalysisMetadata;
}

// ─── Cache Types ─────────────────────────────────────────────────────────────

/**
 * A cached analysis entry stored on disk.
 */
export interface CacheEntry {
  /** Project identifier */
  projectId: string;
  /** Unix timestamp of when the cache was created */
  timestamp: number;
  /** Map of filePath → content hash for change detection */
  fileHashes: Map<string, string>;
  /** The cached dependency graph */
  graph: DependencyGraph;
  /** Analysis metadata */
  metadata: AnalysisMetadata;
}

/**
 * Serialized cache format stored as JSON on disk.
 */
export interface CacheFileSchema {
  /** Schema version for forward compatibility */
  version: 1;
  /** Project identifier */
  projectId: string;
  /** ISO timestamp of when analysis was performed */
  analyzedAt: string;
  /** File path → content hash mapping */
  fileHashes: Record<string, string>;
  /** Serialized graph data */
  graph: {
    nodes: DependencyNode[];
    edges: DependencyEdge[];
  };
  /** Optional cached community detection result */
  communities?: CommunityResult;
  /** Optional cached pattern detection result */
  patterns?: PatternDetectionResult;
  /** Optional cached health score */
  healthScore?: HealthScoreResult;
}

// ─── Progress Event Types ────────────────────────────────────────────────────

/**
 * Phases of the analysis pipeline for progress reporting.
 */
export type AnalysisPhase = 'parsing' | 'resolving' | 'analyzing' | 'complete';

/**
 * Progress event emitted during analysis.
 */
export interface ProgressEvent {
  /** Completion percentage (0–100) */
  percent: number;
  /** Current phase of the analysis pipeline */
  phase: AnalysisPhase;
  /** Number of files processed so far */
  filesProcessed: number;
  /** Total number of files to process */
  totalFiles: number;
}

// ─── Supported File Extensions ───────────────────────────────────────────────

/**
 * File extensions supported for dependency analysis.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
] as const;
