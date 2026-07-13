/**
 * Sandbox environment utilities for production/dev build detection
 * and isolation-kind enforcement.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

/**
 * Determines whether the current build is a production build.
 * Unknown or indeterminate mode is treated as production (R5.2).
 *
 * A build is treated as non-production ONLY when an explicit dev indicator is active:
 * - `NEURONEST_DEV_BUILD` is set to '1', OR
 * - `NODE_ENV` is set to 'development'
 *
 * Any other state (missing vars, empty values, 'production', 'test', etc.) => production.
 */
export function isProductionBuild(): boolean {
  return process.env.NEURONEST_DEV_BUILD !== '1' && process.env.NODE_ENV !== 'development';
}

/**
 * The kind of isolation a sandbox provides.
 * - 'docker': Real Docker-backed container isolation (R5.6)
 * - 'noop': No real isolation — mock/stub implementation (R5.1)
 */
export type IsolationKind = 'docker' | 'noop';

/**
 * Result returned when a no-op sandbox refuses execution in production.
 */
export interface SandboxRefusalResult {
  status: 'error';
  output: string;
  reason: string;
}

/**
 * Checks whether untrusted code execution should be refused.
 * In production with a no-op sandbox, refuses execution before any host code runs (R5.3, R5.4).
 * In dev with a no-op sandbox, allows execution but returns a warning message (R5.5).
 *
 * @returns null if execution should proceed, or a refusal result if it should be blocked.
 */
export function checkSandboxIsolation(
  isolationKind: IsolationKind,
  options?: { emitWarning?: (msg: string) => void },
): SandboxRefusalResult | null {
  if (isolationKind === 'docker') {
    // Real Docker sandbox — execution proceeds inside the container (R5.6)
    return null;
  }

  // isolationKind === 'noop'
  if (isProductionBuild()) {
    // R5.3, R5.4: In production, refuse execution before any host code runs
    return {
      status: 'error',
      output: '',
      reason:
        'Execution refused: no-op sandbox cannot execute untrusted code in a production build. ' +
        'Real Docker-backed isolation is required but unavailable.',
    };
  }

  // R5.5: In development, allow but warn
  const warning =
    'WARNING: Executing untrusted code with a no-op sandbox — real Docker-backed isolation is unavailable. ' +
    'This is permitted only in development builds.';
  if (options?.emitWarning) {
    options.emitWarning(warning);
  } else {
    console.warn(warning);
  }
  return null;
}
