/**
 * IPC handler registration for the Codebase Analysis system.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (vision-ipc.ts, artifact-ipc.ts, pipeline-ipc.ts).
 *
 * Channels:
 *   codebase-analyze       — run full or incremental codebase analysis
 *   codebase-blast-radius  — compute blast radius for a file
 *   codebase-health-score  — compute composite health grade
 *   codebase-patterns      — detect design patterns and anti-patterns
 *   codebase-layers        — classify files into architecture layers
 *   codebase-communities   — detect community clusters via Leiden algorithm
 *   codebase-path-trace    — trace shortest path between two nodes
 *   codebase-query         — query subgraph by natural-language terms
 *   codebase-heatmap       — compute activity heatmap from Git history
 *
 * Progress events:
 *   codebase-progress      — streamed to renderer during analysis
 *
 * Requirements: 7.3, 8.5
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { CodebaseAnalyzer } from '../analysis/codebase-analyzer.js';
import { AnalysisCache } from '../analysis/analysis-cache.js';
import { DependencyParser } from '../analysis/dependency-parser.js';
import { BlastRadiusEngine } from '../analysis/blast-radius-engine.js';
import { HealthScorer } from '../analysis/health-scorer.js';
import { PatternDetector } from '../analysis/pattern-detector.js';
import { ArchitectureLayerClassifier } from '../analysis/architecture-classifier.js';
import { CommunityDetector } from '../analysis/community-detector.js';
import { PathTracer } from '../analysis/path-tracer.js';
import { QueryEngine } from '../analysis/query-engine.js';
import { ActivityHeatmapProcessor } from '../analysis/activity-heatmap.js';
import type { AnalysisRequest, ProgressEvent } from '../analysis/types.js';

// ─── Error response type ────────────────────────────────────────

export interface CodebaseIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let analyzer: CodebaseAnalyzer | null = null;

/**
 * Get or create the CodebaseAnalyzer singleton with all sub-modules.
 */
function getAnalyzer(): CodebaseAnalyzer {
  if (!analyzer) {
    const cache = new AnalysisCache();
    const parser = new DependencyParser();
    const blastEngine = new BlastRadiusEngine();
    const healthScorer = new HealthScorer();
    const patternDetector = new PatternDetector();
    const archClassifier = new ArchitectureLayerClassifier();
    const communityDetector = new CommunityDetector();
    const pathTracer = new PathTracer();
    const queryEngine = new QueryEngine();
    const heatmapProcessor = new ActivityHeatmapProcessor();

    analyzer = new CodebaseAnalyzer(
      cache,
      parser,
      blastEngine,
      healthScorer,
      patternDetector,
      archClassifier,
      communityDetector,
      pathTracer,
      queryEngine,
      heatmapProcessor,
    );
  }
  return analyzer;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): CodebaseIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register all codebase analysis IPC handlers and wire progress events
 * to the renderer process via mainWindow.webContents.send().
 */
export function registerCodebaseHandlers(mainWindow: BrowserWindow): void {
  const instance = getAnalyzer();

  // ── Forward progress events to renderer ──
  instance.on('progress', (event: ProgressEvent) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('codebase-progress', event);
    }
  });

  // ── codebase-analyze ──
  // Requirement 7.3: IPC communication via existing graph-service pattern
  // Requirement 8.5: Progress indicator during analysis
  ipcMain.handle(
    'codebase-analyze',
    async (_event, args: AnalysisRequest) => {
      try {
        // Resolve project path if not provided (standard NeuroNest project location)
        if (!args.projectPath && args.projectId) {
          const os = require('node:os');
          const path = require('node:path');
          args.projectPath = path.join(os.homedir(), '.neuronest', 'projects', args.projectId);
        }
        const result = await instance.analyze(args);
        return result;
      } catch (err) {
        return makeError('CODEBASE_ANALYZE_FAILED', err);
      }
    },
  );

  // ── codebase-blast-radius ──
  // Computes all files affected by changes to a given file
  ipcMain.handle(
    'codebase-blast-radius',
    async (
      _event,
      args: { projectId: string; fileId: string; maxDepth?: number },
    ) => {
      try {
        const result = await instance.getBlastRadius(
          args.projectId,
          args.fileId,
          args.maxDepth,
        );
        return result;
      } catch (err) {
        return makeError('CODEBASE_BLAST_RADIUS_FAILED', err);
      }
    },
  );

  // ── codebase-health-score ──
  // Computes composite A-F health grade for the project
  ipcMain.handle(
    'codebase-health-score',
    async (_event, args: { projectId: string }) => {
      try {
        const result = await instance.getHealthScore(args.projectId);
        return result;
      } catch (err) {
        return makeError('CODEBASE_HEALTH_SCORE_FAILED', err);
      }
    },
  );

  // ── codebase-patterns ──
  // Detects design patterns and anti-patterns via AST analysis
  ipcMain.handle(
    'codebase-patterns',
    async (_event, args: { projectId: string }) => {
      try {
        const result = await instance.detectPatterns(args.projectId);
        return result;
      } catch (err) {
        return makeError('CODEBASE_PATTERNS_FAILED', err);
      }
    },
  );

  // ── codebase-layers ──
  // Classifies files into architecture layers (UI, Services, Utils, Data, Config, Tests)
  ipcMain.handle(
    'codebase-layers',
    async (_event, args: { projectId: string }) => {
      try {
        const result = await instance.getArchitectureLayers(args.projectId);
        return result;
      } catch (err) {
        return makeError('CODEBASE_LAYERS_FAILED', err);
      }
    },
  );

  // ── codebase-communities ──
  // Partitions dependency graph into subsystem clusters via Leiden algorithm
  ipcMain.handle(
    'codebase-communities',
    async (_event, args: { projectId: string }) => {
      try {
        const result = await instance.detectCommunities(args.projectId);
        return result;
      } catch (err) {
        return makeError('CODEBASE_COMMUNITIES_FAILED', err);
      }
    },
  );

  // ── codebase-path-trace ──
  // Traces shortest path between two files in the dependency graph
  ipcMain.handle(
    'codebase-path-trace',
    async (
      _event,
      args: { projectId: string; sourceId: string; targetId: string },
    ) => {
      try {
        const result = await instance.tracePath(
          args.projectId,
          args.sourceId,
          args.targetId,
        );
        return result;
      } catch (err) {
        return makeError('CODEBASE_PATH_TRACE_FAILED', err);
      }
    },
  );

  // ── codebase-query ──
  // Matches natural-language query against graph and returns relevant subgraph
  ipcMain.handle(
    'codebase-query',
    async (_event, args: { projectId: string; query: string }) => {
      try {
        const result = await instance.querySubgraph(
          args.projectId,
          args.query,
        );
        return result;
      } catch (err) {
        return makeError('CODEBASE_QUERY_FAILED', err);
      }
    },
  );

  // ── codebase-heatmap ──
  // Computes file activity heatmap from local Git history
  ipcMain.handle(
    'codebase-heatmap',
    async (_event, args: { projectId: string; days?: number }) => {
      try {
        const result = await instance.getActivityHeatmap(
          args.projectId,
          args.days,
        );
        return result;
      } catch (err) {
        return makeError('CODEBASE_HEATMAP_FAILED', err);
      }
    },
  );

  console.log('[IPC] Codebase analysis handlers registered');
}
