/**
 * Eval Task Definitions — KPI-oriented evaluation tasks
 *
 * Defines the EvalTask interface with programmatic success checks and maintains
 * a fixed task suite of 30+ tasks spanning small builds, bug fixes, and refactors
 * across Node, Python, and static projects.
 *
 * Requirements: 23.3, 23.4, 23.5, 23.6
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Categories of coding tasks aligned with the unified intent gate design */
export type EvalTaskCategory = 'small_build' | 'bug_fix' | 'refactor';

/** Language/project type for the eval task */
export type EvalTaskLanguage = 'node' | 'python' | 'static';

/**
 * A single evaluation task with a programmatic success check.
 * Each task represents a real coding scenario that the pipeline must solve.
 */
export interface EvalTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable description of the task */
  description: string;
  /** Category of the coding task */
  category: EvalTaskCategory;
  /** Target language/project type */
  language: EvalTaskLanguage;
  /**
   * Programmatic success check that validates task completion.
   * Receives the workspace directory path and returns true if the task was completed successfully.
   */
  successCheck: (workspace: string) => Promise<boolean>;
}

// ─── Success Check Helpers ───────────────────────────────────────────────────

/** Checks that specified files exist in the workspace */
function filesExist(workspace: string, files: string[]): boolean {
  return files.every(f => fs.existsSync(path.join(workspace, f)));
}

/** Checks that a file contains specific content */
function fileContains(workspace: string, filePath: string, content: string): boolean {
  const fullPath = path.join(workspace, filePath);
  if (!fs.existsSync(fullPath)) return false;
  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  return fileContent.includes(content);
}

/** Checks that a file matches a regex pattern */
function fileMatches(workspace: string, filePath: string, pattern: RegExp): boolean {
  const fullPath = path.join(workspace, filePath);
  if (!fs.existsSync(fullPath)) return false;
  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  return pattern.test(fileContent);
}

/** Checks that a package.json has a specific dependency */
function hasDependency(workspace: string, dep: string): boolean {
  const pkgPath = path.join(workspace, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);
  } catch {
    return false;
  }
}

