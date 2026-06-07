/**
 * Zod validation schemas for security scanner types.
 *
 * Requirements: 2.6
 */

import { z } from 'zod';

// ─── Enums ──────────────────────────────────────────────────────

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const ScanTierSchema = z.enum(['minimal', 'extended', 'paranoid']);

// ─── Findings ───────────────────────────────────────────────────

export const ScanFindingSchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  ruleId: z.string().min(1),
  ruleName: z.string().min(1),
  severity: SeveritySchema,
  category: z.string().min(1),
  description: z.string().min(1),
  remediation: z.string(),
});

// ─── Options ────────────────────────────────────────────────────

export const ScanOptionsSchema = z.object({
  tier: ScanTierSchema.optional().default('extended'),
  baseline: z.string().optional(),
  output: z.string().optional(),
});

// ─── Exceptions ─────────────────────────────────────────────────

export const ScanExceptionSchema = z.object({
  ruleId: z.string().min(1),
  filePattern: z.string().min(1),
  reason: z.string().min(1),
  creator: z.string().min(1),
  expiresAt: z.number().nullable(),
});
