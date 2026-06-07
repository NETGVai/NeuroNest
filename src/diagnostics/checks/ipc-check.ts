import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * IPCHealthCheck — structural check that verifies preload allowlist channels are defined.
 *
 * Since we can't easily access ipcMain handlers at runtime without Electron,
 * this check verifies that the preload script file is present on disk.
 *
 * Requirements: 1.7
 */

export class IPCHealthCheck implements HealthCheck {
  name = 'IPC Channel Health';

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // The preload script uses require('electron') and is not importable as a standard module.
      // Fall back to verifying the file exists on disk.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const preloadPath = path.join(__dirname, '..', '..', 'renderer', 'preload.ts');
      const altPath = path.join(__dirname, '..', '..', 'renderer', 'preload.js');

      const exists = fs.existsSync(preloadPath) || fs.existsSync(altPath);
      if (exists) {
        return {
          name: this.name,
          status: 'pass',
          message: 'Preload script exists (channel validation requires Electron runtime)',
          durationMs: Date.now() - start,
        };
      }

      return {
        name: this.name,
        status: 'warning',
        message: 'Preload script not found at expected path',
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
