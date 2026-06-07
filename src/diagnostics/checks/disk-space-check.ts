import * as fs from 'node:fs';
import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * DiskSpaceHealthCheck — checks available disk space.
 * fail < 100 MB, warning < 500 MB, pass >= 500 MB.
 *
 * Requirements: 1.6
 */

const MB = 1024 * 1024;
const DEFAULT_FAIL_THRESHOLD = 100 * MB;
const DEFAULT_WARN_THRESHOLD = 500 * MB;

export interface DiskSpaceThresholds {
  /** Bytes below which status is 'fail'. Default: 100 MB */
  failBelow: number;
  /** Bytes below which status is 'warning'. Default: 500 MB */
  warnBelow: number;
}

export class DiskSpaceHealthCheck implements HealthCheck {
  name = 'Disk Space';

  private readonly failBelow: number;
  private readonly warnBelow: number;

  constructor(thresholds?: DiskSpaceThresholds) {
    this.failBelow = thresholds?.failBelow ?? DEFAULT_FAIL_THRESHOLD;
    this.warnBelow = thresholds?.warnBelow ?? DEFAULT_WARN_THRESHOLD;
  }

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const stats = await fs.promises.statfs(process.cwd());
      const freeBytes = stats.bfree * stats.bsize;
      return this.classify(freeBytes, Date.now() - start);
    } catch (err) {
      return {
        name: this.name,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Classify free disk space into pass/warning/fail.
   * Exposed as a static method for property-based testing.
   */
  static classifyFreeSpace(
    freeBytes: number,
    thresholds?: DiskSpaceThresholds,
  ): { status: 'pass' | 'warning' | 'fail'; message: string } {
    const failBelow = thresholds?.failBelow ?? DEFAULT_FAIL_THRESHOLD;
    const warnBelow = thresholds?.warnBelow ?? DEFAULT_WARN_THRESHOLD;

    const freeMB = (freeBytes / MB).toFixed(1);

    if (freeBytes < failBelow) {
      return { status: 'fail', message: `Critically low disk space: ${freeMB} MB free` };
    }
    if (freeBytes < warnBelow) {
      return { status: 'warning', message: `Low disk space: ${freeMB} MB free` };
    }
    return { status: 'pass', message: `Disk space OK: ${freeMB} MB free` };
  }

  /** Instance-level classification using configured thresholds. */
  private classify(freeBytes: number, durationMs: number): HealthCheckResult {
    const { status, message } = DiskSpaceHealthCheck.classifyFreeSpace(freeBytes, {
      failBelow: this.failBelow,
      warnBelow: this.warnBelow,
    });
    return { name: this.name, status, message, durationMs };
  }
}
