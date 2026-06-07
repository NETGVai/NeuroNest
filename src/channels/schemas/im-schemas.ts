/**
 * Zod validation schemas for IM_Gateway types.
 *
 * Requirements: 5.1
 */

import { z } from 'zod';

// ─── IM_Gateway ─────────────────────────────────────────────────

export const IMConfigSchema = z.object({
  platform: z.enum(['telegram', 'slack', 'discord']),
  credentials: z.record(z.string(), z.string()),
});

export const IMTaskSchema = z.object({
  channelId: z.string().min(1),
  platform: z.string().min(1),
  from: z.string().min(1),
  content: z.string(),
  threadId: z.string().optional(),
});
