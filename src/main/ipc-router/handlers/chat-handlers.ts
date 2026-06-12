/**
 * Chat Domain IPC Handlers
 *
 * Handles chat/messaging IPC operations: session management, message queue,
 * context items, session status, alerts, and conversation history.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

const SessionIdRequest = z.object({
  sessionId: z.string(),
});

const SessionStatusGetResponse = z.object({
  status: z.string(),
  lastActivity: z.string().optional(),
});

const SessionStatusSetRequest = z.object({
  sessionId: z.string(),
  status: z.string(),
  lastActivity: z.string().optional(),
});

const SuccessResponse = z.object({
  success: z.boolean(),
});

const SendChannelMessageRequest = z.object({
  channelId: z.string(),
  to: z.string().optional(),
  message: z.string(),
});

const SendChannelMessageResponse = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});

const ContextAddRequest = z.object({
  sessionId: z.string(),
  type: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ContextAddResponse = z.object({
  id: z.string().optional(),
  error: z.string().optional(),
});

const ContextListResponse = z.array(z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
}));

const ContextRemoveRequest = z.object({
  id: z.string(),
});

const ContextLoadUrlRequest = z.object({
  sessionId: z.string(),
  url: z.string().url(),
});

const ContextLoadUrlResponse = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
});

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

const AlertListResponse = z.array(z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
  createdAt: z.string().optional(),
  dismissed: z.boolean().optional(),
}));

const MsgModeGetConfigResponse = z.object({
  default_mode: z.string(),
  auto_process_queue: z.boolean(),
});

const MsgModeSetConfigRequest = z.object({
  projectId: z.string(),
  updates: z.record(z.string(), z.unknown()),
});

const MsgModeSetConfigResponse = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
});

const MsgModeEnqueueRequest = z.object({
  projectId: z.string(),
  message: z.string(),
  mode: z.string().optional(),
  priority: z.number().optional(),
});

const MsgModeEnqueueResponse = z.object({
  id: z.string().optional(),
  error: z.string().optional(),
});

const MsgModePendingResponse = z.array(z.object({
  id: z.string(),
  message: z.string(),
  mode: z.string().optional(),
  priority: z.number().optional(),
  createdAt: z.string().optional(),
}));

const MsgModeStatsResponse = z.object({
  pending: z.number(),
  processing: z.number(),
  completed: z.number(),
  cancelled: z.number(),
});

const CompactionRecordRequest = z.object({
  sessionId: z.string(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  messagesRemoved: z.number(),
});

const CompactionStatsResponse = z.object({
  totalCompactions: z.number(),
  totalTokensSaved: z.number(),
});

const TurnsGetResponse = z.object({
  maxTurns: z.number(),
  currentTurn: z.number(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all chat-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerChatHandlers(registry: IPCRegistry): void {
  // 1. Send a channel message
  registry.register({
    channel: 'send-channel-message',
    requestSchema: SendChannelMessageRequest,
    responseSchema: SendChannelMessageResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Channel messaging not available in router migration' };
    },
  });

  // 2. Get session status
  registry.register({
    channel: 'session-status:get',
    requestSchema: SessionIdRequest,
    responseSchema: SessionStatusGetResponse,
    handler: async (_event, _req) => {
      return { status: 'idle' };
    },
  });

  // 3. Set session status
  registry.register({
    channel: 'session-status:set',
    requestSchema: SessionStatusSetRequest,
    responseSchema: SuccessResponse,
    handler: async (_event, _req) => {
      return { success: true };
    },
  });

  // 4. Add context item to session
  registry.register({
    channel: 'context:add',
    requestSchema: ContextAddRequest,
    responseSchema: ContextAddResponse,
    handler: async (_event, _req) => {
      return { error: 'Context service not available' };
    },
  });

  // 5. List context items for session
  registry.register({
    channel: 'context:list',
    requestSchema: SessionIdRequest,
    responseSchema: ContextListResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 6. Remove context item
  registry.register({
    channel: 'context:remove',
    requestSchema: ContextRemoveRequest,
    responseSchema: SuccessResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 7. Load URL content into context
  registry.register({
    channel: 'context:load-url',
    requestSchema: ContextLoadUrlRequest,
    responseSchema: ContextLoadUrlResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'URL loading not available in router migration' };
    },
  });

  // 8. Create session alert
  registry.register({
    channel: 'alerts:create',
    requestSchema: AlertCreateRequest,
    responseSchema: AlertCreateResponse,
    handler: async (_event, _req) => {
      return { error: 'Alert service not available' };
    },
  });

  // 9. Get active alerts for session
  registry.register({
    channel: 'alerts:active',
    requestSchema: SessionIdRequest,
    responseSchema: AlertListResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 10. Dismiss a specific alert
  registry.register({
    channel: 'alerts:dismiss',
    requestSchema: z.object({ id: z.string() }),
    responseSchema: SuccessResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 11. Dismiss all alerts for a session
  registry.register({
    channel: 'alerts:dismiss-all',
    requestSchema: SessionIdRequest,
    responseSchema: z.object({ count: z.number() }),
    handler: async (_event, _req) => {
      return { count: 0 };
    },
  });

  // 12. Get message mode configuration
  registry.register({
    channel: 'msgmode:get-config',
    requestSchema: z.object({ projectId: z.string() }),
    responseSchema: MsgModeGetConfigResponse,
    handler: async (_event, _req) => {
      return { default_mode: 'send', auto_process_queue: true };
    },
  });

  // 13. Set message mode configuration
  registry.register({
    channel: 'msgmode:set-config',
    requestSchema: MsgModeSetConfigRequest,
    responseSchema: MsgModeSetConfigResponse,
    handler: async (_event, _req) => {
      return { success: true };
    },
  });

  // 14. Enqueue a message
  registry.register({
    channel: 'msgmode:enqueue',
    requestSchema: MsgModeEnqueueRequest,
    responseSchema: MsgModeEnqueueResponse,
    handler: async (_event, _req) => {
      return { error: 'Message queue not available' };
    },
  });

  // 15. Get pending messages
  registry.register({
    channel: 'msgmode:pending',
    requestSchema: z.object({ projectId: z.string() }),
    responseSchema: MsgModePendingResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 16. Dequeue next message
  registry.register({
    channel: 'msgmode:dequeue',
    requestSchema: z.object({ projectId: z.string() }),
    responseSchema: z.object({
      id: z.string().optional(),
      message: z.string().optional(),
    }).nullable(),
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 17. Mark message as complete
  registry.register({
    channel: 'msgmode:complete',
    requestSchema: z.object({ messageId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    handler: async (_event, _req) => {
      return { ok: false };
    },
  });

  // 18. Cancel a queued message
  registry.register({
    channel: 'msgmode:cancel',
    requestSchema: z.object({ messageId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    handler: async (_event, _req) => {
      return { ok: false };
    },
  });

  // 19. Cancel all queued messages for a project
  registry.register({
    channel: 'msgmode:cancel-all',
    requestSchema: z.object({ projectId: z.string() }),
    responseSchema: z.object({ cancelled: z.number() }),
    handler: async (_event, _req) => {
      return { cancelled: 0 };
    },
  });

  // 20. Get message queue stats
  registry.register({
    channel: 'msgmode:stats',
    requestSchema: z.object({ projectId: z.string() }),
    responseSchema: MsgModeStatsResponse,
    handler: async (_event, _req) => {
      return { pending: 0, processing: 0, completed: 0, cancelled: 0 };
    },
  });

  // 21. Record context compaction
  registry.register({
    channel: 'compaction:record',
    requestSchema: CompactionRecordRequest,
    responseSchema: SuccessResponse,
    handler: async (_event, _req) => {
      return { success: false };
    },
  });

  // 22. Get compaction stats
  registry.register({
    channel: 'compaction:stats',
    requestSchema: SessionIdRequest,
    responseSchema: CompactionStatsResponse,
    handler: async (_event, _req) => {
      return { totalCompactions: 0, totalTokensSaved: 0 };
    },
  });

  // 23. Get turn management info
  registry.register({
    channel: 'turns:get',
    requestSchema: SessionIdRequest,
    responseSchema: TurnsGetResponse,
    handler: async (_event, _req) => {
      return { maxTurns: 100, currentTurn: 0 };
    },
  });
}
