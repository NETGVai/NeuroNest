/**
 * Activity Heatmap Processor
 *
 * Reads local Git history and computes commit frequency per file.
 * Maps commit counts to a color gradient using percentile-based scaling:
 * - Top 20% (80-100th percentile): warm colors (red → orange)
 * - Middle 60% (20-80th percentile): intermediate (yellow → green)
 * - Bottom 20% (0-20th percentile): cool colors (teal → blue)
 * - Zero commits: neutral gray (#6b7280)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5, 4.6
 */

import { execSync } from 'node:child_process';
import type { HeatmapResult, FileActivity } from './types.js';

export class ActivityHeatmapProcessor {
  private readonly DEFAULT_DAYS = 90;

  /**
   * Compute the activity heatmap for a project.
   *
   * Algorithm:
   * 1. Check if the project path is a Git repo
   * 2. Run `git log --format="%H %ai" --name-only --since=<date>` locally
   * 3. Parse output to build fileId → { commitCount, lastDate } map
   * 4. Separate zero-commit files (neutral color, excluded from percentile)
   * 5. Compute percentile rank for non-zero files
   * 6. Map percentile to color gradient
   *
   * @param projectPath - Absolute path to the project root
   * @param days - Number of days of history to analyze (default: 90)
   * @returns HeatmapResult with per-file activity data
   */
  async computeHeatmap(projectPath: string, days?: number): Promise<HeatmapResult> {
    const effectiveDays = days ?? this.DEFAULT_DAYS;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - effectiveDays);

    const timeWindow = {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      days: effectiveDays,
    };

    // Check if the project has a Git repository
    if (!this.isGitRepo(projectPath)) {
      return { files: [], timeWindow, hasGitRepo: false };
    }

    // Run git log and parse output
    const gitOutput = this.runGitLog(projectPath, effectiveDays);
    const fileActivityMap = this.parseGitLog(gitOutput);

    // Collect commit counts for non-zero files
    const nonZeroCounts: number[] = [];
    for (const { count } of fileActivityMap.values()) {
      if (count > 0) {
        nonZeroCounts.push(count);
      }
    }

    // Compute percentile mapping for non-zero counts
    const percentileMap = this.computePercentiles(nonZeroCounts);

    // Build FileActivity array
    const files: FileActivity[] = [];
    for (const [filePath, { count, lastDate }] of fileActivityMap.entries()) {
      if (count === 0) {
        files.push({
          fileId: filePath,
          filePath,
          commitCount: 0,
          lastCommitDate: null,
          percentile: null,
          color: '#6b7280', // neutral gray
        });
      } else {
        const percentile = percentileMap.get(count) ?? 0;
        files.push({
          fileId: filePath,
          filePath,
          commitCount: count,
          lastCommitDate: lastDate,
          percentile,
          color: this.percentileToColor(percentile),
        });
      }
    }

    return { files, timeWindow, hasGitRepo: true };
  }

  /**
   * Check if the given path is inside a Git work tree.
   */
  private isGitRepo(projectPath: string): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run git log to get commit history with file names.
   */
  private runGitLog(projectPath: string, days: number): string {
    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceStr = sinceDate.toISOString().split('T')[0];

      return execSync(
        `git log --format="%H %ai" --name-only --since="${sinceStr}"`,
        {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
        }
      );
    } catch {
      return '';
    }
  }

  /**
   * Parse git log output into a file → { count, lastDate } map.
   *
   * The output format is blocks separated by blank lines:
   * ```
   * <hash> <date>
   * <file1>
   * <file2>
   * ...
   *
   * <hash> <date>
   * ...
   * ```
   */
  parseGitLog(output: string): Map<string, { count: number; lastDate: string }> {
    const result = new Map<string, { count: number; lastDate: string }>();

    if (!output || !output.trim()) {
      return result;
    }

    const lines = output.split('\n');
    let currentDate: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        // Blank line separates commit blocks
        continue;
      }

      // Check if this is a commit header line: "<hash> <date>"
      // Hash is 40 hex chars, followed by space, then date in format "YYYY-MM-DD HH:MM:SS +ZZZZ"
      const commitMatch = trimmed.match(/^[0-9a-f]{40}\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4})$/);
      if (commitMatch) {
        currentDate = commitMatch[1];
        continue;
      }

      // This is a file path line
      if (currentDate && trimmed) {
        const existing = result.get(trimmed);
        if (existing) {
          existing.count++;
          // Keep the most recent date (git log outputs most recent first)
          // So the first date we encounter for a file is its most recent commit
        } else {
          result.set(trimmed, { count: 1, lastDate: currentDate });
        }
      }
    }

    return result;
  }

  /**
   * Compute percentile rank for a set of non-zero counts.
   *
   * For each unique count value, percentile = (number of values strictly less) / (total - 1) × 100
   * When there's only one file, it gets percentile 100.
   *
   * @param counts - Array of commit counts (all > 0)
   * @returns Map from count value → percentile (0-100)
   */
  computePercentiles(counts: number[]): Map<number, number> {
    const result = new Map<number, number>();

    if (counts.length === 0) {
      return result;
    }

    if (counts.length === 1) {
      result.set(counts[0], 100);
      return result;
    }

    // Sort counts ascending
    const sorted = [...counts].sort((a, b) => a - b);
    const total = sorted.length;

    for (let i = 0; i < total; i++) {
      const count = sorted[i];
      if (!result.has(count)) {
        // Number of values strictly less than this count
        const numLess = sorted.filter(v => v < count).length;
        const percentile = (numLess / (total - 1)) * 100;
        result.set(count, percentile);
      }
    }

    return result;
  }

  /**
   * Map a percentile (0-100) to a hex color using a gradient:
   * - 80-100 (top 20%): warm colors — red (#ef4444) to orange (#f97316)
   * - 20-80 (middle 60%): intermediate — yellow (#eab308) to green (#22c55e)
   * - 0-20 (bottom 20%): cool colors — teal (#14b8a6) to blue (#3b82f6)
   *
   * Within each band, colors are linearly interpolated.
   */
  percentileToColor(percentile: number): string {
    if (percentile >= 80) {
      // Top 20%: interpolate from orange (#f97316) at 80 to red (#ef4444) at 100
      const t = (percentile - 80) / 20;
      return this.interpolateColor(
        { r: 0xf9, g: 0x73, b: 0x16 }, // orange
        { r: 0xef, g: 0x44, b: 0x44 }, // red
        t
      );
    } else if (percentile >= 20) {
      // Middle 60%: interpolate from green (#22c55e) at 20 to yellow (#eab308) at 80
      const t = (percentile - 20) / 60;
      return this.interpolateColor(
        { r: 0x22, g: 0xc5, b: 0x5e }, // green
        { r: 0xea, g: 0xb3, b: 0x08 }, // yellow
        t
      );
    } else {
      // Bottom 20%: interpolate from blue (#3b82f6) at 0 to teal (#14b8a6) at 20
      const t = percentile / 20;
      return this.interpolateColor(
        { r: 0x3b, g: 0x82, b: 0xf6 }, // blue
        { r: 0x14, g: 0xb8, b: 0xa6 }, // teal
        t
      );
    }
  }

  /**
   * Linearly interpolate between two RGB colors.
   */
  private interpolateColor(
    from: { r: number; g: number; b: number },
    to: { r: number; g: number; b: number },
    t: number
  ): string {
    const r = Math.round(from.r + (to.r - from.r) * t);
    const g = Math.round(from.g + (to.g - from.g) * t);
    const b = Math.round(from.b + (to.b - from.b) * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
}
