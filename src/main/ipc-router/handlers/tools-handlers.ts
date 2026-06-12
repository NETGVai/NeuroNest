/**
 * Tools Domain IPC Handlers
 *
 * Handles tool execution, sandbox operations, tool permissions,
 * context condensation, and browser/web interactions.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

// Tool Execution
const ToolExecuteRequest = z.object({
  tool: z.string(),
  callId: z.string().optional(),
  command: z.string().optional(),
  filePath: z.string().optional(),
  content: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  timeoutMs: z.number().optional(),
}).passthrough();

const ToolExecuteResponse = z.object({
  success: z.boolean(),
  tool: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
}).passthrough();

// Tool Permissions
const ToolPermsGetRequest = z.object({
  projectId: z.string(),
  toolName: z.string(),
});

const ToolPermsGetResponse = z.object({
  level: z.string(),
});

const ToolPermsSetRequest = z.object({
  projectId: z.string(),
  toolName: z.string(),
  level: z.string(),
});

const ToolPermsSetResponse = z.object({
  success: z.boolean(),
});

const ToolPermsListResponse = z.array(z.object({
  toolName: z.string(),
  level: z.string(),
}).passthrough());

// Sandbox
const SandboxCheckResponse = z.boolean();

const SandboxCreateRequest = z.object({
  projectId: z.string(),
  projectPath: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SandboxCreateResponse = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const SandboxExecuteRequest = z.object({
  sessionId: z.string(),
  command: z.string(),
}).passthrough();

const SandboxExecuteResponse = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  exitCode: z.number().optional(),
  error: z.string().optional(),
}).passthrough();

const SandboxFileRequest = z.object({
  sessionId: z.string(),
  operation: z.record(z.string(), z.unknown()),
}).passthrough();

const SandboxFileResponse = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
}).passthrough();

const SandboxDestroyRequest = z.object({
  sessionId: z.string(),
});

const SandboxDestroyResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const SandboxListResponse = z.object({
  success: z.boolean(),
  sessions: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const SandboxInstallDockerResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

// Context Condenser
const CondenserCondenseRequest = z.object({
  messages: z.array(z.unknown()),
}).passthrough();

const CondenserCondenseResponse = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const CondenserCheckRequest = z.object({
  messages: z.array(z.unknown()),
}).passthrough();

const CondenserCheckResponse = z.object({
  needsCondensation: z.boolean(),
});

const CondenserConfigRequest = z.object({
  set: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const CondenserConfigResponse = z.object({
  config: z.record(z.string(), z.unknown()),
});

// Browser / Web
const BrowserFetchRequest = z.object({
  url: z.string(),
}).passthrough();

const BrowserFetchResponse = z.object({
  success: z.boolean(),
  url: z.string(),
  title: z.string(),
  content: z.string(),
  links: z.array(z.unknown()),
  error: z.string().optional(),
  durationMs: z.number().optional(),
}).passthrough();

const BrowserSearchRequest = z.object({
  query: z.string(),
}).passthrough();

const BrowserSearchResponse = z.object({
  success: z.boolean(),
  url: z.string(),
  title: z.string(),
  content: z.string(),
  links: z.array(z.unknown()),
  error: z.string().optional(),
  durationMs: z.number().optional(),
}).passthrough();

const BrowserSaveTabRequest = z.object({
  projectId: z.string(),
  url: z.string(),
  title: z.string().optional(),
});

const BrowserSaveTabResponse = z.object({
  success: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
});

const BrowserGetTabsResponse = z.array(z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().optional(),
  project_id: z.string().optional(),
  created_at: z.string().optional(),
}).passthrough());

const BrowserDeleteTabResponse = z.object({
  success: z.boolean(),
});

// Adversary Reviewer
const AdversaryReviewRequest = z.object({
  sessionId: z.string(),
  actionType: z.string(),
  actionDetail: z.string(),
});

const AdversaryReviewResponse = z.object({
  flagged: z.boolean().optional(),
  severity: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const AdversaryFlagsResponse = z.array(z.object({
  id: z.string().optional(),
  actionType: z.string().optional(),
  severity: z.string().optional(),
  reason: z.string().optional(),
}).passthrough());

const AdversaryStatsResponse = z.object({
  total: z.number(),
  flagged: z.number(),
  critical: z.number(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all tools-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerToolsHandlers(registry: IPCRegistry): void {
  // 1. Execute a tool
  registry.register({
    channel: 'tool:execute',
    requestSchema: ToolExecuteRequest,
    responseSchema: ToolExecuteResponse,
    handler: async (_event, _req) => {
      return { success: false, tool: 'unknown', output: '', error: 'Tool execution not wired in router migration', durationMs: 0 };
    },
  });

  // 2. Get tool permission level
  registry.register({
    channel: 'tool-perms:get',
    requestSchema: ToolPermsGetRequest,
    responseSchema: ToolPermsGetResponse,
    handler: async (_event, _req) => {
      return { level: 'confirm' };
    },
  });

  // 3. Set tool permission level
  registry.register({
    channel: 'tool-perms:set',
    requestSchema: ToolPermsSetRequest,
    responseSchema: ToolPermsSetResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 4. List tool permissions for a project
  registry.register({
    channel: 'tool-perms:list',
    requestSchema: z.string(),
    responseSchema: ToolPermsListResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 5. Check sandbox availability
  registry.register({
    channel: 'sandbox:check',
    requestSchema: EmptyRequest,
    responseSchema: SandboxCheckResponse,
    handler: async (_event, _req) => {
      return false;
    },
  });

  // 6. Create a sandbox session
  registry.register({
    channel: 'sandbox:create',
    requestSchema: SandboxCreateRequest,
    responseSchema: SandboxCreateResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Sandbox not available in router migration' };
    },
  });

  // 7. Execute command in sandbox
  registry.register({
    channel: 'sandbox:execute',
    requestSchema: SandboxExecuteRequest,
    responseSchema: SandboxExecuteResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Sandbox not available in router migration' };
    },
  });

  // 8. File operation in sandbox
  registry.register({
    channel: 'sandbox:file',
    requestSchema: SandboxFileRequest,
    responseSchema: SandboxFileResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Sandbox not available in router migration' };
    },
  });

  // 9. Destroy sandbox session
  registry.register({
    channel: 'sandbox:destroy',
    requestSchema: SandboxDestroyRequest,
    responseSchema: SandboxDestroyResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Sandbox not available in router migration' };
    },
  });

  // 10. List active sandbox sessions
  registry.register({
    channel: 'sandbox:list',
    requestSchema: EmptyRequest,
    responseSchema: SandboxListResponse,
    handler: async (_event, _req) => {
      return { success: false, sessions: [], error: 'Sandbox not available in router migration' };
    },
  });

  // 11. Install Docker for sandbox
  registry.register({
    channel: 'sandbox:install-docker',
    requestSchema: EmptyRequest,
    responseSchema: SandboxInstallDockerResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Docker installation not available in router migration' };
    },
  });

  // 12. Condense context messages
  registry.register({
    channel: 'condenser:condense',
    requestSchema: CondenserCondenseRequest,
    responseSchema: CondenserCondenseResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Condenser not available in router migration' };
    },
  });

  // 13. Check if condensation is needed
  registry.register({
    channel: 'condenser:check',
    requestSchema: CondenserCheckRequest,
    responseSchema: CondenserCheckResponse,
    handler: async (_event, _req) => {
      return { needsCondensation: false };
    },
  });

  // 14. Get/set condenser configuration
  registry.register({
    channel: 'condenser:config',
    requestSchema: CondenserConfigRequest,
    responseSchema: CondenserConfigResponse,
    handler: async (_event, _req) => {
      return { config: {} };
    },
  });

  // 15. Fetch a web page
  registry.register({
    channel: 'browser:fetch',
    requestSchema: BrowserFetchRequest,
    responseSchema: BrowserFetchResponse,
    handler: async (_event, _req) => {
      return { success: false, url: '', title: '', content: '', links: [], error: 'Browser not available in router migration', durationMs: 0 };
    },
  });

  // 16. Web search
  registry.register({
    channel: 'browser:search',
    requestSchema: BrowserSearchRequest,
    responseSchema: BrowserSearchResponse,
    handler: async (_event, _req) => {
      return { success: false, url: '', title: '', content: '', links: [], error: 'Browser not available in router migration', durationMs: 0 };
    },
  });

  // 17. Save browser tab
  registry.register({
    channel: 'browser:save-tab',
    requestSchema: BrowserSaveTabRequest,
    responseSchema: BrowserSaveTabResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Browser tabs not available in router migration' };
    },
  });

  // 18. Get saved browser tabs
  registry.register({
    channel: 'browser:get-tabs',
    requestSchema: z.string(),
    responseSchema: BrowserGetTabsResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 19. Delete a browser tab
  registry.register({
    channel: 'browser:delete-tab',
    requestSchema: z.string(),
    responseSchema: BrowserDeleteTabResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 20. Adversary reviewer — review an action
  registry.register({
    channel: 'adversary:review',
    requestSchema: AdversaryReviewRequest,
    responseSchema: AdversaryReviewResponse,
    handler: async (_event, _req) => {
      return { error: 'Adversary reviewer not available in router migration' };
    },
  });

  // 21. Adversary reviewer — get flags for a session
  registry.register({
    channel: 'adversary:flags',
    requestSchema: z.string(),
    responseSchema: AdversaryFlagsResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 22. Adversary reviewer — get stats for a session
  registry.register({
    channel: 'adversary:stats',
    requestSchema: z.string(),
    responseSchema: AdversaryStatsResponse,
    handler: async (_event, _req) => {
      return { total: 0, flagged: 0, critical: 0 };
    },
  });
}
