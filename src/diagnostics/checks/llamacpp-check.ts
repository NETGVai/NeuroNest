import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * LlamaCppHealthCheck — checks whether the llama.cpp server is running.
 * Uses the existing getLlamaCppStatus utility from ollama-manager.
 *
 * Requirements: 1.4
 */

type LlamaCppStatusFn = () => Promise<{ installed: boolean; running: boolean; port: number; url: string }>;

export class LlamaCppHealthCheck implements HealthCheck {
  name = 'llama.cpp Status';

  private getStatusFn: LlamaCppStatusFn | undefined;

  /**
   * @param getStatus Optional status function. When omitted, dynamically imports
   *   getLlamaCppStatus from the ollama-manager module.
   */
  constructor(getStatus?: LlamaCppStatusFn) {
    this.getStatusFn = getStatus;
  }

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      let statusFn = this.getStatusFn;
      if (!statusFn) {
        try {
          const mod = await import('../../main/ollama-manager.js');
          statusFn = mod.getLlamaCppStatus;
        } catch {
          return {
            name: this.name,
            status: 'warning',
            message: 'llama.cpp manager module not available',
            durationMs: Date.now() - start,
          };
        }
      }

      const status = await statusFn();

      if (!status.installed) {
        return {
          name: this.name,
          status: 'warning',
          message: 'llama.cpp is not installed',
          durationMs: Date.now() - start,
        };
      }

      if (!status.running) {
        return {
          name: this.name,
          status: 'warning',
          message: `llama.cpp is installed but not running (port ${status.port})`,
          durationMs: Date.now() - start,
        };
      }

      return {
        name: this.name,
        status: 'pass',
        message: `llama.cpp running on ${status.url}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: this.name,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}
