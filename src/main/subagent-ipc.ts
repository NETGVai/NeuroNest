/**
 * Subagent IPC Handler — Registers IPC channels for dynamic subagent spawning.
 *
 * Channels:
 *   - subagent:spawn   — Spawn a focused subagent for a subtask
 *   - subagent:status  — Get current spawn budget and active subagent info
 *   - subagent:results — Get aggregated results from previous subagent spawns
 *
 * Integrates with:
 *   - SubagentTaskSpawner for lifecycle management
 *   - FeatureGateSystem for subagent_spawning flag
 *   - Swarm Coordinator for multi-agent context (subagent results fed back as phase outputs)
 *   - CostTrackingService for parent session cost attribution
 *
 * Requirements: 12.1, 12.7
 */

import { ipcMain } from 'electron';
import {
  SubagentTaskSpawner,
  type SpawnSubagentInput,
  type ToolPermissions,
  type SpawnedSubagentResult,
  type SubagentResultsSummary,
  type CostTracker,
  DEFAULT_SPAWN_BUDGET,
} from '../pipeline/subagent-spawner.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SubagentIPCDependencies {
  /** Check if the subagent_spawning feature flag is enabled */
  isFeatureEnabled: () => boolean;
  /** Resolve the active LLM client for subagent execution */
  resolveLLMClient: () => any | null;
  /** Get the current active session ID */
  getActiveSessionId: () => string | null;
  /** Optional cost tracker for parent session cost attribution */
  costTracker?: CostTracker | null;
  /** Get spawn budget from settings (or use default) */
  getSpawnBudget?: () => number;
}

// ─── Session results cache ──────────────────────────────────────

/** Cache of subagent results per session for the subagent:results channel */
const sessionResults = new Map<string, SpawnedSubagentResult[]>();

/** Maximum results to cache per session */
const MAX_CACHED_RESULTS = 50;

// ─── Default parent permissions ─────────────────────────────────

const DEFAULT_PARENT_PERMISSIONS: ToolPermissions = {
  allowedTools: ['*'], // All tools allowed by default
  maxRiskLevel: 'execute',
  autoApprove: false,
};

// ─── Registration ───────────────────────────────────────────────

/**
 * Register subagent IPC handlers.
 *
 * Called from registerIPCHandlers in src/main/ipc.ts.
 * Follows the same pattern as registerAutocompleteIPC, registerSemanticIPC, etc.
 */
