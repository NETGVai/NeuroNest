// ─── LoopSpec Zod Schema ────────────────────────────────────────
// Runtime validation layer for LoopSpec definitions.
// Provides Zod schemas matching the TypeScript types in ../index.ts
// with full constraint enforcement per Requirements 1.1–1.8.

import { z } from 'zod';

// ── Verify_Check discriminated union ────────────────────────────

const VerifyCheckCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string().max(1024),
  expectedExitCode: z.number().int().min(0).max(255),
});

const VerifyCheckMetricSchema = z.object({
  type: z.literal('metric'),
  metricName: z.string().max(128),
  comparator: z.enum(['lt', 'lte', 'eq', 'gte', 'gt']),
  target: z.number(),
});

const VerifyCheckFileSchema = z.object({
  type: z.literal('file'),
  filePath: z.string().max(512),
  assertion: z.enum(['exists', 'validJson', 'nonEmpty']),
});

const VerifyCheckLlmJudgeSchema = z.object({
  type: z.literal('llmJudge'),
  rubric: z.string().max(2048),
  threshold: z.number().min(0).max(1),
});

export const VerifyCheckSchema = z.discriminatedUnion('type', [
  VerifyCheckCommandSchema,
  VerifyCheckMetricSchema,
  VerifyCheckFileSchema,
  VerifyCheckLlmJudgeSchema,
]);

export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

// ── Stop conditions ─────────────────────────────────────────────

export const StopSchema = z
  .object({
    maxPasses: z.number().int().min(1).max(50),
    maxCostUsd: z.number().min(0.01).max(10000.0),
    maxWallClockMin: z.number().min(0.1).max(1440.0),
    noProgressPasses: z.number().int().min(1).max(50),
    approvalBoundaries: z.array(z.number().int().positive()).max(50),
  })
  .refine((data) => data.noProgressPasses <= data.maxPasses, {
    message: 'noProgressPasses must not exceed maxPasses',
  });

export type Stop = z.infer<typeof StopSchema>;

// ── Scope constraints ───────────────────────────────────────────

export const ScopeSchema = z.object({
  allowedPaths: z.array(z.string().max(512)).min(1).max(100),
  allowedTools: z.array(z.string().max(128)).min(1).max(50),
  securityPolicy: z.enum(['standard', 'strict', 'enterprise']),
});

export type Scope = z.infer<typeof ScopeSchema>;

// ── Full LoopSpec ───────────────────────────────────────────────

export const LoopSpecSchema = z.object({
  id: z.string().uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1).max(128),
  useWhen: z.string().max(512),
  goal: z.string().min(1).max(1024),
  passAction: z.string().max(512),
  verify: z.array(VerifyCheckSchema).min(1).max(20),
  feedback: z.string().max(2048),
  stop: StopSchema,
  scope: ScopeSchema,
  notes: z.string().max(2048).optional(),
  source: z.string().max(256),
  catalogRef: z.string().max(256).optional(),
});

export type LoopSpec = z.infer<typeof LoopSpecSchema>;

// ── Validation Function ─────────────────────────────────────────

/**
 * Validate a raw input against the LoopSpec schema.
 *
 * Pre-processing: clamps stop.maxPasses to 50 if it exceeds that value
 * BEFORE validation runs. This suppresses only the maxPasses-specific
 * out-of-range error. If other fields also fail validation, those errors
 * are still reported even when maxPasses was clamped (REQ-1.7).
 *
 * @returns { success, data?, error? } matching Zod safeParse shape.
 */
export function validateLoopSpec(raw: unknown): {
  success: boolean;
  data?: LoopSpec;
  error?: z.ZodError;
} {
  // Pre-process: clamp maxPasses to 50 (suppresses only maxPasses-specific errors)
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (obj['stop'] && typeof obj['stop'] === 'object') {
      const stop = obj['stop'] as Record<string, unknown>;
      if (typeof stop['maxPasses'] === 'number' && stop['maxPasses'] > 50) {
        stop['maxPasses'] = 50;
      }
    }
  }

  // After clamping, validate normally — non-maxPasses field errors are reported
  const result = LoopSpecSchema.safeParse(raw);
  return result;
}
