/**
 * Zod validation schemas for DeerFlow pipeline types.
 *
 * Requirements: 2.6, 4.1
 */

import { z } from 'zod';

// ─── Execution_Mode_Router ──────────────────────────────────────

export const ExecutionModeSchema = z.enum(['flash', 'standard', 'pro', 'ultra']);

// ─── Skill_Loader ───────────────────────────────────────────────

export const SkillFragmentSchema = z.object({
  agentId: z.string().min(1),
  domain: z.string().min(1),
  content: z.string(),
  tokenCost: z.number().int().nonnegative(),
  dependencies: z.array(z.string()),
});

// ─── Suggestion_Generator ───────────────────────────────────────

export const SuggestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  action: z.string().min(1),
  category: z.enum(['domain', 'diagnostic']),
});
