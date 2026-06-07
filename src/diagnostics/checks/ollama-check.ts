import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * OllamaHealthCheck — checks whether the Ollama process is running.
 * Uses the existing getOllamaStatus utility from ollama-manager.
 *
 * Requirements: 1.3
 */

type OllamaStatusFn = () => Promise<{ installed: boolean; running: boolean; port: number; url: string }>;

export class OllamaHealthCheck implements HealthCheck {
  name = 'Ollama Status';

  private getStatusFn: OllamaStatusFn | undefined;

  /**
   * @param getStatus Optional status function. When omitted, dynamically imports
   *   getOllamaStatus from the ollama-manager module.
   */
  constructor(getStatus?: OllamaStatusFn) {
    this.getStatusFn = getStatus;
  }

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      let statusFn = this.getStatusFn;
      if (!statusFn) {
        try {
          const mod = await import('../../main/ollama-manager.js');
          statusFn = mod.getOllamaStatus;
        } catch {
          // Module not available (e.g. running outside Electron main process)
          return {
            name: this.name,
            status: 'warning',
            message: 'Ollama manager module not available',
            durationMs: Date.now() - start,
          };
        }
      }

      const status = await statusFn();

      if (!status.installed) {
        return {
          name: this.name,
          status: 'warning',
          message: 'Ollama is not installed',
          durationMs: Date.now() - start,
        };
      }

      if (!status.running) {
        return {
          name: this.name,
          status: 'warning',
          message: `Ollama is installed but not running (port ${status.port})`,
          durationMs: Date.now() - start,
        };
      }

      return {
        name: this.name,
        status: 'pass',
        message: `Ollama running on ${status.url}`,
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
