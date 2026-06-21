/**
 * ASTLockManager — Symbol-level AST locking for parallel agent coordination.
 *
 * Parses source files to identify function, class, and method boundaries,
 * then manages fine-grained locks on individual symbols so that parallel
 * sub-agents cannot concurrently modify the same code region.
 *
 * Uses regex-based symbol boundary detection as a fallback when Tree-sitter
 * is not available. The interface is designed for Tree-sitter integration
 * but degrades gracefully to regex patterns.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

import { readFile } from 'node:fs/promises';

// ─── Types ──────────────────────────────────────────────────────

export interface ASTLock {
  symbolName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  heldBy: string; // agent ID
  acquiredAt: string;
  timeoutMs: number;
}

export interface SymbolBoundary {
  name: string;
  startLine: number;
  endLine: number;
}

export interface LockStatus {
  locked: boolean;
  heldBy?: string;
}

// ─── Symbol Parser ──────────────────────────────────────────────

/**
 * Regex-based symbol boundary parser.
 *
 * Identifies functions, classes, methods, and arrow function assignments
 * by scanning line-by-line and tracking brace depth for boundaries.
 * Designed to be replaced by Tree-sitter when available.
 */
export function parseSymbolBoundaries(source: string): SymbolBoundary[] {
  const lines = source.split('\n');
  const symbols: SymbolBoundary[] = [];

  // Patterns that match the start of a symbol definition
  const patterns = [
    // function declarations: function foo(...) {
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/,
    // class declarations: class Foo {
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    // method definitions: methodName(...) { or async methodName(...) {
    /^\s*(?:public|private|protected|static|async|override|\s)*\s+(\w+)\s*\(/,
    // arrow function assignments: const foo = (...) => {
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/,
    // interface declarations: interface Foo {
    /^\s*(?:export\s+)?interface\s+(\w+)/,
    // type alias declarations: type Foo = {
    /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    // enum declarations: enum Foo {
    /^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match && match[1]) {
        const symbolName = match[1];
        const startLine = i + 1; // 1-indexed
        const endLine = findBlockEnd(lines, i);
        symbols.push({ name: symbolName, startLine, endLine });
        break; // Only match first pattern per line
      }
    }
  }

  return symbols;
}

/**
 * Find the end of a code block starting at the given line index.
 * Tracks brace depth to determine where the block closes.
 * Falls back to a single line if no braces are found.
 */
function findBlockEnd(lines: string[], startIndex: number): number {
  let braceDepth = 0;
  let foundOpenBrace = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip string literals and comments for brace counting (simplified)
    const cleaned = stripStringsAndComments(line);

    for (const ch of cleaned) {
      if (ch === '{') {
        braceDepth++;
        foundOpenBrace = true;
      } else if (ch === '}') {
        braceDepth--;
        if (foundOpenBrace && braceDepth === 0) {
          return i + 1; // 1-indexed
        }
      }
    }
  }

  // If no braces found, treat as a single-line symbol (type alias, etc.)
  // Scan forward for semicolons or end of statement
  if (!foundOpenBrace) {
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes(';') || (i > startIndex && /^\s*$/.test(line))) {
        return i + 1; // 1-indexed
      }
    }
  }

  return startIndex + 1; // 1-indexed fallback
}

/**
 * Strip string literals and single-line comments from a line for
 * accurate brace counting. This is a simplified approach — a real
 * Tree-sitter parser would handle this correctly.
 */