/** Checks that a Python requirements file has a specific package */
function hasPythonDep(workspace: string, dep: string): boolean {
  const reqPath = path.join(workspace, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return false;
  const content = fs.readFileSync(reqPath, 'utf-8');
  return content.toLowerCase().includes(dep.toLowerCase());
}

// ─── Task Suite ──────────────────────────────────────────────────────────────

/**
 * The fixed evaluation task suite.
 * Contains 32 tasks across small_build, bug_fix, and refactor categories
 * spanning Node, Python, and static projects.
 */
export const EVAL_TASK_SUITE: EvalTask[] = [
  // ─── Small Build Tasks — Node (6 tasks) ────────────────────────────

  {
    id: 'sb-node-001',
    description: 'Create a Node.js Express REST API with health check endpoint returning JSON status',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/server.ts', 'package.json']) &&
        fileContains(workspace, 'src/server.ts', 'health') &&
        hasDependency(workspace, 'express');
    },
  },
  {
    id: 'sb-node-002',
    description: 'Create a CLI tool that reads a JSON file and validates it against a Zod schema',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/cli.ts', 'src/schema.ts', 'package.json']) &&
        fileContains(workspace, 'src/schema.ts', 'z.object');
    },
  },
  {
    id: 'sb-node-003',
    description: 'Create a WebSocket echo server with connection tracking and graceful shutdown',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/ws-server.ts', 'package.json']) &&
        fileMatches(workspace, 'src/ws-server.ts', /WebSocket|ws/);
    },
  },
  {
    id: 'sb-node-004',
    description: 'Create a file-based key-value store with atomic writes and TTL expiration',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/kv-store.ts']) &&
        fileMatches(workspace, 'src/kv-store.ts', /get|set|delete|ttl/i);
    },
  },
  {
    id: 'sb-node-005',
    description: 'Create a task queue worker that processes jobs from a SQLite-backed queue',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/queue.ts', 'src/worker.ts']) &&
        fileMatches(workspace, 'src/queue.ts', /sqlite|better-sqlite/i);
    },
  },
  {
    id: 'sb-node-006',
    description: 'Create an HTTP middleware chain with logging, rate limiting, and CORS support',
    category: 'small_build',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/middleware/index.ts']) &&
        fileMatches(workspace, 'src/middleware/index.ts', /rateLimit|cors|log/i);
    },
  },

  // ─── Small Build Tasks — Python (5 tasks) ─────────────────────────

  {
    id: 'sb-python-001',
    description: 'Create a Python FastAPI service with a /predict endpoint that validates input with Pydantic',
    category: 'small_build',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['main.py', 'requirements.txt']) &&
        fileContains(workspace, 'main.py', 'FastAPI') &&
        hasPythonDep(workspace, 'fastapi');
    },
  },
  {
    id: 'sb-python-002',
    description: 'Create a Python CLI tool using Click that processes CSV files and outputs summary statistics',
    category: 'small_build',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['cli.py', 'requirements.txt']) &&
        fileContains(workspace, 'cli.py', '@click') &&
        hasPythonDep(workspace, 'click');
    },
  },
  {
    id: 'sb-python-003',
    description: 'Create a Python async task scheduler with cron-like syntax and SQLite persistence',
    category: 'small_build',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['scheduler.py']) &&
        fileMatches(workspace, 'scheduler.py', /async|asyncio|sqlite/i);
    },
  },
  {
    id: 'sb-python-004',
    description: 'Create a Python data pipeline that reads JSON, transforms with pandas, and writes Parquet',
    category: 'small_build',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['pipeline.py', 'requirements.txt']) &&
        hasPythonDep(workspace, 'pandas');
    },
  },
  {
    id: 'sb-python-005',
    description: 'Create a Python HTTP client wrapper with retry logic, circuit breaker, and structured logging',
    category: 'small_build',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['http_client.py']) &&
        fileMatches(workspace, 'http_client.py', /retry|circuit.?breaker/i);
    },
  },

  // ─── Small Build Tasks — Static (3 tasks) ─────────────────────────

  {
    id: 'sb-static-001',
    description: 'Create a static landing page with responsive grid layout, dark mode toggle, and contact form',
    category: 'small_build',
    language: 'static',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['index.html', 'styles.css']) &&
        fileMatches(workspace, 'styles.css', /dark|@media/i);
    },
  },
  {
    id: 'sb-static-002',
    description: 'Create a Markdown documentation site with navigation sidebar and syntax highlighting',
    category: 'small_build',
    language: 'static',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['index.html']) &&
        fileMatches(workspace, 'index.html', /highlight|prism|hljs/i);
    },
  },
  {
    id: 'sb-static-003',
    description: 'Create a static dashboard with charts using Chart.js and data loaded from a JSON file',
    category: 'small_build',
    language: 'static',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['index.html', 'data.json']) &&
        fileMatches(workspace, 'index.html', /chart/i);
    },
  },

  // ─── Bug Fix Tasks — Node (5 tasks) ───────────────────────────────

  {
    id: 'bf-node-001',
    description: 'Fix race condition in concurrent database writes causing unique constraint violations',
    category: 'bug_fix',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/db.ts']) &&
        fileMatches(workspace, 'src/db.ts', /transaction|mutex|lock|serialize/i);
    },
  },
  {
    id: 'bf-node-002',
    description: 'Fix memory leak in event listener registration that grows unbounded on reconnect',
    category: 'bug_fix',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/connection.ts']) &&
        fileMatches(workspace, 'src/connection.ts', /removeListener|removeAllListeners|off\(/i);
    },
  },
  {
    id: 'bf-node-003',
    description: 'Fix off-by-one error in pagination that returns duplicate items at page boundaries',
    category: 'bug_fix',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/pagination.ts']) &&
        fileMatches(workspace, 'src/pagination.ts', /offset|skip|limit/i);
    },
  },
  {
    id: 'bf-node-004',
    description: 'Fix unhandled promise rejection in async middleware causing silent request drops',
    category: 'bug_fix',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/middleware.ts']) &&
        fileMatches(workspace, 'src/middleware.ts', /catch|try.*await|asyncHandler/i);
    },
  },
  {
    id: 'bf-node-005',
    description: 'Fix incorrect JSON parsing of large numbers causing precision loss in financial calculations',
    category: 'bug_fix',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/parser.ts']) &&
        fileMatches(workspace, 'src/parser.ts', /BigInt|Decimal|bigint|precision/i);
    },
  },

  // ─── Bug Fix Tasks — Python (4 tasks) ─────────────────────────────

  {
    id: 'bf-python-001',
    description: 'Fix incorrect timezone conversion that produces wrong UTC offsets during DST transitions',
    category: 'bug_fix',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['time_utils.py']) &&
        fileMatches(workspace, 'time_utils.py', /pytz|zoneinfo|timezone/i);
    },
  },
  {
    id: 'bf-python-002',
    description: 'Fix SQL injection vulnerability in dynamic query builder using string interpolation',
    category: 'bug_fix',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['query_builder.py']) &&
        fileMatches(workspace, 'query_builder.py', /parameterized|\?|%s|:param/i);
    },
  },
  {
    id: 'bf-python-003',
    description: 'Fix deadlock in producer-consumer pattern when queue is full and both threads block',
    category: 'bug_fix',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['worker.py']) &&
        fileMatches(workspace, 'worker.py', /timeout|non.?blocking|try_put|Queue/i);
    },
  },
  {
    id: 'bf-python-004',
    description: 'Fix file handle leak in CSV processor that exhausts OS file descriptor limit',
    category: 'bug_fix',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['csv_processor.py']) &&
        fileMatches(workspace, 'csv_processor.py', /with\s+open|contextmanager|finally.*close/i);
    },
  },

  // ─── Bug Fix Tasks — Static (2 tasks) ─────────────────────────────

  {
    id: 'bf-static-001',
    description: 'Fix CSS z-index stacking context that causes modal to render behind overlay',
    category: 'bug_fix',
    language: 'static',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['modal.css']) &&
        fileMatches(workspace, 'modal.css', /z-index|isolation|stacking/i);
    },
  },
  {
    id: 'bf-static-002',
    description: 'Fix accessibility issues: missing alt attributes, broken focus order, and insufficient contrast',
    category: 'bug_fix',
    language: 'static',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['index.html']) &&
        fileMatches(workspace, 'index.html', /alt=|aria-|role=/i);
    },
  },

  // ─── Refactor Tasks — Node (4 tasks) ──────────────────────────────

  {
    id: 'rf-node-001',
    description: 'Refactor monolithic request handler into controller/service/repository layers',
    category: 'refactor',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/controller.ts', 'src/service.ts', 'src/repository.ts']);
    },
  },
  {
    id: 'rf-node-002',
    description: 'Refactor callback-based file processing pipeline to use async iterators and streams',
    category: 'refactor',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/pipeline.ts']) &&
        fileMatches(workspace, 'src/pipeline.ts', /async\s*\*|for\s+await|Readable|Transform/i);
    },
  },
  {
    id: 'rf-node-003',
    description: 'Refactor hard-coded config values into environment-driven typed configuration module',
    category: 'refactor',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/config.ts']) &&
        fileMatches(workspace, 'src/config.ts', /process\.env|z\.object|interface.*Config/i);
    },
  },
  {
    id: 'rf-node-004',
    description: 'Refactor class hierarchy with deep inheritance into composition with dependency injection',
    category: 'refactor',
    language: 'node',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['src/services/index.ts']) &&
        fileMatches(workspace, 'src/services/index.ts', /inject|interface|constructor\(/i);
    },
  },

  // ─── Refactor Tasks — Python (3 tasks) ────────────────────────────

  {
    id: 'rf-python-001',
    description: 'Refactor synchronous data pipeline to use asyncio with concurrent fetch stages',
    category: 'refactor',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['pipeline.py']) &&
        fileMatches(workspace, 'pipeline.py', /async\s+def|await|asyncio\.gather/i);
    },
  },
  {
    id: 'rf-python-002',
    description: 'Refactor global state module into a dependency-injected service container',
    category: 'refactor',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['container.py']) &&
        fileMatches(workspace, 'container.py', /inject|class.*Container|@provider/i);
    },
  },
  {
    id: 'rf-python-003',
    description: 'Refactor raw SQL queries scattered across codebase into SQLAlchemy ORM models',
    category: 'refactor',
    language: 'python',
    successCheck: async (workspace) => {
      return filesExist(workspace, ['models.py']) &&
        fileMatches(workspace, 'models.py', /Base|Column|relationship|declarative/i);
    },
  },
];

