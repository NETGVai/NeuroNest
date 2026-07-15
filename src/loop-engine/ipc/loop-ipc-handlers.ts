/**
 * Loop IPC Handlers — Typed IPC channel registration for loops:* channels.
 *
 * Registers all 8 loop-related IPC channels with Zod validation:
 * - loops:list    — List available loop specs
 * - loops:craft   — Initiate craft flow (placeholder, handled separately)
 * - loops:audit   — Run Loop Doctor audit on a spec
 * - loops:run     — Start a loop run
 * - loops:approve — Approve a paused loop
 * - loops:stop    — Stop a running loop (supports 'all' kill switch)
 * - loops:runStatus — Get current run status
 * - loops:receipt — Export receipt as Markdown
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 15.5
 */

import { z } from 'zod';
import type { LoopStorageLike, DoctorFinding, LoopRunRow } from '../index';

// ─── Zod Schemas ────────────────────────────────────────────────

// loops:list — no input, returns array of spec summaries
export const LoopsListRequestSchema = z.object({});
export const LoopsListResponseSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    source: z.string(),
  }),
);

// loops:craft — placeholder (craft flow handled separately)
export const LoopsCraftRequestSchema = z.object({
  prompt: z.string().min(1).max(2048),
});
export const LoopsCraftResponseSchema = z.object({
  started: z.boolean(),
});

// loops:audit — run Loop Doctor on a spec
export const LoopsAuditRequestSchema = z.object({
  specId: z.string().min(1),
});
export const LoopsAuditResponseSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['error', 'warning']),
      field: z.string(),
      message: z.string(),
    }),
  ),
});

// loops:run — start a loop run
export const LoopsRunRequestSchema = z.object({
  specId: z.string().uuid(),
});
export const LoopsRunResponseSchema = z.object({
  runId: z.string().uuid(),
});

// loops:approve — resume an AWAITING_APPROVAL loop
export const LoopsApproveRequestSchema = z.object({
  runId: z.string().uuid(),
});
export const LoopsApproveResponseSchema = z.object({
  resumed: z.boolean(),
});

// loops:stop — stop a loop (supports 'all' for kill switch)
export const LoopsStopRequestSchema = z.object({
  runId: z.string().min(1), // UUID or literal 'all'
});
export const LoopsStopResponseSchema = z.object({
  stopped: z.boolean(),
});

// loops:runStatus — get current run status
export const LoopsRunStatusRequestSchema = z.object({
  runId: z.string().uuid(),
});
export const LoopsRunStatusResponseSchema = z.object({
  state: z.string(),
  passesCompleted: z.number().int().min(0),
  costUsd: z.number().min(0),
  currentPass: z.number().int().min(0).nullable(),
});

// loops:receipt — export receipt as Markdown
export const LoopsReceiptRequestSchema = z.object({
  runId: z.string().uuid(),
});
export const LoopsReceiptResponseSchema = z.object({
  markdown: z.string(),
});

// ─── Service Interfaces ─────────────────────────────────────────

/**
 * Minimal interface for the LoopRunner as seen by IPC handlers.
 * Avoids coupling to the full LoopRunner class.
 */
