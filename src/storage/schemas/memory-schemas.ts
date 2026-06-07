/**
 * Zod validation schemas for Memory_Store types.
 *
 * Requirements: 4.1
 */

import { z } from 'zod';

// ─── Memory_Store ───────────────────────────────────────────────

export const MemoryCategorySchema = z.enum(['profile', 'preference', 'knowledge']);

export const MemoryFactSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  category: MemoryCategorySchema,
  key: z.string().min(1),
  value: z.string(),
  relevanceScore: z.number(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
