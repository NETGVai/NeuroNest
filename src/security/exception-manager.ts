/**
 * ExceptionManager — manages scan finding suppressions.
 *
 * Provides CRUD operations for ScanExceptions and glob-based
 * suppression matching against ScanFindings.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

import { randomUUID } from 'crypto';
import type { ScanException, ScanFinding } from './types';

// ─── Glob Matching ──────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported patterns:
 *  - `**`  matches any sequence of characters including path separators
 *  - `*`   matches any sequence of non-separator characters
 *  - `?`   matches a single non-separator character
 *  - Literal characters match themselves (special regex chars are escaped)
 */
export function globToRegExp(pattern: string): RegExp {
  let regexStr = '^';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — match everything including separators
        regexStr += '.*';
        i += 2;
        // Skip an optional trailing slash after **
        if (pattern[i] === '/') {
          i++;
        }
      } else {
        // `*` — match everything except separators
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else {
      // Escape regex-special characters
      regexStr += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
      i++;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

/**
 * Test whether a file path matches a glob pattern.
 */
export function globMatch(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath);
}

// ─── ExceptionManager ───────────────────────────────────────────

export class ExceptionManager {
  private exceptions: Map<string, ScanException> = new Map();

  /**
   * Add a new exception.
   * Generates a UUID for id and sets createdAt to Date.now().
   */
  addException(
    exception: Omit<ScanException, 'id' | 'createdAt'>,
  ): ScanException {
    const full: ScanException = {
      ...exception,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    this.exceptions.set(full.id, full);
    return full;
  }

  /**
   * Get all active (non-expired) exceptions.
   * An exception is active when expiresAt is null OR expiresAt > Date.now().
   */
  getActiveExceptions(): ScanException[] {
    const now = Date.now();
    return [...this.exceptions.values()].filter(
      (e) => e.expiresAt === null || e.expiresAt > now,
    );
  }

  /**
   * Check if a finding is suppressed by any active exception.
   * A finding is suppressed when an active exception's ruleId matches
   * the finding's ruleId AND the exception's filePattern glob matches
   * the finding's filePath.
   */
  isSuppressed(finding: ScanFinding): boolean {
    const active = this.getActiveExceptions();
    return active.some(
      (e) =>
        e.ruleId === finding.ruleId && globMatch(e.filePattern, finding.filePath),
    );
  }

  /**
   * Revoke (delete) an exception by id.
   * No-op if the exception does not exist (idempotent).
   */
  revokeException(id: string): void {
    this.exceptions.delete(id);
  }

  /**
   * Update specified fields of an exception by id.
   * Throws if the exception does not exist.
   */
  updateException(id: string, updates: Partial<ScanException>): void {
    const existing = this.exceptions.get(id);
    if (!existing) {
      throw new Error(`Exception not found: ${id}`);
    }
    // Merge updates, but don't allow changing the id
    const updated: ScanException = {
      ...existing,
      ...updates,
      id: existing.id, // preserve original id
    };
    this.exceptions.set(id, updated);
  }

  /**
   * Get all exceptions (including expired), mainly for testing/admin.
   */
  getAllExceptions(): ScanException[] {
    return [...this.exceptions.values()];
  }
}
