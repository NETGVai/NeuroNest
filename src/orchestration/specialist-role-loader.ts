/**
 * SpecialistRoleLoader — Defines and enforces specialist agent roles
 * with distinct tool permissions and file access scopes.
 *
 * Supports four built-in roles (architect, implementer, reviewer, tester)
 * and user-defined custom roles via configuration. Each role has a
 * system prompt, allowed tools list, and file permission globs.
 *
 * Tags outputs with originating role for provenance tracking.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

// ─── Types ──────────────────────────────────────────────────────

export interface SpecialistRole {
  id: string;
  name: 'architect' | 'implementer' | 'reviewer' | 'tester' | string;
  systemPrompt: string;
  allowedTools: string[];       // tool IDs this role can use
  filePermissions: string[];    // glob patterns for allowed file access
  skillAllowlist?: string[];    // skill IDs this role is allowed to receive; if undefined, all skills allowed
}

export interface RoleTaggedOutput {
  role: string;
  output: unknown;
  timestamp: string;
}

export interface ToolAccessViolation {
  roleName: string;
  toolId: string;
  timestamp: string;
}

export type TaskClassification =
  | 'architecture'
  | 'implementation'
  | 'review'
  | 'testing'
  | 'general';

// ─── Built-in Roles ─────────────────────────────────────────────

export const BUILT_IN_ROLES: SpecialistRole[] = [
  {
    id: 'architect',
    name: 'architect',
    systemPrompt:
      'You are a software architect. Focus on system design, architecture decisions, ' +
      'interface definitions, and high-level structure. Avoid writing implementation code directly.',
    allowedTools: [
      'read_file',
      'list_directory',
      'grep_search',
      'file_search',
      'web_search',
      'create_plan',
      'ask_user',
    ],
    filePermissions: ['**/*'],
  },
  {
    id: 'implementer',
    name: 'implementer',
    systemPrompt:
      'You are a code implementer. Focus on writing clean, correct, and efficient code ' +
      'following established patterns and conventions. Follow the architecture decisions made by the architect.',
    allowedTools: [
      'read_file',
      'write_file',
      'list_directory',
      'grep_search',
      'file_search',
      'execute_command',
      'ask_user',
    ],
    filePermissions: ['src/**/*', 'tests/**/*', 'package.json'],
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    systemPrompt:
      'You are a code reviewer. Evaluate code quality, correctness, security, and adherence ' +
      'to acceptance criteria. Provide specific, actionable feedback without making changes yourself.',
    allowedTools: [
      'read_file',
      'list_directory',
      'grep_search',
      'file_search',
      'ask_user',
    ],
    filePermissions: ['**/*'],
  },
  {
    id: 'tester',
    name: 'tester',
    systemPrompt:
      'You are a test engineer. Focus on writing comprehensive tests, identifying edge cases, ' +
      'and ensuring code correctness through property-based and unit testing.',
    allowedTools: [
      'read_file',
      'write_file',
      'list_directory',
      'grep_search',
      'file_search',
      'execute_command',
      'ask_user',
    ],
    filePermissions: ['src/**/*', 'tests/**/*', '**/*.test.*', '**/*.spec.*'],
  },
];

// ─── Glob Matching ──────────────────────────────────────────────

/**
 * Simple glob matcher supporting `*` (single segment) and `**` (any segments).
 *
 * Converts a glob pattern to a regex for matching file paths.
 * Supports common patterns like `src/**\/*`, `*.ts`, `**\/*.test.*`.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob pattern to regex
  let regexStr = '^';
  let i = 0;

  while (i < normalizedPattern.length) {
    const char = normalizedPattern[i]!;

    if (char === '*') {
      if (normalizedPattern[i + 1] === '*') {
        // `**` matches any number of path segments
        if (normalizedPattern[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // `*` matches anything within a single path segment (no slashes)
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (char === '.') {
      regexStr += '\\.';
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  regexStr += '$';

  try {
    const regex = new RegExp(regexStr);
    return regex.test(normalizedPath);
  } catch {
    // If regex construction fails, deny access
    return false;
  }
}

// ─── Task Classification ────────────────────────────────────────

/**
 * Classify a task description to determine which specialist role should handle it.
 *
 * Uses keyword matching to categorize tasks into architecture, implementation,
 * review, or testing categories.
 */