export function registerSubagentIPC(deps: SubagentIPCDependencies): void {
  // Remove any previously registered handlers (for window recreate)
  const channels = ['subagent:spawn', 'subagent:status', 'subagent:results'];
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch); } catch {}
  }

  /**
   * subagent:spawn — Spawn a focused subagent for a subtask.
   *
   * Input: { taskName, taskDescription, systemPrompt?, relevantFiles?, additionalContext?, maxTokens? }
   * Output: SpawnedSubagentResult with cost attribution
   *
   * Requirements: 12.1, 12.2, 12.3, 12.4, 12.6, 12.7
   */
  ipcMain.handle('subagent:spawn', async (_ev, args: any) => {
    try {
      // Gate behind feature flag
      if (!deps.isFeatureEnabled()) {
        return {
          success: false,
          error: 'Subagent spawning is disabled. Enable the subagent_spawning feature flag in settings.',
        };
      }

      const sessionId = deps.getActiveSessionId();
      if (!sessionId) {
        return { success: false, error: 'No active session — cannot spawn subagent' };
      }

      const llmClient = deps.resolveLLMClient();
      if (!llmClient) {
        return { success: false, error: 'No LLM provider configured for subagent execution' };
      }

      // Validate input
      const { taskName, taskDescription, systemPrompt, relevantFiles, additionalContext, maxTokens } = args || {};
      if (!taskName || typeof taskName !== 'string' || !taskName.trim()) {
        return { success: false, error: 'taskName is required and must be a non-empty string' };
      }
      if (!taskDescription || typeof taskDescription !== 'string' || !taskDescription.trim()) {
        return { success: false, error: 'taskDescription is required and must be a non-empty string' };
      }

      // Get or create the spawner singleton with cost tracking
      const spawnBudget = deps.getSpawnBudget?.() ?? DEFAULT_SPAWN_BUDGET;
      const spawner = SubagentTaskSpawner.getInstance(
        { spawnBudget, maxNestingDepth: 3 },
        deps.costTracker,
      );

      // Build spawn input
      const taskId = `subagent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const spawnInput: SpawnSubagentInput = {
        taskId,
        taskName: taskName.trim(),
        taskDescription: taskDescription.trim(),
        systemPrompt: systemPrompt || undefined,
        scopedContext: {
          parentTaskDescription: 'Delegated subtask from active session.',
          fileReferences: Array.isArray(relevantFiles)
            ? relevantFiles.map((f: any) => ({
                path: typeof f.path === 'string' ? f.path : '',
                content: typeof f.content === 'string' ? f.content : undefined,
                startLine: typeof f.startLine === 'number' ? f.startLine : undefined,
                endLine: typeof f.endLine === 'number' ? f.endLine : undefined,
              }))
            : [],
          additionalContext: typeof additionalContext === 'string' ? additionalContext : undefined,
        },
        maxTokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 1000,
      };

      // Spawn the subagent
      const result = await spawner.spawn(
        spawnInput,
        llmClient,
        DEFAULT_PARENT_PERMISSIONS,
        sessionId,
        1,
      );

      // Cache the result for subagent:results queries
      if (!sessionResults.has(sessionId)) {
        sessionResults.set(sessionId, []);
      }
      const cached = sessionResults.get(sessionId)!;
      cached.push(result);
      if (cached.length > MAX_CACHED_RESULTS) {
        cached.shift();
      }

      return {
        success: result.success,
        taskId: result.taskId,
        taskName: result.taskName,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
        nestingDepth: result.nestingDepth,
        costUSD: result.costUSD,
        tokenUsage: result.tokenUsage,
        remainingBudget: spawner.getRemainingBudget(sessionId),
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Unexpected error during subagent spawn' };
    }
  });

  /**
   * subagent:status — Get the current session's spawn budget status.
   *
   * Output: { enabled, remainingBudget, totalBudget, spawnsUsed, maxNestingDepth }
   */
  ipcMain.handle('subagent:status', async () => {
    try {
      const enabled = deps.isFeatureEnabled();
      const sessionId = deps.getActiveSessionId();

      if (!enabled || !sessionId) {
        return {
          enabled,
          remainingBudget: 0,
          totalBudget: deps.getSpawnBudget?.() ?? DEFAULT_SPAWN_BUDGET,
          spawnsUsed: 0,
          maxNestingDepth: 3,
        };
      }

      const spawnBudget = deps.getSpawnBudget?.() ?? DEFAULT_SPAWN_BUDGET;
      const spawner = SubagentTaskSpawner.getInstance({ spawnBudget, maxNestingDepth: 3 });

      return {
        enabled,
        remainingBudget: spawner.getRemainingBudget(sessionId),
        totalBudget: spawnBudget,
        spawnsUsed: spawner.getSpawnCount(sessionId),
        maxNestingDepth: spawner.getConfig().maxNestingDepth,
      };
    } catch (e: any) {
      return {
        enabled: false,
        remainingBudget: 0,
        totalBudget: DEFAULT_SPAWN_BUDGET,
        spawnsUsed: 0,
        maxNestingDepth: 3,
        error: e?.message,
      };
    }
  });

  /**
   * subagent:results — Get aggregated results from subagent spawns in the current session.
   *
   * Output: SubagentResultsSummary with formatted summary for Swarm Coordinator integration
   */
  ipcMain.handle('subagent:results', async () => {
    try {
      const sessionId = deps.getActiveSessionId();
      if (!sessionId) {
        return { totalSpawned: 0, successCount: 0, failureCount: 0, totalCostUSD: 0, totalDurationMs: 0, results: [], formattedSummary: '' };
      }

      const results = sessionResults.get(sessionId) || [];
      if (results.length === 0) {
        return { totalSpawned: 0, successCount: 0, failureCount: 0, totalCostUSD: 0, totalDurationMs: 0, results: [], formattedSummary: '' };
      }

      // Use the spawner's aggregation logic
      const spawner = SubagentTaskSpawner.getInstance();
      const summary: SubagentResultsSummary = spawner.aggregateResults(results);

      return summary;
    } catch (e: any) {
      return {
        totalSpawned: 0,
        successCount: 0,
        failureCount: 0,
        totalCostUSD: 0,
        totalDurationMs: 0,
        results: [],
        formattedSummary: '',
        error: e?.message,
      };
    }
  });

  console.log('[IPC] Subagent spawning IPC handlers registered');
}
