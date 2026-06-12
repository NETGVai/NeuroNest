/**
 * Agent Domain IPC Handlers
 *
 * Handles agent management IPC operations: listing agents, getting details,
 * prompt management, model configuration, memory, and multica integration.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

const AgentEntry = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  model: z.string(),
  department: z.string(),
  emoji: z.string(),
  status: z.string(),
});

const GetAgentsResponse = z.array(AgentEntry);

const DepartmentEntry = z.object({
  name: z.string(),
  icon: z.string(),
  count: z.number(),
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    emoji: z.string(),
    specialty: z.string(),
    role: z.string(),
    status: z.string(),
  })),
});

const GetDepartmentsResponse = z.array(DepartmentEntry);

const AgentIdRequest = z.object({
  agentId: z.string(),
});

const GetAgentDetailsResponse = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  model: z.string(),
  systemPrompt: z.string().optional(),
  tools: z.unknown().optional(),
}).nullable();


const GetAgentPromptRequest = z.object({
  agent: z.string().optional(),
  name: z.string().optional(),
  section: z.string().optional(),
}).passthrough();

const GetAgentPromptResponse = z.unknown();

const GetAgentModelRequest = z.object({
  agent: z.string().optional(),
  agentId: z.string().optional(),
}).passthrough();

const GetAgentModelResponse = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  error: z.string().optional(),
}).nullable();

const AgentMemoryStatusResponse = z.object({
  available: z.boolean(),
  healthy: z.boolean(),
});

const AgentMemorySearchRequest = z.object({
  project: z.string(),
  query: z.string(),
});

const AgentMemorySearchResponse = z.array(z.object({
  id: z.string().optional(),
  content: z.string(),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

const AgentMemoryRecentRequest = z.object({
  project: z.string(),
});

const AgentMemoryRecentResponse = z.array(z.object({
  id: z.string().optional(),
  content: z.string(),
  createdAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

const AgentMemoryForgetRequest = z.object({
  project: z.string(),
});

const AgentMemoryForgetResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const MulticaTasksRequest = z.object({
  projectId: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

const MulticaTasksResponse = z.object({
  success: z.boolean(),
  tasks: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const MulticaAgentTasksRequest = z.object({
  agentId: z.string(),
});

const MulticaAgentTasksResponse = z.object({
  success: z.boolean(),
  tasks: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const MulticaAddCommentRequest = z.object({
  taskId: z.string(),
  comment: z.string(),
  author: z.string().optional(),
});

const MulticaAddCommentResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const MulticaGetSkillsRequest = z.object({
  agentId: z.string(),
});

const MulticaGetSkillsResponse = z.object({
  success: z.boolean(),
  skills: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const MulticaAssignSkillRequest = z.object({
  agentId: z.string(),
  skillId: z.string(),
});

const MulticaAssignSkillResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const MulticaGetRuntimesResponse = z.object({
  success: z.boolean(),
  runtimes: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const MulticaRegisterRuntimeRequest = z.object({
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const MulticaRegisterRuntimeResponse = z.object({
  success: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
});

const MulticaTaskStatsRequest = z.object({
  projectId: z.string().optional(),
}).passthrough();

const MulticaTaskStatsResponse = z.object({
  success: z.boolean(),
  stats: z.unknown().optional(),
  error: z.string().optional(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all agent-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerAgentHandlers(registry: IPCRegistry): void {
  // 1. List all agents
  registry.register({
    channel: 'get-agents',
    requestSchema: EmptyRequest,
    responseSchema: GetAgentsResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 2. Get departments with agents
  registry.register({
    channel: 'get-departments',
    requestSchema: EmptyRequest,
    responseSchema: GetDepartmentsResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 3. Get agent details
  registry.register({
    channel: 'get-agent-details',
    requestSchema: AgentIdRequest,
    responseSchema: GetAgentDetailsResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 4. Get agent prompt (supports section filtering)
  registry.register({
    channel: 'get-agent-prompt',
    requestSchema: GetAgentPromptRequest,
    responseSchema: GetAgentPromptResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 5. Get agent model configuration
  registry.register({
    channel: 'get-agent-model',
    requestSchema: GetAgentModelRequest,
    responseSchema: GetAgentModelResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 6. Agent memory status
  registry.register({
    channel: 'agentmemory:status',
    requestSchema: EmptyRequest,
    responseSchema: AgentMemoryStatusResponse,
    handler: async (_event, _req) => {
      return { available: false, healthy: false };
    },
  });

  // 7. Search agent memory
  registry.register({
    channel: 'agentmemory:search',
    requestSchema: AgentMemorySearchRequest,
    responseSchema: AgentMemorySearchResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 8. Get recent agent memory entries
  registry.register({
    channel: 'agentmemory:recent',
    requestSchema: AgentMemoryRecentRequest,
    responseSchema: AgentMemoryRecentResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 9. Forget agent memory for a project
  registry.register({
    channel: 'agentmemory:forget',
    requestSchema: AgentMemoryForgetRequest,
    responseSchema: AgentMemoryForgetResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Agent memory not available' };
    },
  });

  // 10. Get multica tasks
  registry.register({
    channel: 'multica-get-tasks',
    requestSchema: MulticaTasksRequest,
    responseSchema: MulticaTasksResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 11. Get tasks for a specific agent
  registry.register({
    channel: 'multica-get-agent-tasks',
    requestSchema: MulticaAgentTasksRequest,
    responseSchema: MulticaAgentTasksResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 12. Add comment to a task
  registry.register({
    channel: 'multica-add-task-comment',
    requestSchema: MulticaAddCommentRequest,
    responseSchema: MulticaAddCommentResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 13. Get skills for an agent
  registry.register({
    channel: 'multica-get-agent-skills',
    requestSchema: MulticaGetSkillsRequest,
    responseSchema: MulticaGetSkillsResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 14. Assign skill to an agent
  registry.register({
    channel: 'multica-assign-skill',
    requestSchema: MulticaAssignSkillRequest,
    responseSchema: MulticaAssignSkillResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 15. Get registered runtimes
  registry.register({
    channel: 'multica-get-runtimes',
    requestSchema: EmptyRequest,
    responseSchema: MulticaGetRuntimesResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 16. Register a new runtime
  registry.register({
    channel: 'multica-register-runtime',
    requestSchema: MulticaRegisterRuntimeRequest,
    responseSchema: MulticaRegisterRuntimeResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });

  // 17. Get task statistics
  registry.register({
    channel: 'multica-get-task-stats',
    requestSchema: MulticaTaskStatsRequest,
    responseSchema: MulticaTaskStatsResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Enhanced coordinator not available' };
    },
  });
}
