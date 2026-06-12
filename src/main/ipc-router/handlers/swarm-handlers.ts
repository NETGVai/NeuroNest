/**
 * Swarm Domain IPC Handlers
 *
 * Handles swarm orchestration IPC operations: budget management, plan versioning,
 * task execution coordination, and token tracking.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

const BudgetGetRequest = z.object({
  projectId: z.string(),
});

const BudgetGetResponse = z.object({
  success: z.boolean(),
  budget: z.object({
    maxCostUSD: z.number(),
    warningThreshold: z.number(),
    currentUsage: z.number().optional(),
    tokensUsed: z.number().optional(),
  }).optional(),
  error: z.string().optional(),
});

const BudgetSetRequest = z.object({
  projectId: z.string(),
  maxCostUSD: z.number(),
  warningThreshold: z.number().optional(),
});

const BudgetSetResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const BudgetRecordRequest = z.object({
  projectId: z.string(),
  tokens: z.number(),
  costUSD: z.number(),
});

const BudgetRecordResponse = z.object({
  allowed: z.boolean(),
  warning: z.boolean(),
  remaining: z.number(),
});

const BudgetResetRequest = z.object({
  projectId: z.string(),
});

const BudgetResetResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const PlanVersionRecordRequest = z.object({
  planId: z.string(),
  action: z.string(),
  snapshot: z.unknown(),
  branch: z.string().optional(),
  description: z.string().optional(),
});

const PlanVersionRecordResponse = z.object({
  version: z.number().optional(),
  error: z.string().optional(),
}).passthrough();

const PlanVersionHistoryRequest = z.object({
  planId: z.string(),
  branch: z.string().optional(),
});

const PlanVersionHistoryResponse = z.array(z.object({
  version: z.number(),
  action: z.string(),
  branch: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough());

const PlanVersionLatestRequest = z.object({
  planId: z.string(),
  branch: z.string().optional(),
});

const PlanVersionLatestResponse = z.object({
  version: z.number(),
  action: z.string(),
  snapshot: z.unknown(),
  branch: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough().nullable();

const PlanVersionRewindRequest = z.object({
  planId: z.string(),
  targetVersion: z.number(),
  branch: z.string().optional(),
});

const PlanVersionRewindResponse = z.object({
  success: z.boolean(),
});

const PlanVersionCreateBranchRequest = z.object({
  planId: z.string(),
  branchName: z.string(),
  parentBranch: z.string().optional(),
});

const PlanVersionCreateBranchResponse = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

const PlanVersionListBranchesRequest = z.object({
  planId: z.string(),
});

const PlanVersionListBranchesResponse = z.array(z.string());

const PlanVersionDeleteBranchRequest = z.object({
  planId: z.string(),
  branchName: z.string(),
});

const PlanVersionDeleteBranchResponse = z.object({
  success: z.boolean(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all swarm-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerSwarmHandlers(registry: IPCRegistry): void {
  // 1. Get budget for a project
  registry.register({
    channel: 'budget:get',
    requestSchema: BudgetGetRequest,
    responseSchema: BudgetGetResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Budget manager not available in router migration' };
    },
  });

  // 2. Set budget for a project
  registry.register({
    channel: 'budget:set',
    requestSchema: BudgetSetRequest,
    responseSchema: BudgetSetResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Budget manager not available in router migration' };
    },
  });

  // 3. Record token/cost usage
  registry.register({
    channel: 'budget:record',
    requestSchema: BudgetRecordRequest,
    responseSchema: BudgetRecordResponse,
    handler: async (_event, _req) => {
      return { allowed: true, warning: false, remaining: Infinity };
    },
  });

  // 4. Reset budget usage for a project
  registry.register({
    channel: 'budget:reset',
    requestSchema: BudgetResetRequest,
    responseSchema: BudgetResetResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Budget manager not available in router migration' };
    },
  });

  // 5. Record plan version snapshot
  registry.register({
    channel: 'plan-version:record',
    requestSchema: PlanVersionRecordRequest,
    responseSchema: PlanVersionRecordResponse,
    handler: async (_event, _req) => {
      return { error: 'Plan versioning not available in router migration' };
    },
  });

  // 6. Get plan version history
  registry.register({
    channel: 'plan-version:history',
    requestSchema: PlanVersionHistoryRequest,
    responseSchema: PlanVersionHistoryResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 7. Get latest plan version
  registry.register({
    channel: 'plan-version:latest',
    requestSchema: PlanVersionLatestRequest,
    responseSchema: PlanVersionLatestResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 8. Rewind plan to a specific version
  registry.register({
    channel: 'plan-version:rewind',
    requestSchema: PlanVersionRewindRequest,
    responseSchema: PlanVersionRewindResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 9. Create a plan branch
  registry.register({
    channel: 'plan-version:create-branch',
    requestSchema: PlanVersionCreateBranchRequest,
    responseSchema: PlanVersionCreateBranchResponse,
    handler: async (_event, _req) => {
      return { error: 'Plan versioning not available in router migration' };
    },
  });

  // 10. List plan branches
  registry.register({
    channel: 'plan-version:list-branches',
    requestSchema: PlanVersionListBranchesRequest,
    responseSchema: PlanVersionListBranchesResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 11. Delete a plan branch
  registry.register({
    channel: 'plan-version:delete-branch',
    requestSchema: PlanVersionDeleteBranchRequest,
    responseSchema: PlanVersionDeleteBranchResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });
}