// ─── Smoke Subset ────────────────────────────────────────────────────────────

/**
 * IDs of the 10-task smoke subset for PR validation.
 * Covers at least one task per category/language combination.
 */
export const SMOKE_SUBSET_IDS: string[] = [
  'sb-node-001',    // small_build / node
  'sb-node-004',    // small_build / node
  'sb-python-001',  // small_build / python
  'sb-static-001',  // small_build / static
  'bf-node-001',    // bug_fix / node
  'bf-node-003',    // bug_fix / node
  'bf-python-002',  // bug_fix / python
  'bf-static-001',  // bug_fix / static
  'rf-node-001',    // refactor / node
  'rf-python-001',  // refactor / python
];

// ─── Retrieval Helpers ───────────────────────────────────────────────────────

/** Returns the full eval task suite */
export function getEvalTaskSuite(): EvalTask[] {
  return [...EVAL_TASK_SUITE];
}

/** Returns the 10-task smoke subset for PR validation */
export function getSmokeSubset(): EvalTask[] {
  return EVAL_TASK_SUITE.filter(t => SMOKE_SUBSET_IDS.includes(t.id));
}

/** Returns tasks filtered by category */
export function getTasksByCategory(category: EvalTaskCategory): EvalTask[] {
  return EVAL_TASK_SUITE.filter(t => t.category === category);
}

/** Returns tasks filtered by language */
export function getTasksByLanguage(language: EvalTaskLanguage): EvalTask[] {
  return EVAL_TASK_SUITE.filter(t => t.language === language);
}

/** Retrieves a single task by ID */
export function getEvalTaskById(id: string): EvalTask | undefined {
  return EVAL_TASK_SUITE.find(t => t.id === id);
}

/** Returns the total count of tasks in the suite */
export function getEvalTaskCount(): number {
  return EVAL_TASK_SUITE.length;
}
