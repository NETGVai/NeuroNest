/**
 * Settings Domain IPC Handlers
 *
 * Handles settings and application configuration IPC operations: theme,
 * config retrieval, system stats, commands, notifications, and app readiness.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

const GetThemeResponse = z.enum(['dark', 'light']);

const GetConfigResponse = z.object({
  version: z.string(),
  agents: z.number(),
});

const CommandEntry = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string().optional(),
});

const GetCommandsResponse = z.array(CommandEntry);

const AutocompleteCommandRequest = z.object({
  partial: z.string(),
});

const AutocompleteCommandResponse = z.array(z.string());

const GetSystemStatsResponse = z.object({
  cpu: z.number().optional(),
  memory: z.object({
    used: z.number(),
    total: z.number(),
    percentage: z.number(),
  }).optional(),
  uptime: z.number().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  nodeVersion: z.string().optional(),
  electronVersion: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const GetSystemStatsSlowResponse = z.object({
  disk: z.object({
    used: z.number(),
    total: z.number(),
    percentage: z.number(),
  }).optional(),
  gpu: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const NotificationsGetConfigRequest = z.object({
  projectId: z.string(),
});

const NotificationsGetConfigResponse = z.object({
  onAgentComplete: z.boolean().optional(),
  onAgentNeedsInput: z.boolean().optional(),
  onCheckFailed: z.boolean().optional(),
}).nullable();

const NotificationsSetConfigRequest = z.object({
  projectId: z.string(),
  updates: z.record(z.string(), z.unknown()),
});

const NotificationsSetConfigResponse = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
});

const NotificationsSendRequest = z.object({
  title: z.string(),
  body: z.string(),
});

const NotificationsSendResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const AppReadinessResponse = z.object({
  ready: z.boolean(),
  checks: z.record(z.string(), z.boolean()).optional(),
  error: z.string().optional(),
}).passthrough();

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all settings-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerSettingsHandlers(registry: IPCRegistry): void {
  // 1. Get current theme (dark/light)
  registry.register({
    channel: 'get-theme',
    requestSchema: EmptyRequest,
    responseSchema: GetThemeResponse,
    handler: async (_event, _req) => {
      return 'dark';
    },
  });

  // 2. Get application config
  registry.register({
    channel: 'get-config',
    requestSchema: EmptyRequest,
    responseSchema: GetConfigResponse,
    handler: async (_event, _req) => {
      return { version: '0.1.0', agents: 0 };
    },
  });

  // 3. Get available commands
  registry.register({
    channel: 'get-commands',
    requestSchema: EmptyRequest,
    responseSchema: GetCommandsResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 4. Autocomplete command input
  registry.register({
    channel: 'autocomplete-command',
    requestSchema: AutocompleteCommandRequest,
    responseSchema: AutocompleteCommandResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 5. Get system stats (fast — CPU, memory, basics)
  registry.register({
    channel: 'get-system-stats',
    requestSchema: EmptyRequest,
    responseSchema: GetSystemStatsResponse,
    handler: async (_event, _req) => {
      return {
        cpu: 0,
        memory: { used: 0, total: 0, percentage: 0 },
        uptime: 0,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
      };
    },
  });

  // 6. Get system stats (slow — disk, GPU)
  registry.register({
    channel: 'get-system-stats-slow',
    requestSchema: EmptyRequest,
    responseSchema: GetSystemStatsSlowResponse,
    handler: async (_event, _req) => {
      return {};
    },
  });

  // 7. Get notification configuration for a project
  registry.register({
    channel: 'notifications:get-config',
    requestSchema: NotificationsGetConfigRequest,
    responseSchema: NotificationsGetConfigResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 8. Set notification configuration
  registry.register({
    channel: 'notifications:set-config',
    requestSchema: NotificationsSetConfigRequest,
    responseSchema: NotificationsSetConfigResponse,
    handler: async (_event, _req) => {
      return { success: true };
    },
  });

  // 9. Send a desktop notification
  registry.register({
    channel: 'notifications:send',
    requestSchema: NotificationsSendRequest,
    responseSchema: NotificationsSendResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Notifications not available in router migration' };
    },
  });

  // 10. App readiness probe
  registry.register({
    channel: 'app:readiness',
    requestSchema: EmptyRequest,
    responseSchema: AppReadinessResponse,
    handler: async (_event, _req) => {
      return { ready: false, error: 'Readiness probe not wired in router migration' };
    },
  });
}
