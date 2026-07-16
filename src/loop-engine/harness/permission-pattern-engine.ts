/**
 * Re-export shim — PermissionPatternEngine has been relocated to src/security/.
 *
 * This file preserves backward compatibility for existing consumers that import
 * from the original harness location. All implementations live in
 * `src/security/permission-pattern-engine.ts`.
 *
 * @see src/security/permission-pattern-engine.ts
 */

export {
  PermissionPatternEngine,
  parsePattern,
  globToRegex,
  matchesPattern,
} from '../../security/permission-pattern-engine.js';

export type {
  PermissionPattern,
  PermissionConfig,
  PatternDecision,
  HierarchyLevel,
} from '../../security/permission-pattern-engine.js';
