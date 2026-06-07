/**
 * Zod validation schemas for Sandbox_Manager types.
 *
 * Requirements: 9.1
 */

import { z } from 'zod';

// ─── Sandbox_Manager ────────────────────────────────────────────

export const SandboxBackendSchema = z.enum(['local', 'docker']);

export const SandboxSessionSchema = z.object({
  id: z.string().min(1),
  backend: SandboxBackendSchema,
  uploadsDir: z.string().min(1),
  workspaceDir: z.string().min(1),
  outputsDir: z.string().min(1),
  status: z.enum(['running', 'completed', 'timed_out', 'error']),
  createdAt: z.coerce.date(),
  timeoutMs: z.number().int().positive(),
});