function stripStringsAndComments(line: string): string {
  // Remove single-line comments
  let result = line.replace(/\/\/.*$/, '');
  // Remove string literals (simplified: handles simple quoted strings)
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, '');
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '');
  result = result.replace(/`(?:[^`\\]|\\.)*`/g, '');
  return result;
}

// ─── Lock Manager ───────────────────────────────────────────────

export class ASTLockManager {
  private locks: Map<string, ASTLock> = new Map(); // key: "filePath:symbolName"
  private dormant: boolean;

  /**
   * @param timeoutMs Default lock timeout in milliseconds (default 300,000 = 5 minutes).
   * @param parallelExecutionEnabled Whether a parallel execution feature is active.
   *   When false, the manager remains dormant with zero overhead (Req 8.7, 8.8).
   */
  constructor(
    private timeoutMs: number = 300_000,
    parallelExecutionEnabled: boolean = true,
  ) {
    this.dormant = !parallelExecutionEnabled;
  }

  /**
   * Parse the given file and acquire a lock on the specified symbol.
   *
   * Returns `true` if the lock was acquired (or re-acquired by the same agent).
   * Returns `false` if the symbol is already locked by a different agent.
   *
   * When dormant (no parallel execution), always returns `true` with no overhead.
   */
  async acquire(
    filePath: string,
    symbolName: string,
    agentId: string,
  ): Promise<boolean> {
    if (this.dormant) {
      return true;
    }

    const key = this.lockKey(filePath, symbolName);

    // Check if already locked
    const existing = this.locks.get(key);
    if (existing) {
      // Same agent can re-acquire (idempotent)
      if (existing.heldBy === agentId) {
        existing.acquiredAt = new Date().toISOString();
        return true;
      }
      // Different agent — lock is held
      return false;
    }

    // Parse the file to find symbol boundaries
    const boundary = await this.findSymbolBoundary(filePath, symbolName);
    if (!boundary) {
      // Symbol not found in file — cannot acquire lock on non-existent symbol
      return false;
    }

    // Acquire the lock
    const lock: ASTLock = {
      symbolName,
      filePath,
      startLine: boundary.startLine,
      endLine: boundary.endLine,
      heldBy: agentId,
      acquiredAt: new Date().toISOString(),
      timeoutMs: this.timeoutMs,
    };

    this.locks.set(key, lock);
    return true;
  }

  /**
   * Release a lock on a symbol.
   *
   * Only the agent that holds the lock can release it.
   * No-op if dormant, if the lock doesn't exist, or if a different agent
   * attempts to release it.
   */
  release(filePath: string, symbolName: string, agentId: string): void {
    if (this.dormant) {
      return;
    }

    const key = this.lockKey(filePath, symbolName);
    const existing = this.locks.get(key);

    if (!existing) {
      return;
    }

    // Only the holding agent can release
    if (existing.heldBy !== agentId) {
      return;
    }

    this.locks.delete(key);
  }

  /**
   * Find and forcibly release locks that have exceeded their timeout.
   *
   * Returns the list of expired locks that were removed.
   * No-op if dormant.
   */
  expireStale(): ASTLock[] {
    if (this.dormant) {
      return [];
    }

    const now = Date.now();
    const expired: ASTLock[] = [];

    for (const [key, lock] of this.locks) {
      const acquiredTime = new Date(lock.acquiredAt).getTime();
      const elapsed = now - acquiredTime;

      if (elapsed >= lock.timeoutMs) {
        expired.push({ ...lock });
        this.locks.delete(key);
      }
    }

    return expired;
  }

  /**
   * Query whether a symbol is currently locked.
   *
   * Returns `{ locked: false }` if dormant or the symbol is not locked.
   * Returns `{ locked: true, heldBy: agentId }` if the symbol is locked.
   */
  isLocked(filePath: string, symbolName: string): LockStatus {
    if (this.dormant) {
      return { locked: false };
    }

    const key = this.lockKey(filePath, symbolName);
    const existing = this.locks.get(key);

    if (!existing) {
      return { locked: false };
    }

    return { locked: true, heldBy: existing.heldBy };
  }

  /**
   * Get all currently held locks.
   */
  getAllLocks(): ASTLock[] {
    return Array.from(this.locks.values());
  }

  /**
   * Check if the lock manager is in dormant state.
   */
  isDormant(): boolean {
    return this.dormant;
  }

  /**
   * Activate or deactivate the lock manager at runtime.
   * When deactivated, all existing locks are cleared.
   */
  setParallelExecutionEnabled(enabled: boolean): void {
    this.dormant = !enabled;
    if (this.dormant) {
      this.locks.clear();
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Build the composite lock key from file path and symbol name.
   */
  private lockKey(filePath: string, symbolName: string): string {
    return `${filePath}:${symbolName}`;
  }

  /**
   * Parse a source file and locate the named symbol's boundary.
   *
   * Uses regex-based parsing as a fallback. Designed for future
   * Tree-sitter integration which would replace this method.
   */
  private async findSymbolBoundary(
    filePath: string,
    symbolName: string,
  ): Promise<SymbolBoundary | null> {
    let source: string;
    try {
      source = await readFile(filePath, 'utf-8');
    } catch {
      // File does not exist or is unreadable
      return null;
    }

    const boundaries = parseSymbolBoundaries(source);
    return boundaries.find((b) => b.name === symbolName) ?? null;
  }
}