export function classifyTaskForRole(taskDescription: string): TaskClassification {
  const lower = taskDescription.toLowerCase();

  const architectureKeywords = [
    'architect',
    'design',
    'structure',
    'interface',
    'api design',
    'system design',
    'high-level',
    'module layout',
    'dependency graph',
    'data model',
  ];

  const reviewKeywords = [
    'review',
    'validate',
    'check',
    'verify',
    'audit',
    'evaluate',
    'assess',
    'quality',
    'criteria',
  ];

  const testingKeywords = [
    'test',
    'spec',
    'assertion',
    'coverage',
    'property-based',
    'unit test',
    'integration test',
    'edge case',
  ];

  const implementationKeywords = [
    'implement',
    'create',
    'build',
    'write',
    'code',
    'fix',
    'refactor',
    'add feature',
    'develop',
    'modify',
  ];

  // Score each category by keyword matches
  const scores: Record<TaskClassification, number> = {
    architecture: 0,
    implementation: 0,
    review: 0,
    testing: 0,
    general: 0,
  };

  for (const kw of architectureKeywords) {
    if (lower.includes(kw)) scores.architecture++;
  }
  for (const kw of reviewKeywords) {
    if (lower.includes(kw)) scores.review++;
  }
  for (const kw of testingKeywords) {
    if (lower.includes(kw)) scores.testing++;
  }
  for (const kw of implementationKeywords) {
    if (lower.includes(kw)) scores.implementation++;
  }

  // Find the highest scoring category
  let best: TaskClassification = 'general';
  let bestScore = 0;

  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = key as TaskClassification;
    }
  }

  return best;
}

/**
 * Map a task classification to the default role name.
 */
export function classificationToRole(classification: TaskClassification): string {
  switch (classification) {
    case 'architecture':
      return 'architect';
    case 'implementation':
      return 'implementer';
    case 'review':
      return 'reviewer';
    case 'testing':
      return 'tester';
    case 'general':
      return 'implementer'; // Default to implementer for unclassified tasks
  }
}

// ─── SpecialistRoleLoader ───────────────────────────────────────

export class SpecialistRoleLoader {
  private roles: Map<string, SpecialistRole> = new Map();
  private violations: ToolAccessViolation[] = [];

  /**
   * Create a SpecialistRoleLoader with built-in and optional custom roles.
   *
   * @param customRoles User-defined custom roles that extend or override built-in roles.
   *   When a custom role has the same `id` as a built-in role, the custom role takes precedence.
   */
  constructor(customRoles: SpecialistRole[] = []) {
    // Load built-in roles first
    for (const role of BUILT_IN_ROLES) {
      this.roles.set(role.id, role);
    }

    // User-defined custom roles override built-in ones with the same id
    for (const role of customRoles) {
      this.roles.set(role.id, role);
    }
  }

  /**
   * Get a role configuration by name/id.
   *
   * Returns `null` if the role does not exist.
   */
  getRole(name: string): SpecialistRole | null {
    return this.roles.get(name) ?? null;
  }

  /**
   * Get all registered roles.
   */
  getAllRoles(): SpecialistRole[] {
    return Array.from(this.roles.values());
  }

  /**
   * Check if a role has permission to use a specific tool.
   *
   * Returns `true` if the tool ID is in the role's `allowedTools` list.
   * Returns `false` and logs a violation if the tool is not permitted.
   * Returns `false` if the role does not exist.
   */
  canUseTool(roleName: string, toolId: string): boolean {
    const role = this.roles.get(roleName);
    if (!role) {
      return false;
    }

    const allowed = role.allowedTools.includes(toolId);

    if (!allowed) {
      this.violations.push({
        roleName,
        toolId,
        timestamp: new Date().toISOString(),
      });
    }

    return allowed;
  }

  /**
   * Check if a role can access a specific file path.
   *
   * Matches the file path against the role's `filePermissions` glob patterns.
   * Returns `true` if any permission pattern matches.
   * Returns `false` if the role does not exist or no pattern matches.
   */
  canAccessFile(roleName: string, filePath: string): boolean {
    const role = this.roles.get(roleName);
    if (!role) {
      return false;
    }

    return role.filePermissions.some((pattern) => matchGlob(pattern, filePath));
  }

  /**
   * Tag an output with the originating role for provenance tracking (Req 15.3).
   */
  tagOutput(roleName: string, output: unknown): RoleTaggedOutput {
    return {
      role: roleName,
      output,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Route a task to the appropriate specialist role based on task classification (Req 15.2).
   *
   * Returns the role name best suited for the given task description.
   * Falls back to 'implementer' if no strong match.
   */
  routeTask(taskDescription: string): string {
    const classification = classifyTaskForRole(taskDescription);
    return classificationToRole(classification);
  }

  /**
   * Get all recorded tool access violations for auditing.
   */
  getViolations(): ToolAccessViolation[] {
    return [...this.violations];
  }

  /**
   * Clear recorded violations (e.g., after exporting to trace service).
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Check if a role exists in the loader.
   */
  hasRole(name: string): boolean {
    return this.roles.has(name);
  }

  /**
   * Filter a list of skill IDs against the role's skillAllowlist (Req 5.5).
   *
   * Only skills on the allowlist are injectable; non-allowlisted skills are
   * silently dropped regardless of keyword match.
   *
   * If the role has no skillAllowlist defined (undefined), all skills are allowed.
   * If the role does not exist, returns an empty array.
   */
  filterSkillsByAllowlist(roleName: string, skillIds: string[]): string[] {
    const role = this.roles.get(roleName);
    if (!role) {
      return [];
    }

    // If no allowlist is defined, all skills pass through
    if (role.skillAllowlist === undefined) {
      return [...skillIds];
    }

    // Only return skills that appear in the allowlist
    return skillIds.filter((skillId) => role.skillAllowlist!.includes(skillId));
  }
}
