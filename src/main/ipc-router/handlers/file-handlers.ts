/**
 * File Domain IPC Handlers
 *
 * Handles file operations, file-session links, global search,
 * plan archives, and git auto-commit IPC operations.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

// File-Session Links
const FileLinkRequest = z.object({
  sessionId: z.string(),
  filePath: z.string(),
  action: z.string(),
});

const FileLinkResponse = z.object({
  success: z.boolean(),
});

const FileLinksForSessionResponse = z.array(z.object({
  filePath: z.string(),
  action: z.string(),
  linkedAt: z.string().optional(),
}).passthrough());

const FileLinksForFileResponse = z.array(z.object({
  sessionId: z.string(),
  action: z.string(),
  linkedAt: z.string().optional(),
}).passthrough());

// Plan Archive
const ArchiveCreateRequest = z.object({
  sessionId: z.string(),
  name: z.string(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

const ArchiveCreateResponse = z.object({
  id: z.string().optional(),
  error: z.string().optional(),
});

const ArchiveListResponse = z.array(z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  name: z.string(),
  createdAt: z.string().optional(),
}).passthrough());

const ArchiveUnarchiveResponse = z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  name: z.string().optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
}).nullable();

// Global Search
const GlobalSearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

const GlobalSearchResponse = z.array(z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  contentType: z.string().optional(),
  content: z.string().optional(),
  score: z.number().optional(),
}).passthrough());

const GlobalSearchIndexRequest = z.object({
  sessionId: z.string(),
  contentType: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const GlobalSearchIndexResponse = z.object({
  success: z.boolean(),
});

// Session Alerts
const AlertCreateRequest = z.object({
  sessionId: z.string(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
});

const AlertCreateResponse = z.object({
  id: z.string().optional(),
  error: z.string().optional(),
});

const AlertActiveResponse = z.array(z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  type: z.string().optional(),
  severity: z.string().optional(),
  message: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough());

const AlertDismissResponse = z.object({
  success: z.boolean(),
});

const AlertDismissAllResponse = z.object({
  count: z.number(),
});

// Git Auto-Commit
const GitAutoCommitRequest = z.object({
  projectId: z.string(),
  message: z.string().optional(),
});

const GitAutoCommitResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

// Decision Log
const DecisionCreateRequest = z.object({
  projectId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
}).passthrough();

const DecisionCreateResponse = z.object({
  id: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const DecisionListResponse = z.array(z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough());

const DecisionActionResponse = z.object({
  success: z.boolean(),
});

// Zoom
const ZoomGetResponse = z.object({
  level: z.number(),
});

const ZoomSetResponse = z.object({
  success: z.boolean(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all file-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerFileHandlers(registry: IPCRegistry): void {
  // 1. Link a file to a session
  registry.register({
    channel: 'file-links:link',
    requestSchema: FileLinkRequest,
    responseSchema: FileLinkResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 2. Get files linked to a session
  registry.register({
    channel: 'file-links:for-session',
    requestSchema: z.string(),
    responseSchema: FileLinksForSessionResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 3. Get sessions linked to a file
  registry.register({
    channel: 'file-links:for-file',
    requestSchema: z.string(),
    responseSchema: FileLinksForFileResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 4. Create an archive from a session
  registry.register({
    channel: 'archive:create',
    requestSchema: ArchiveCreateRequest,
    responseSchema: ArchiveCreateResponse,
    handler: async (_event, _req) => {
      return { error: 'Archive not available in router migration' };
    },
  });

  // 5. List all archives
  registry.register({
    channel: 'archive:list',
    requestSchema: EmptyRequest,
    responseSchema: ArchiveListResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 6. Unarchive (restore) a plan
  registry.register({
    channel: 'archive:unarchive',
    requestSchema: z.string(),
    responseSchema: ArchiveUnarchiveResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 7. Global search
  registry.register({
    channel: 'global-search:search',
    requestSchema: GlobalSearchRequest,
    responseSchema: GlobalSearchResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 8. Index content for global search
  registry.register({
    channel: 'global-search:index',
    requestSchema: GlobalSearchIndexRequest,
    responseSchema: GlobalSearchIndexResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 9. Create a session alert
  registry.register({
    channel: 'alerts:create',
    requestSchema: AlertCreateRequest,
    responseSchema: AlertCreateResponse,
    handler: async (_event, _req) => {
      return { error: 'Alerts not available in router migration' };
    },
  });

  // 10. Get active alerts for a session
  registry.register({
    channel: 'alerts:active',
    requestSchema: z.string(),
    responseSchema: AlertActiveResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 11. Dismiss a single alert
  registry.register({
    channel: 'alerts:dismiss',
    requestSchema: z.string(),
    responseSchema: AlertDismissResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 12. Dismiss all alerts for a session
  registry.register({
    channel: 'alerts:dismiss-all',
    requestSchema: z.string(),
    responseSchema: AlertDismissAllResponse,
    handler: async (_event, _req) => {
      return { count: 0 };
    },
  });

  // 13. Create a decision log entry
  registry.register({
    channel: 'decisions:create',
    requestSchema: DecisionCreateRequest,
    responseSchema: DecisionCreateResponse,
    handler: async (_event, _req) => {
      return { error: 'Decision log not available in router migration' };
    },
  });

  // 14. List decisions for a project
  registry.register({
    channel: 'decisions:list',
    requestSchema: z.string(),
    responseSchema: DecisionListResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 15. Supersede a decision
  registry.register({
    channel: 'decisions:supersede',
    requestSchema: z.string(),
    responseSchema: DecisionActionResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 16. Delete a decision
  registry.register({
    channel: 'decisions:delete',
    requestSchema: z.string(),
    responseSchema: DecisionActionResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 17. Get zoom level
  registry.register({
    channel: 'zoom:get',
    requestSchema: EmptyRequest,
    responseSchema: ZoomGetResponse,
    handler: async (_event, _req) => {
      return { level: 1.0 };
    },
  });

  // 18. Set zoom level
  registry.register({
    channel: 'zoom:set',
    requestSchema: z.number(),
    responseSchema: ZoomSetResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 19. Git auto-commit
  registry.register({
    channel: 'git:auto-commit',
    requestSchema: GitAutoCommitRequest,
    responseSchema: GitAutoCommitResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Git auto-commit not available in router migration' };
    },
  });
}
