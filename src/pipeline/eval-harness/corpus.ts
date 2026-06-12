/**
 * Evaluation Corpus Management
 *
 * Maintains a corpus of 50+ coding tasks spanning file creation, refactoring,
 * bug fixing, and test writing. Provides filtering and selection utilities.
 */

import { EvalTask, EvalTaskCategory, CorpusConfig } from './types';

/**
 * The full evaluation corpus of coding tasks.
 * Each task defines what should be accomplished and the expected file outputs.
 */
const EVAL_CORPUS: EvalTask[] = [
  // ─── File Creation Tasks (15 tasks) ────────────────────────────────
  {
    id: 'fc-001',
    category: 'file-creation',
    description: 'Create a TypeScript utility module for string manipulation with camelCase, kebab-case, and snake_case converters',
    expectedFiles: ['src/utils/string-case.ts'],
    complexity: 2,
    tags: ['utility', 'typescript'],
  },
  {
    id: 'fc-002',
    category: 'file-creation',
    description: 'Create a React component for displaying a sortable data table with pagination',
    expectedFiles: ['src/components/DataTable.tsx', 'src/components/DataTable.css'],
    complexity: 3,
    tags: ['react', 'component'],
  },
  {
    id: 'fc-003',
    category: 'file-creation',
    description: 'Create an Express middleware for rate limiting with sliding window algorithm',
    expectedFiles: ['src/middleware/rate-limiter.ts'],
    complexity: 3,
    tags: ['middleware', 'security'],
  },
  {
    id: 'fc-004',
    category: 'file-creation',
    description: 'Create a configuration loader that reads from environment variables, JSON files, and CLI args with priority ordering',
    expectedFiles: ['src/config/loader.ts', 'src/config/types.ts'],
    complexity: 3,
    tags: ['config', 'utility'],
  },
  {
    id: 'fc-005',
    category: 'file-creation',
    description: 'Create a WebSocket connection manager with automatic reconnection and heartbeat',
    expectedFiles: ['src/network/ws-manager.ts'],
    complexity: 4,
    tags: ['network', 'websocket'],
  },
  {
    id: 'fc-006',
    category: 'file-creation',
    description: 'Create a CLI argument parser supporting subcommands, flags, and positional arguments',
    expectedFiles: ['src/cli/arg-parser.ts'],
    complexity: 3,
    tags: ['cli', 'parser'],
  },
  {
    id: 'fc-007',
    category: 'file-creation',
    description: 'Create a file watcher utility that debounces change events and supports glob patterns',
    expectedFiles: ['src/utils/file-watcher.ts'],
    complexity: 3,
    tags: ['filesystem', 'utility'],
  },
  {
    id: 'fc-008',
    category: 'file-creation',
    description: 'Create a simple in-memory LRU cache with TTL support and size limits',
    expectedFiles: ['src/cache/lru-cache.ts'],
    complexity: 2,
    tags: ['cache', 'data-structure'],
  },
  {
    id: 'fc-009',
    category: 'file-creation',
    description: 'Create a validation library with composable validators for common data types',
    expectedFiles: ['src/validation/validators.ts', 'src/validation/types.ts'],
    complexity: 3,
    tags: ['validation', 'library'],
  },
  {
    id: 'fc-010',
    category: 'file-creation',
    description: 'Create a logging adapter that writes structured JSON logs with log levels and rotation',
    expectedFiles: ['src/logging/json-logger.ts'],
    complexity: 2,
    tags: ['logging', 'utility'],
  },
  {
    id: 'fc-011',
    category: 'file-creation',
    description: 'Create a task queue with priority ordering, concurrency control, and retry logic',
    expectedFiles: ['src/queue/task-queue.ts'],
    complexity: 4,
    tags: ['queue', 'concurrency'],
  },
  {
    id: 'fc-012',
    category: 'file-creation',
    description: 'Create a dependency injection container with singleton and transient lifetimes',
    expectedFiles: ['src/di/container.ts', 'src/di/types.ts'],
    complexity: 4,
    tags: ['di', 'architecture'],
  },
  {
    id: 'fc-013',
    category: 'file-creation',
    description: 'Create an event emitter with typed events, wildcard listeners, and once-only subscriptions',
    expectedFiles: ['src/events/typed-emitter.ts'],
    complexity: 3,
    tags: ['events', 'utility'],
  },
  {
    id: 'fc-014',
    category: 'file-creation',
    description: 'Create a Markdown-to-HTML converter supporting headings, lists, code blocks, and links',
    expectedFiles: ['src/parsers/markdown.ts'],
    complexity: 4,
    tags: ['parser', 'markdown'],
  },
  {
    id: 'fc-015',
    category: 'file-creation',
    description: 'Create a plugin system with lifecycle hooks, dependency resolution, and hot-reload support',
    expectedFiles: ['src/plugins/plugin-manager.ts', 'src/plugins/types.ts'],
    complexity: 5,
    tags: ['plugins', 'architecture'],
  },

  // ─── Refactoring Tasks (13 tasks) ─────────────────────────────────
  {
    id: 'rf-001',
    category: 'refactoring',
    description: 'Extract inline SQL queries from a data access module into a separate query builder',
    expectedFiles: ['src/data/query-builder.ts', 'src/data/repository.ts'],
    complexity: 3,
    tags: ['sql', 'separation-of-concerns'],
  },
  {
    id: 'rf-002',
    category: 'refactoring',
    description: 'Convert callback-based async functions to async/await with proper error handling',
    expectedFiles: ['src/services/file-service.ts'],
    complexity: 2,
    tags: ['async', 'modernization'],
  },
  {
    id: 'rf-003',
    category: 'refactoring',
    description: 'Split a 2000-line utility file into domain-specific modules with barrel exports',
    expectedFiles: ['src/utils/index.ts', 'src/utils/string.ts', 'src/utils/array.ts', 'src/utils/object.ts'],
    complexity: 3,
    tags: ['decomposition', 'modules'],
  },
  {
    id: 'rf-004',
    category: 'refactoring',
    description: 'Replace magic numbers and strings with named constants and enums',
    expectedFiles: ['src/constants.ts', 'src/types/enums.ts'],
    complexity: 2,
    tags: ['readability', 'constants'],
  },
  {
    id: 'rf-005',
    category: 'refactoring',
    description: 'Convert class-based React components to functional components with hooks',
    expectedFiles: ['src/components/UserProfile.tsx', 'src/hooks/useUser.ts'],
    complexity: 3,
    tags: ['react', 'hooks', 'modernization'],
  },
  {
    id: 'rf-006',
    category: 'refactoring',
    description: 'Extract common error handling patterns into a centralized error boundary and handler',
    expectedFiles: ['src/errors/handler.ts', 'src/errors/types.ts'],
    complexity: 3,
    tags: ['error-handling', 'patterns'],
  },
  {
    id: 'rf-007',
    category: 'refactoring',
    description: 'Replace imperative loops with functional array methods (map, filter, reduce)',
    expectedFiles: ['src/transforms/data-processor.ts'],
    complexity: 2,
    tags: ['functional', 'readability'],
  },
  {
    id: 'rf-008',
    category: 'refactoring',
    description: 'Introduce the repository pattern to decouple business logic from data persistence',
    expectedFiles: ['src/repositories/base-repository.ts', 'src/repositories/user-repository.ts'],
    complexity: 4,
    tags: ['patterns', 'architecture'],
  },
  {
    id: 'rf-009',
    category: 'refactoring',
    description: 'Extract hardcoded configuration values into a typed configuration schema',
    expectedFiles: ['src/config/schema.ts', 'src/config/defaults.ts'],
    complexity: 2,
    tags: ['config', 'type-safety'],
  },
  {
    id: 'rf-010',
    category: 'refactoring',
    description: 'Replace mutable state mutations with immutable update patterns using spread operators',
    expectedFiles: ['src/state/reducers.ts'],
    complexity: 3,
    tags: ['immutability', 'state'],
  },
  {
    id: 'rf-011',
    category: 'refactoring',
    description: 'Convert a monolithic API handler into separate controller, service, and validation layers',
    expectedFiles: ['src/api/controller.ts', 'src/api/service.ts', 'src/api/validation.ts'],
    complexity: 4,
    tags: ['layers', 'architecture'],
  },
  {
    id: 'rf-012',
    category: 'refactoring',
    description: 'Replace any types with proper TypeScript generics and type constraints',
    expectedFiles: ['src/utils/typed-collection.ts'],
    complexity: 3,
    tags: ['typescript', 'type-safety'],
  },
  {
    id: 'rf-013',
    category: 'refactoring',
    description: 'Extract duplicated API error response formatting into shared middleware',
    expectedFiles: ['src/middleware/error-formatter.ts'],
    complexity: 2,
    tags: ['middleware', 'dry'],
  },

  // ─── Bug Fix Tasks (12 tasks) ─────────────────────────────────────
  {
    id: 'bf-001',
    category: 'bug-fix',
    description: 'Fix off-by-one error in pagination logic that skips the last page of results',
    expectedFiles: ['src/utils/pagination.ts'],
    complexity: 2,
    tags: ['pagination', 'off-by-one'],
  },
  {
    id: 'bf-002',
    category: 'bug-fix',
    description: 'Fix race condition in concurrent file writes that causes data corruption',
    expectedFiles: ['src/io/file-writer.ts'],
    complexity: 4,
    tags: ['concurrency', 'race-condition'],
  },
  {
    id: 'bf-003',
    category: 'bug-fix',
    description: 'Fix memory leak caused by event listeners not being removed on component unmount',
    expectedFiles: ['src/components/StreamViewer.tsx'],
    complexity: 3,
    tags: ['memory-leak', 'react'],
  },
  {
    id: 'bf-004',
    category: 'bug-fix',
    description: 'Fix incorrect timezone handling in date formatting that shows wrong time for UTC offsets',
    expectedFiles: ['src/utils/date-format.ts'],
    complexity: 3,
    tags: ['datetime', 'timezone'],
  },
  {
    id: 'bf-005',
    category: 'bug-fix',
    description: 'Fix SQL injection vulnerability in user search query construction',
    expectedFiles: ['src/data/user-search.ts'],
    complexity: 3,
    tags: ['security', 'sql-injection'],
  },
  {
    id: 'bf-006',
    category: 'bug-fix',
    description: 'Fix infinite loop when parsing circular JSON references in config loader',
    expectedFiles: ['src/config/parser.ts'],
    complexity: 3,
    tags: ['parsing', 'infinite-loop'],
  },
  {
    id: 'bf-007',
    category: 'bug-fix',
    description: 'Fix null pointer exception when accessing optional nested object properties',
    expectedFiles: ['src/utils/safe-access.ts'],
    complexity: 2,
    tags: ['null-safety', 'optional-chaining'],
  },
  {
    id: 'bf-008',
    category: 'bug-fix',
    description: 'Fix incorrect sorting of mixed numeric and string array elements',
    expectedFiles: ['src/utils/sort.ts'],
    complexity: 2,
    tags: ['sorting', 'type-coercion'],
  },
  {
    id: 'bf-009',
    category: 'bug-fix',
    description: 'Fix WebSocket reconnection that fires duplicate message handlers after each reconnect',
    expectedFiles: ['src/network/ws-client.ts'],
    complexity: 4,
    tags: ['websocket', 'event-handling'],
  },
  {
    id: 'bf-010',
    category: 'bug-fix',
    description: 'Fix cache invalidation bug where stale entries persist after TTL expiration',
    expectedFiles: ['src/cache/ttl-cache.ts'],
    complexity: 3,
    tags: ['cache', 'ttl'],
  },
  {
    id: 'bf-011',
    category: 'bug-fix',
    description: 'Fix promise rejection not being caught in async middleware chain',
    expectedFiles: ['src/middleware/async-handler.ts'],
    complexity: 3,
    tags: ['async', 'error-handling'],
  },
  {
    id: 'bf-012',
    category: 'bug-fix',
    description: 'Fix CSS specificity issue causing modal backdrop to cover the modal itself',
    expectedFiles: ['src/components/Modal.css', 'src/components/Modal.tsx'],
    complexity: 2,
    tags: ['css', 'z-index'],
  },

  // ─── Test Writing Tasks (12 tasks) ────────────────────────────────
  {
    id: 'tw-001',
    category: 'test-writing',
    description: 'Write unit tests for a URL parser covering edge cases like unicode, ports, and fragments',
    expectedFiles: ['src/utils/__tests__/url-parser.test.ts'],
    complexity: 3,
    tags: ['unit-test', 'parser'],
  },
  {
    id: 'tw-002',
    category: 'test-writing',
    description: 'Write integration tests for REST API endpoints including auth, CRUD, and error responses',
    expectedFiles: ['tests/integration/api.test.ts'],
    complexity: 4,
    tags: ['integration-test', 'api'],
  },
  {
    id: 'tw-003',
    category: 'test-writing',
    description: 'Write property-based tests for a JSON serialization round-trip function',
    expectedFiles: ['tests/property/json-roundtrip.test.ts'],
    complexity: 3,
    tags: ['property-test', 'serialization'],
  },
  {
    id: 'tw-004',
    category: 'test-writing',
    description: 'Write snapshot tests for React component rendering with various prop combinations',
    expectedFiles: ['src/components/__tests__/Button.test.tsx'],
    complexity: 2,
    tags: ['snapshot-test', 'react'],
  },
  {
    id: 'tw-005',
    category: 'test-writing',
    description: 'Write end-to-end tests for user registration flow including email verification',
    expectedFiles: ['tests/e2e/registration.test.ts'],
    complexity: 4,
    tags: ['e2e-test', 'auth'],
  },
  {
    id: 'tw-006',
    category: 'test-writing',
    description: 'Write tests for error boundary component covering throw, recovery, and fallback rendering',
    expectedFiles: ['src/components/__tests__/ErrorBoundary.test.tsx'],
    complexity: 3,
    tags: ['unit-test', 'error-handling'],
  },
  {
    id: 'tw-007',
    category: 'test-writing',
    description: 'Write performance regression tests measuring rendering time of a complex list component',
    expectedFiles: ['tests/perf/list-render.bench.ts'],
    complexity: 3,
    tags: ['perf-test', 'benchmark'],
  },
  {
    id: 'tw-008',
    category: 'test-writing',
    description: 'Write unit tests for a state machine covering all transitions and guard conditions',
    expectedFiles: ['src/state/__tests__/state-machine.test.ts'],
    complexity: 3,
    tags: ['unit-test', 'state-machine'],
  },
  {
    id: 'tw-009',
    category: 'test-writing',
    description: 'Write tests for database migration scripts verifying schema changes up and down',
    expectedFiles: ['tests/migrations/migration.test.ts'],
    complexity: 4,
    tags: ['integration-test', 'database'],
  },
  {
    id: 'tw-010',
    category: 'test-writing',
    description: 'Write tests for a retry utility covering exponential backoff, max attempts, and abort',
    expectedFiles: ['src/utils/__tests__/retry.test.ts'],
    complexity: 2,
    tags: ['unit-test', 'retry'],
  },
  {
    id: 'tw-011',
    category: 'test-writing',
    description: 'Write concurrency tests verifying mutex lock behavior under parallel access',
    expectedFiles: ['tests/concurrency/mutex.test.ts'],
    complexity: 4,
    tags: ['concurrency-test', 'mutex'],
  },
  {
    id: 'tw-012',
    category: 'test-writing',
    description: 'Write tests for input sanitization functions covering XSS vectors and encoding edge cases',
    expectedFiles: ['src/security/__tests__/sanitizer.test.ts'],
    complexity: 3,
    tags: ['security-test', 'xss'],
  },
];

