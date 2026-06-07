import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * DependencyHealthCheck — checks that node, electron, and better-sqlite3 are loadable
 * and reports their versions.
 *
 * Requirements: 1.8
 */

export class DependencyHealthCheck implements HealthCheck {
  name = 'System Dependencies';

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const versions: string[] = [];
      const warnings: string[] = [];

      // Node.js — always available
      const nodeVersion = process.versions?.node;
      if (nodeVersion) {
        versions.push(`Node ${nodeVersion}`);
      } else {
        warnings.push('Node.js version unavailable');
      }

      // Electron
      const electronVersion = process.versions?.electron;
      if (electronVersion) {
        versions.push(`Electron ${electronVersion}`);
      } else {
        // Try dynamic require as fallback
        try {
          const electron = require('electron');
          const ver = (electron as any).app?.getVersion?.() ?? 'unknown';
          versions.push(`Electron ${ver}`);
        } catch {
          warnings.push('Electron not available');
        }
      }

      // better-sqlite3
      try {
        const sqlite = require('better-sqlite3');
        // better-sqlite3 doesn't expose a version property easily,
        // but if it loads without error, it's functional.
        versions.push('better-sqlite3 loaded');
      } catch {
        warnings.push('better-sqlite3 not loadable');
      }

      if (warnings.length > 0 && versions.length === 0) {
        return {
          name: this.name,
          status: 'fail',
          message: `No dependencies loadable: ${warnings.join('; ')}`,
          durationMs: Date.now() - start,
        };
      }

      if (warnings.length > 0) {
        return {
          name: this.name,
          status: 'warning',
          message: `${versions.join(', ')} | Warnings: ${warnings.join('; ')}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        name: this.name,
        status: 'pass',
        message: versions.join(', '),
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