export interface LoopRunnerLike {
  start(spec: unknown, sessionId: string): Promise<string>;
  approve(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  getState(): string;
  getContext(): { runId: string; passesCompleted: number; cumulativeCostUsd: number } | null;
}

/**
 * Minimal interface for the LoopDoctor as seen by IPC handlers.
 */
export interface LoopDoctorLike {
  audit(spec: unknown): Promise<DoctorFinding[]>;
}

/**
 * Minimal interface for the ReceiptGenerator as seen by IPC handlers.
 */
export interface ReceiptGeneratorLike {
  toMarkdown(receipt: unknown, specName: string): string;
}

/**
 * IPCRegistry-like interface for handler registration.
 * Matches the real IPCRegistry.register() signature.
 */
export interface IPCRegistryLike {
  register<Req, Res>(def: {
    channel: string;
    requestSchema: z.ZodType<Req>;
    responseSchema: z.ZodType<Res>;
    handler: (event: unknown, req: Req) => Promise<Res>;
  }): void;
}

// ─── Handler Registration ───────────────────────────────────────

export interface LoopIpcDeps {
  registry: IPCRegistryLike;
  loopRunner: LoopRunnerLike;
  loopStorage: LoopStorageLike;
  loopDoctor: LoopDoctorLike;
  receiptGenerator: ReceiptGeneratorLike;
  /** Returns a session ID for the current context */
  getSessionId: () => string;
}

/**
 * Register all loop IPC handlers with the IPCRegistry.
 *
 * Each handler validates input with Zod, calls the appropriate service method,
 * and validates output. Returns structured errors for invalid schemas,
 * non-existent run_ids, and wrong states.
 *
 * NOTE (REQ-14.5): The system does NOT actively monitor for loops stuck in
 * AWAITING_APPROVAL without action. It only errors on explicit approve
 * requests sent to a loop that is not in AWAITING_APPROVAL state.
 */
export function registerLoopIpcHandlers(deps: LoopIpcDeps): void {
  const { registry, loopRunner, loopStorage, loopDoctor, receiptGenerator, getSessionId } = deps;

  // ── loops:list ──────────────────────────────────────────────────
  registry.register({
    channel: 'loops:list',
    requestSchema: LoopsListRequestSchema,
    responseSchema: LoopsListResponseSchema,
    handler: async (_event, _req) => {
      const rows = await loopStorage.listSpecs();
      return (rows as Array<{ id: string; json: string; version: string; source: string }>).map(
        (row) => {
          const spec = JSON.parse(row.json);
          return {
            id: row.id,
            name: spec.name ?? row.id,
            version: row.version,
            source: row.source,
          };
        },
      );
    },
  });

  // ── loops:craft ─────────────────────────────────────────────────
  registry.register({
    channel: 'loops:craft',
    requestSchema: LoopsCraftRequestSchema,
    responseSchema: LoopsCraftResponseSchema,
    handler: async (_event, _req) => {
      // Craft flow is handled by a separate subsystem (loop-craft.ts).
      // This channel simply acknowledges receipt — the actual Q&A flow
      // proceeds through chat messages.
      return { started: true };
    },
  });

  // ── loops:audit ─────────────────────────────────────────────────
  registry.register({
    channel: 'loops:audit',
    requestSchema: LoopsAuditRequestSchema,
    responseSchema: LoopsAuditResponseSchema,
    handler: async (_event, req) => {
      const specRow = await loopStorage.getSpec(req.specId);
      if (!specRow) {
        throw new Error(`Loop spec '${req.specId}' not found`);
      }
      const spec = JSON.parse((specRow as { json: string }).json);
      const findings = await loopDoctor.audit(spec);
      return {
        findings: findings.map((f) => ({
          severity: f.severity,
          field: f.field,
          message: f.message,
        })),
      };
    },
  });

  // ── loops:run ───────────────────────────────────────────────────
  registry.register({
    channel: 'loops:run',
    requestSchema: LoopsRunRequestSchema,
    responseSchema: LoopsRunResponseSchema,
    handler: async (_event, req) => {
      const specRow = await loopStorage.getSpec(req.specId);
      if (!specRow) {
        throw new Error(`Loop spec '${req.specId}' not found`);
      }
      const spec = JSON.parse((specRow as { json: string }).json);
      const sessionId = getSessionId();
      const runId = await loopRunner.start(spec, sessionId);
      return { runId };
    },
  });

  // ── loops:approve ───────────────────────────────────────────────
  registry.register({
    channel: 'loops:approve',
    requestSchema: LoopsApproveRequestSchema,
    responseSchema: LoopsApproveResponseSchema,
    handler: async (_event, req) => {
      // Verify the run exists
      const run = (await loopStorage.getRun(req.runId)) as LoopRunRow | null;
      if (!run) {
        throw new Error(`Loop run '${req.runId}' not found`);
      }

      // REQ-14.5: Error on explicit approve to a loop NOT in AWAITING_APPROVAL.
      // We check run status — if the run is not in 'running' state, it's terminal.
      if (run.status !== 'running') {
        throw new Error(
          `Loop run '${req.runId}' is in state '${run.status}' and cannot be approved`,
        );
      }

      // Delegate to the runner which validates internal state machine state
      try {
        await loopRunner.approve(req.runId);
        return { resumed: true };
      } catch (err) {
        // Runner throws if not in AWAITING_APPROVAL state
        throw new Error(
          `Cannot approve loop run '${req.runId}': ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  });

  // ── loops:stop ──────────────────────────────────────────────────
  registry.register({
    channel: 'loops:stop',
    requestSchema: LoopsStopRequestSchema,
    responseSchema: LoopsStopResponseSchema,
    handler: async (_event, req) => {
      // Support 'all' as a kill switch — stops all running loops
      if (req.runId === 'all') {
        const runningRuns = (await loopStorage.getRunningRuns()) as LoopRunRow[];
        for (const run of runningRuns) {
          try {
            await loopRunner.stop(run.id);
          } catch {
            // Best-effort: continue stopping others even if one fails
          }
        }
        return { stopped: true };
      }

      // Single run stop
      const run = (await loopStorage.getRun(req.runId)) as LoopRunRow | null;
      if (!run) {
        throw new Error(`Loop run '${req.runId}' not found`);
      }
      if (run.status !== 'running') {
        throw new Error(`Loop run '${req.runId}' is already in terminal state '${run.status}'`);
      }
      await loopRunner.stop(req.runId);
      return { stopped: true };
    },
  });

  // ── loops:runStatus ─────────────────────────────────────────────
  registry.register({
    channel: 'loops:runStatus',
    requestSchema: LoopsRunStatusRequestSchema,
    responseSchema: LoopsRunStatusResponseSchema,
    handler: async (_event, req) => {
      const run = (await loopStorage.getRun(req.runId)) as LoopRunRow | null;
      if (!run) {
        throw new Error(`Loop run '${req.runId}' not found`);
      }

      // Determine current pass number
      const currentPass =
        run.status === 'running' ? run.passes_completed + 1 : null;

      // Map DB status to runner state for active runs
      let state: string = run.status;
      if (run.status === 'running') {
        // Try to get live state from the runner if it's the active run
        const ctx = loopRunner.getContext();
        if (ctx && ctx.runId === req.runId) {
          state = loopRunner.getState();
        }
      } else if (run.status === 'completed') {
        state = run.stop_reason === 'no_op' ? 'NO_OP' : 'SUCCEEDED';
      } else if (run.status === 'failed') {
        state = run.stop_reason === 'stalled' ? 'STALLED' : 'BLOCKED';
      } else if (run.status === 'cancelled') {
        state = 'LIMIT_EXHAUSTED';
      }

      return {
        state,
        passesCompleted: run.passes_completed,
        costUsd: run.cost_usd,
        currentPass,
      };
    },
  });

  // ── loops:receipt ───────────────────────────────────────────────
  registry.register({
    channel: 'loops:receipt',
    requestSchema: LoopsReceiptRequestSchema,
    responseSchema: LoopsReceiptResponseSchema,
    handler: async (_event, req) => {
      const receiptJson = await loopStorage.getReceipt(req.runId);
      if (!receiptJson) {
        throw new Error(`No receipt found for loop run '${req.runId}'`);
      }

      const receipt = JSON.parse(receiptJson);

      // Get spec name for the markdown header
      const run = (await loopStorage.getRun(req.runId)) as LoopRunRow | null;
      let specName = 'Unknown Loop';
      if (run) {
        const specRow = await loopStorage.getSpec(run.spec_id);
        if (specRow) {
          const spec = JSON.parse((specRow as { json: string }).json);
          specName = spec.name ?? run.spec_id;
        }
      }

      const markdown = receiptGenerator.toMarkdown(receipt, specName);
      return { markdown };
    },
  });
}