/**
 * Returns the full evaluation corpus.
 */
export function getFullCorpus(): EvalTask[] {
  return [...EVAL_CORPUS];
}

/**
 * Returns the total number of tasks in the corpus.
 */
export function getCorpusSize(): number {
  return EVAL_CORPUS.length;
}

/**
 * Filters the corpus based on configuration options.
 */
export function filterCorpus(config: CorpusConfig = {}): EvalTask[] {
  let tasks = [...EVAL_CORPUS];

  // Filter by categories
  if (config.categories && config.categories.length > 0) {
    tasks = tasks.filter(t => config.categories!.includes(t.category));
  }

  // Filter by tags
  if (config.tags && config.tags.length > 0) {
    tasks = tasks.filter(t => t.tags?.some(tag => config.tags!.includes(tag)));
  }

  // Apply seed-based shuffling for reproducibility
  if (config.seed !== undefined) {
    tasks = seededShuffle(tasks, config.seed);
  }

  // Limit number of tasks
  if (config.maxTasks && config.maxTasks > 0) {
    tasks = tasks.slice(0, config.maxTasks);
  }

  return tasks;
}

/**
 * Returns tasks grouped by category with counts.
 */
export function getCorpusSummary(): Record<EvalTaskCategory, number> {
  const summary: Record<EvalTaskCategory, number> = {
    'file-creation': 0,
    'refactoring': 0,
    'bug-fix': 0,
    'test-writing': 0,
  };

  for (const task of EVAL_CORPUS) {
    summary[task.category]++;
  }

  return summary;
}

/**
 * Retrieves a single task by ID.
 */
export function getTaskById(id: string): EvalTask | undefined {
  return EVAL_CORPUS.find(t => t.id === id);
}

/**
 * Seeded pseudo-random shuffle for reproducible task ordering.
 * Uses a simple linear congruential generator.
 */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array];
  let s = seed;

  for (let i = result.length - 1; i > 0; i--) {
    // LCG: next = (a * current + c) mod m
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = ((s >>> 0) % (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}
