/**
 * Scope Envelope — Construction and validation of structural scope constraints.
 *
 * Provides pure-function validation of tool and file-path scopes,
 * monotonic attenuation verification (child scopes can only narrow, never widen),
 * and a simple glob pattern matcher (no external dependencies).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.7, 4.8
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Predicted scope from IntentAnchor classification.
 * Duplicated here to avoid circular dependency with intent-anchor.ts
 * (both are in the same implementation wave).
 */
export interface PredictedScope {
  readonly toolNames: readonly string[];
  readonly filePathPatterns: readonly string[];
}

/**
 * Immutable constraint set defining allowed tools and file path patterns.
 */
export interface ScopeEnvelope {
  readonly allowedTools: readonly string[];
  readonly allowedPaths: readonly string[];
}

/**
 * Result of a scope validation check.
 */
export interface ScopeValidationResult {
  allowed: boolean;
  violation?: {
    type: 'tool' | 'path';
    value: string;
  };
}

// ─── Glob Pattern Matching ──────────────────────────────────────

/**
 * Converts a simple glob pattern to a regular expression.
 * Supports:
 * - `*` matches any sequence of non-separator characters
 * - `**` matches any sequence including separators (recursive)
 * - Basic glob patterns like `src/**\/*.ts`
 *
 * No external dependencies (Requirement 11.3).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '^';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // `**` — match any sequence including separators
        // Skip optional trailing separator after **
        if (i + 2 < pattern.length && pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // `*` — match any sequence of non-separator characters
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (char === '.') {
      regexStr += '\\.';
      i += 1;
    } else if (char === '/' || char === '\\') {
      regexStr += '/';
      i += 1;
    } else {
      // Escape other regex-special characters
      regexStr += char!.replace(/[{}()+[\]^$|]/g, '\\$&');
      i += 1;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

/**
 * Tests whether a file path matches a glob pattern.
 * Normalizes path separators to forward slashes before matching.
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const regex = globToRegex(normalizedPattern);
  return regex.test(normalizedPath);
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Creates a ScopeEnvelope from the IntentAnchor's predicted scope.
 * The envelope captures the allowed tools and file path patterns as immutable arrays.
 */
export function createScopeEnvelope(predictedScope: PredictedScope): ScopeEnvelope {
  return {
    allowedTools: [...predictedScope.toolNames],
    allowedPaths: [...predictedScope.filePathPatterns],
  };
}

/**
 * Pure function: validates a tool call against the scope envelope.
 * Returns allowed: true if the tool name appears in the envelope's allowedTools list.
 */
export function validateToolScope(
  toolName: string,
  envelope: ScopeEnvelope
): ScopeValidationResult {
  const allowed = envelope.allowedTools.includes(toolName);
  if (allowed) {
    return { allowed: true };
  }
  return {
    allowed: false,
    violation: {
      type: 'tool',
      value: toolName,
    },
  };
}

/**
 * Pure function: validates a file path against the scope envelope's allowedPaths globs.
 * Returns allowed: true if the file path matches at least one pattern in allowedPaths.
 * If allowedPaths is empty, all paths are allowed (no path restriction).
 */
export function validatePathScope(
  filePath: string,
  envelope: ScopeEnvelope
): ScopeValidationResult {
  // If no path restrictions are defined, allow all paths
  if (envelope.allowedPaths.length === 0) {
    return { allowed: true };
  }

  const matches = envelope.allowedPaths.some((pattern) => matchesGlob(filePath, pattern));
  if (matches) {
    return { allowed: true };
  }
  return {
    allowed: false,
    violation: {
      type: 'path',
      value: filePath,
    },
  };
}

/**
 * Pure function: verifies child scope is a strict subset of parent.
 * A child is a strict subset when:
 * - Every tool in child.allowedTools is also in parent.allowedTools
 * - Every path pattern in child.allowedPaths matches at least one pattern in parent.allowedPaths
 *   (i.e., every file matchable by the child is also matchable by the parent)
 *
 * For path subset checking, we verify each child pattern is covered by at least one parent pattern.
 * A child pattern is considered covered if it is identical to a parent pattern, or if the parent
 * pattern is a broader glob that would match anything the child pattern matches.
 */
export function isStrictSubset(child: ScopeEnvelope, parent: ScopeEnvelope): boolean {
  // Every child tool must be in parent
  const allToolsInParent = child.allowedTools.every((tool) =>
    parent.allowedTools.includes(tool)
  );
  if (!allToolsInParent) {
    return false;
  }

  // If parent has no path restrictions, any child paths are a subset
  if (parent.allowedPaths.length === 0) {
    return true;
  }

  // If child has no path restrictions but parent does, child is NOT a subset
  // (child would allow everything, parent restricts)
  if (child.allowedPaths.length === 0 && parent.allowedPaths.length > 0) {
    return false;
  }

  // Every child path pattern must be covered by at least one parent pattern.
  // A child pattern is covered if it is an exact match or if the parent pattern
  // would match the child pattern itself (broader glob).
  const allPathsCovered = child.allowedPaths.every((childPattern) =>
    parent.allowedPaths.some((parentPattern) => isPatternCoveredBy(childPattern, parentPattern))
  );

  return allPathsCovered;
}

/**
 * Checks if a child glob pattern is covered by a parent glob pattern.
 * A child pattern is covered if:
 * 1. They are identical, OR
 * 2. The parent pattern (as a glob) would match the child pattern text, OR
 * 3. The parent uses ** and the child is a more specific version under the same prefix
 */
function isPatternCoveredBy(childPattern: string, parentPattern: string): boolean {
  // Exact match
  if (childPattern === parentPattern) {
    return true;
  }

  // Check if parent glob matches the child pattern as a path
  // This handles cases like parent="src/**/*.ts" covering child="src/utils/*.ts"
  if (matchesGlob(childPattern, parentPattern)) {
    return true;
  }

  return false;
}

/**
 * Creates a child scope that is the intersection of requested and parent.
 * Throws if requested tools or paths exceed the parent scope (monotonic attenuation violation).
 *
 * The result contains only tools and paths that exist in both requested and parent.
 */
export function createChildScope(
  requested: ScopeEnvelope,
  parent: ScopeEnvelope
): ScopeEnvelope {
  // Check for tools that exceed parent scope
  const violatingTools = requested.allowedTools.filter(
    (tool) => !parent.allowedTools.includes(tool)
  );
  if (violatingTools.length > 0) {
    throw new Error(
      `Scope violation: requested tools exceed parent scope: ${violatingTools.join(', ')}`
    );
  }

  // Check for paths that exceed parent scope
  if (parent.allowedPaths.length > 0) {
    const violatingPaths = requested.allowedPaths.filter(
      (childPattern) =>
        !parent.allowedPaths.some((parentPattern) =>
          isPatternCoveredBy(childPattern, parentPattern)
        )
    );
    if (violatingPaths.length > 0) {
      throw new Error(
        `Scope violation: requested paths exceed parent scope: ${violatingPaths.join(', ')}`
      );
    }
  }

  // Return the intersection — the requested scope (since it's already validated as subset)
  return {
    allowedTools: [...requested.allowedTools],
    allowedPaths: [...requested.allowedPaths],
  };
}
