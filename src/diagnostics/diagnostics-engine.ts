/**
 * DiagnosticsEngine — orchestrates health checks with a 30-second global timeout.
 *
 * Requirements: 1.1 (consolidated report), 1.9 (per-check error catching), 1.10 (30s timeout)
 */

import type Database from 'better-sqlite3';
import type { HealthCheck, HealthCheckResult, DiagnosticsReport } from './types.js';
import { ProviderHealthCheck } from './checks/provider-check.js';
import { OllamaHealthCheck } from './checks/ollama-check.js';
import { LlamaCppHealthCheck } from './checks/llamacpp-check.js';
import { DatabaseHealthCheck } from './checks/database-check.js';
import { DiskSpaceHealthCheck } from './checks/disk-space-check.js';
import { IPCHealthCheck } from './checks/ipc-check.js';
import { DependencyHealthCheck } from './checks/dependency-check.js';

export interface DiagnosticsEngineOptions {
  /** Override the default set of checks (useful for testing). */
  checks?: HealthCheck[];
  /** Override the default 30-second timeout in ms (useful for testing). */
  timeoutMs?: number;
}

export class DiagnosticsEngine {
  private checks: HealthCheck[];
  private readonly timeoutMs: number;

  constructor(db: Database.Database, options?: DiagnosticsEngineOptions) {
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.checks = options?.checks ?? [
      new ProviderHealthCheck(),
      new OllamaHealthCheck(),
      new LlamaCppHealthCheck(),
      new DatabaseHealthCheck(db),
      new DiskSpaceHealthCheck(),
      new IPCHealthCheck(),
      new DependencyHealthCheck(),
    ];
  }

  /** Replace the registered checks (useful for testing). */
  setChecks(checks: HealthCheck[]): void {
    this.checks = checks;
  }

  /** Return the currently registered checks. */
  getChecks(): readonly HealthCheck[] {
    return this.checks;
  }

  /**
   * Run all registered health checks with a global timeout.
   * Each check is individually guarded: if it throws, the error is caught and
   * the check is marked as failed. If the global deadline is exceeded, remaining
   * checks are marked as timed out.
   *
   * @param onProgress Optional callback invoked after each check completes.
   */
  async runAll(
    onProgress?: (result: HealthCheckResult) => void,
  ): Promise<DiagnosticsReport> {
    const start = Date.now();
    const results: HealthCheckResult[] = [];
    const deadline = start + this.timeoutMs;

    for (const check of this.checks) {
      if (Date.now() >= deadline) {
        // Global timeout exceeded — mark remaining checks as timed out
        results.push({
          name: check.name,
          status: 'fail',
          message: 'Check skipped: global timeout exceeded',
          durationMs: 0,
          timedOut: true,
        });
        continue;
      }

      const remaining = deadline - Date.now();
      const checkStart = Date.now();

      try {
        const checkResult = await Promise.race([
          check.run(),
          new Promise<HealthCheckResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  name: check.name,
                  status: 'fail',
                  message: 'Individual check timed out',
                  durationMs: remaining,
                  timedOut: true,
                }),
              remaining,
            ),
          ),
        ]);
        results.push(checkResult);
        onProgress?.(checkResult);
      } catch (err) {
        const failResult: HealthCheckResult = {
          name: check.name,
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - checkStart,
        };
        results.push(failResult);
        onProgress?.(failResult);
      }
    }

    return {
      timestamp: start,
      checks: results,
      totalDurationMs: Date.now() - start,
      completedAll: !results.some((r) => r.timedOut),
    };
  }
}
