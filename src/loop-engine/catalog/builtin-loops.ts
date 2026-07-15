/**
 * Builtin Starter Loops — Pre-configured loop definitions for common tasks.
 *
 * Provides three builtin loops:
 * 1. Type-clean: Fix all TypeScript type errors (tsc --noEmit)
 * 2. Test-repair: Fix all failing tests (vitest --run)
 * 3. Docs-current: Fix all documentation issues (npm run docs:check)
 *
 * All builtin loops use source='builtin', securityPolicy='standard',
 * and identical stop conditions (maxPasses 10, maxCostUsd 2.0,
 * maxWallClockMin 15, noProgressPasses 3).
 *
 * Registered on Loop Engine initialization when loops_enabled is true.
 *
 * Implements Requirements: 17.1, 17.2, 17.3, 17.4, 17.5
 */

import type { LoopSpec, LoopStorageLike } from '../index.js';

// ─── Builtin Loop IDs (stable UUIDs) ───────────────────────────

export const BUILTIN_TYPE_CLEAN_ID = 'b0000001-0000-4000-8000-000000000001';
export const BUILTIN_TEST_REPAIR_ID = 'b0000001-0000-4000-8000-000000000002';
export const BUILTIN_DOCS_CURRENT_ID = 'b0000001-0000-4000-8000-000000000003';

// ─── Shared Stop Conditions ─────────────────────────────────────

const BUILTIN_STOP_CONDITIONS = {
  maxPasses: 10,
  maxCostUsd: 2.0,
  maxWallClockMin: 15,
  noProgressPasses: 3,
  approvalBoundaries: [] as number[],
} as const;

// ─── Type-clean Loop (Req 17.1) ────────────────────────────────

export const TYPE_CLEAN_LOOP: LoopSpec = {
  id: BUILTIN_TYPE_CLEAN_ID,
  version: '1.0.0',
  name: 'Type-clean',
  useWhen: 'TypeScript compilation reports type errors that need fixing',
  goal: 'Fix all TypeScript type errors',
  passAction: 'Identify and fix TypeScript type errors reported by tsc --noEmit',
  verify: [
    {
      type: 'command',
      command: 'npx tsc --noEmit',
      expectedExitCode: 0,
    },
  ],
  feedback: 'Review tsc error output, identify root cause of each type error, and apply minimal fixes that preserve intended behavior',
  stop: { ...BUILTIN_STOP_CONDITIONS },
  scope: {
    allowedPaths: ['src/**', 'packages/**'],
    allowedTools: ['Read', 'Write', 'Bash'],
    securityPolicy: 'standard',
  },
  source: 'builtin',
};

// ─── Test-repair Loop (Req 17.2) ───────────────────────────────

export const TEST_REPAIR_LOOP: LoopSpec = {
  id: BUILTIN_TEST_REPAIR_ID,
  version: '1.0.0',
  name: 'Test-repair',
  useWhen: 'Test suite has failing tests that need to be fixed',
  goal: 'Fix all failing tests',
  passAction: 'Run test suite, identify failing tests, and apply fixes to make them pass',
  verify: [
    {
      type: 'command',
      command: 'npx vitest --run',
      expectedExitCode: 0,
    },
  ],
  feedback: 'Analyze test failure output, identify whether the bug is in test expectations or source code, and apply the appropriate fix',
  stop: { ...BUILTIN_STOP_CONDITIONS },
  scope: {
    allowedPaths: ['src/**', 'packages/**', 'tests/**'],
    allowedTools: ['Read', 'Write', 'Bash'],
    securityPolicy: 'standard',
  },
  source: 'builtin',
};

// ─── Docs-current Loop (Req 17.3) ──────────────────────────────

export const DOCS_CURRENT_LOOP: LoopSpec = {
  id: BUILTIN_DOCS_CURRENT_ID,
  version: '1.0.0',
  name: 'Docs-current',
  useWhen: 'Documentation has lint errors, broken links, or outdated content',
  goal: 'Fix all documentation issues',
  passAction: 'Run documentation lint and link-check, then fix reported issues',
  verify: [
    {
      type: 'command',
      command: 'npm run docs:check',
      expectedExitCode: 0,
    },
  ],
  feedback: 'Review documentation lint and link-check output, fix broken links, formatting issues, and outdated references',
  stop: { ...BUILTIN_STOP_CONDITIONS },
  scope: {
    allowedPaths: ['docs/**', 'README.md', '**/*.md'],
    allowedTools: ['Read', 'Write', 'Bash'],
    securityPolicy: 'standard',
  },
  source: 'builtin',
};

// ─── All Builtin Loops ──────────────────────────────────────────

export const BUILTIN_LOOPS: readonly LoopSpec[] = [
  TYPE_CLEAN_LOOP,
  TEST_REPAIR_LOOP,
  DOCS_CURRENT_LOOP,
] as const;

// ─── Registration Function (Req 17.5) ──────────────────────────

/**
 * Register all builtin loops in storage if not already present.
 * Called on Loop Engine initialization when loops_enabled is true.
 *
 * Skips loops that already exist in storage (idempotent).
 */
export async function registerBuiltinLoops(storage: LoopStorageLike): Promise<void> {
  for (const loop of BUILTIN_LOOPS) {
    const existing = await storage.getSpec(loop.id);
    if (existing === null) {
      await storage.saveSpec(loop);
    }
  }
}
