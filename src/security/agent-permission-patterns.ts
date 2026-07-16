/**
 * Agent Permission Patterns — Mechanical conversion of per-agent allowlists to pattern sets.
 *
 * This module converts the legacy `AGENT_TOOL_PERMISSIONS` (agent → ToolPermission)
 * into per-agent pattern sets using the PermissionPatternEngine pattern format:
 * `ToolName(arg_pattern)`.
 *
 * Conversion rules:
 *   - `read: true`    → `file_read(*)`, `glob(*)`, `grep(*)`, `semantic_search(*)`, `list_directory(*)`, `get_file_info(*)`
 *   - `edit: true`    → `file_write(*)`, `file_edit(*)`, `str_replace(*)`, `anchored_edit(*)`
 *   - `edit: '*.md'`  → `file_write(*.md)`, `file_edit(*.md)`, `str_replace(*.md)`, `anchored_edit(*.md)`
 *   - `command: true`  → `bash(*)`, `shell(*)`
 *   - `mcp: true`     → `mcp_call(*)`
 *
 * Per the design, tier priorities for pattern evaluation are:
 *   managed > project > local > per-agent > user
 *
 * The per-agent patterns fit at the "per-agent" tier level in the
 * PermissionPatternEngine evaluation hierarchy.
 *
 * Requirements: 10.4, 10.11, 10.13
 */

import { AGENT_TOOL_PERMISSIONS, type ToolPermission, checkToolPermission } from '../agents/agent-registry.js';
import type { PermissionConfig } from './permission-pattern-engine.js';

// ─── Tool Name Constants ────────────────────────────────────────

/** Tools that correspond to the `read` permission */
const READ_TOOLS = [
  'file_read',
  'glob',
  'grep',
  'semantic_search',
  'list_directory',
  'get_file_info',
  'web_fetch',
  'web_search',
] as const;

/** Tools that correspond to the `edit` permission */
const EDIT_TOOLS = [
  'file_write',
  'file_edit',
  'str_replace',
  'anchored_edit',
] as const;

/** Tools that correspond to the `command` permission */
const COMMAND_TOOLS = [
  'bash',
  'shell',
] as const;

/** Tools that correspond to the `mcp` permission */
const MCP_TOOLS = [
  'mcp_call',
] as const;

// ─── Types ──────────────────────────────────────────────────────

/** Result of converting a single agent's permissions to patterns */
export interface AgentPatternConversion {
  agentId: string;
  originalPermissions: ToolPermission;
  patterns: PermissionConfig;
  patternCount: number;
}

/** Decision parity report entry */
export interface ParityReportEntry {
  agentId: string;
  toolName: string;
  operation: 'read' | 'edit' | 'command' | 'mcp';
  filePath?: string | undefined;
  oldDecision: boolean;
  newDecision: boolean;
  match: boolean;
}

/** Summary of the parity report */
export interface ParityReportSummary {
  totalChecks: number;
  matches: number;
  mismatches: number;
  mismatchRate: string;
  entries: ParityReportEntry[];
}

// ─── Conversion Logic ───────────────────────────────────────────

/**
 * Convert a single ToolPermission into a PermissionConfig with allow/deny patterns.
 *
 * The conversion is mechanical:
 *   - Permission `true` → allow patterns with wildcard `(*)`
 *   - Permission `false` → deny patterns for those tools
 *   - Permission glob string (e.g. '*.md') → allow patterns with that glob
 */
export function convertPermissionToPatterns(permission: ToolPermission): PermissionConfig {
  const allow: string[] = [];
  const deny: string[] = [];

  // Read permission
  if (permission.read === true) {
    for (const tool of READ_TOOLS) {
      allow.push(`${tool}(*)`);
    }
  } else {
    for (const tool of READ_TOOLS) {
      deny.push(`${tool}(*)`);
    }
  }

  // Edit permission
  if (permission.edit === true) {
    for (const tool of EDIT_TOOLS) {
      allow.push(`${tool}(*)`);
    }
  } else if (typeof permission.edit === 'string') {
    // Glob-restricted edit (e.g., '*.md')
    for (const tool of EDIT_TOOLS) {
      allow.push(`${tool}(${permission.edit})`);
    }
  } else {
    for (const tool of EDIT_TOOLS) {
      deny.push(`${tool}(*)`);
    }
  }

  // Command permission
  if (permission.command === true) {
    for (const tool of COMMAND_TOOLS) {
      allow.push(`${tool}(*)`);
    }
  } else {
    for (const tool of COMMAND_TOOLS) {
      deny.push(`${tool}(*)`);
    }
  }

  // MCP permission
  if (permission.mcp === true) {
    for (const tool of MCP_TOOLS) {
      allow.push(`${tool}(*)`);
    }
  } else {
    for (const tool of MCP_TOOLS) {
      deny.push(`${tool}(*)`);
    }
  }

  return { allow, deny };
}

/**
 * Convert all agent tool permissions into a map of per-agent pattern sets.
 * This is the primary entry point for mechanical migration (Req 10.11).
 *
 * Returns a Map<agentId, PermissionConfig> ready to be loaded into
 * the PermissionPatternEngine via `setAllPerAgentPatterns()`.
 */
export function convertAllAgentPermissions(): Map<string, PermissionConfig> {
  const result = new Map<string, PermissionConfig>();

  for (const [agentId, permission] of Object.entries(AGENT_TOOL_PERMISSIONS)) {
    result.set(agentId, convertPermissionToPatterns(permission));
  }

  return result;
}

/**
 * Convert all agent tool permissions and return detailed conversion info.
 */
export function convertAllAgentPermissionsDetailed(): AgentPatternConversion[] {
  const results: AgentPatternConversion[] = [];

  for (const [agentId, permission] of Object.entries(AGENT_TOOL_PERMISSIONS)) {
    const patterns = convertPermissionToPatterns(permission);
    results.push({
      agentId,
      originalPermissions: permission,
      patterns,
      patternCount: patterns.allow.length + patterns.deny.length,
    });
  }

  return results;
}

// ─── Decision Parity Verification ───────────────────────────────

/**
 * Simulates the old `checkToolPermission` decision for a given agent/operation/path
 * and compares it to what the new pattern set would produce.
 *
 * This is used to produce the decision-parity report (Req 10.13).
 */
function evaluatePatternDecision(
  patterns: PermissionConfig,
  toolName: string,
  args: string,
): boolean {
  // Check deny first
  for (const pattern of patterns.deny) {
    const parsed = parsePatternSimple(pattern);
    if (parsed && parsed.tool === toolName && matchGlob(parsed.argPattern, args)) {
      return false;
    }
  }

  // Check allow
  for (const pattern of patterns.allow) {
    const parsed = parsePatternSimple(pattern);
    if (parsed && parsed.tool === toolName && matchGlob(parsed.argPattern, args)) {
      return true;
    }
  }

  // No match = denied (default-deny for per-agent patterns)
  return false;
}

/**
 * Simple pattern parser for parity checking (avoids circular dependency
 * with the full PermissionPatternEngine).
 */
function parsePatternSimple(pattern: string): { tool: string; argPattern: string } | null {
  const match = pattern.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/);
  if (!match) return null;
  return { tool: match[1]!, argPattern: match[2]! };
}

/**
 * Simple glob matcher for parity checking.
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;

  // For patterns like "*.md", check if value ends with the suffix
  if (pattern.startsWith('*')) {
    return value.endsWith(pattern.slice(1));
  }

  return pattern === value;
}

/**
 * Produce a decision-parity report comparing the old checkToolPermission
 * behavior against the new pattern-based evaluation (Req 10.13).
 *
 * This verifies that the mechanical conversion produces identical
 * authorization decisions for all agents on a representative test corpus.
 */
export function produceParityReport(): ParityReportSummary {
  const entries: ParityReportEntry[] = [];
  const conversions = convertAllAgentPermissions();

  // Representative test corpus of tool calls
  const testCorpus: Array<{
    operation: 'read' | 'edit' | 'command' | 'mcp';
    toolName: string;
    args: string;
    filePath?: string;
  }> = [
    // Read operations
    { operation: 'read', toolName: 'file_read', args: 'src/index.ts' },
    { operation: 'read', toolName: 'glob', args: '**/*.ts' },
    { operation: 'read', toolName: 'grep', args: 'function' },
    { operation: 'read', toolName: 'semantic_search', args: 'authentication' },
    { operation: 'read', toolName: 'list_directory', args: 'src/' },
    { operation: 'read', toolName: 'get_file_info', args: 'package.json' },
    { operation: 'read', toolName: 'web_fetch', args: 'https://example.com' },
    { operation: 'read', toolName: 'web_search', args: 'typescript generics' },

    // Edit operations
    { operation: 'edit', toolName: 'file_write', args: 'src/main.ts', filePath: 'src/main.ts' },
    { operation: 'edit', toolName: 'file_edit', args: 'src/utils.ts', filePath: 'src/utils.ts' },
    { operation: 'edit', toolName: 'str_replace', args: 'src/app.ts', filePath: 'src/app.ts' },
    { operation: 'edit', toolName: 'file_write', args: 'docs/README.md', filePath: 'docs/README.md' },
    { operation: 'edit', toolName: 'file_edit', args: 'notes.md', filePath: 'notes.md' },

    // Command operations
    { operation: 'command', toolName: 'bash', args: 'npm test' },
    { operation: 'command', toolName: 'shell', args: 'git status' },
    { operation: 'command', toolName: 'bash', args: 'rm -rf node_modules' },

    // MCP operations
    { operation: 'mcp', toolName: 'mcp_call', args: 'search_docs' },
  ];

  for (const [agentId, patterns] of conversions) {
    for (const testCase of testCorpus) {
      // Old decision
      const oldResult = checkToolPermission(agentId, testCase.operation, testCase.filePath);
      const oldDecision = oldResult.allowed;

      // New pattern-based decision
      const newDecision = evaluatePatternDecision(patterns, testCase.toolName, testCase.args);

      entries.push({
        agentId,
        toolName: testCase.toolName,
        operation: testCase.operation,
        filePath: testCase.filePath,
        oldDecision,
        newDecision,
        match: oldDecision === newDecision,
      });
    }
  }

  const totalChecks = entries.length;
  const matches = entries.filter((e) => e.match).length;
  const mismatches = totalChecks - matches;
  const mismatchRate = totalChecks > 0
    ? ((mismatches / totalChecks) * 100).toFixed(2) + '%'
    : '0%';

  return {
    totalChecks,
    matches,
    mismatches,
    mismatchRate,
    entries,
  };
}

/**
 * Format the parity report as a human-readable string suitable for
 * documentation or CI output.
 */
export function formatParityReport(report: ParityReportSummary): string {
  const lines: string[] = [
    '# Per-Agent Permission Pattern Migration — Decision Parity Report',
    '',
    '## Summary',
    '',
    `- Total checks: ${report.totalChecks}`,
    `- Matches: ${report.matches}`,
    `- Mismatches: ${report.mismatches}`,
    `- Mismatch rate: ${report.mismatchRate}`,
    '',
  ];

  if (report.mismatches > 0) {
    lines.push('## Mismatches', '');
    lines.push('| Agent | Tool | Operation | File | Old | New |');
    lines.push('|-------|------|-----------|------|-----|-----|');

    for (const entry of report.entries.filter((e) => !e.match)) {
      lines.push(
        `| ${entry.agentId} | ${entry.toolName} | ${entry.operation} | ${entry.filePath ?? '-'} | ${entry.oldDecision ? 'allow' : 'deny'} | ${entry.newDecision ? 'allow' : 'deny'} |`
      );
    }
    lines.push('');
  }

  lines.push('## Conversion Details', '');
  lines.push(`Total agents converted: ${Object.keys(AGENT_TOOL_PERMISSIONS).length}`);
  lines.push('');

  const conversions = convertAllAgentPermissionsDetailed();
  const totalPatterns = conversions.reduce((sum, c) => sum + c.patternCount, 0);
  lines.push(`Total patterns generated: ${totalPatterns}`);
  lines.push('');

  // Group by permission profile type
  const profiles = new Map<string, string[]>();
  for (const conversion of conversions) {
    const key = profileKey(conversion.originalPermissions);
    if (!profiles.has(key)) {
      profiles.set(key, []);
    }
    profiles.get(key)!.push(conversion.agentId);
  }

  lines.push('## Permission Profiles', '');
  lines.push('| Profile | Agent Count | Example Agents |');
  lines.push('|---------|-------------|----------------|');

  for (const [key, agents] of profiles) {
    const examples = agents.slice(0, 3).join(', ') + (agents.length > 3 ? '...' : '');
    lines.push(`| ${key} | ${agents.length} | ${examples} |`);
  }

  return lines.join('\n');
}

/**
 * Create a short key describing a permission profile for grouping.
 */
function profileKey(perm: ToolPermission): string {
  const r = perm.read ? 'R' : '-';
  const e = perm.edit === true ? 'W' : typeof perm.edit === 'string' ? `W(${perm.edit})` : '-';
  const c = perm.command ? 'X' : '-';
  const m = perm.mcp ? 'M' : '-';
  return `${r}${e}${c}${m}`;
}

// ─── Integration Helper ─────────────────────────────────────────

/**
 * Load all per-agent patterns into a PermissionPatternEngine instance.
 * This should be called during engine initialization to wire up the per-agent tier.
 *
 * Usage:
 * ```typescript
 * import { PermissionPatternEngine } from './permission-pattern-engine.js';
 * import { loadAgentPatternsIntoEngine } from './agent-permission-patterns.js';
 *
 * const engine = new PermissionPatternEngine(workspacePath);
 * loadAgentPatternsIntoEngine(engine);
 * ```
 */
export function loadAgentPatternsIntoEngine(
  engine: { setAllPerAgentPatterns: (patterns: Map<string, PermissionConfig>) => void }
): void {
  const patterns = convertAllAgentPermissions();
  engine.setAllPerAgentPatterns(patterns);
}

/**
 * Total count of permission entries being migrated.
 * Each agent has 4 permission categories (read, edit, command, mcp),
 * making the total entries = agents * 4.
 */
export const MIGRATED_PERMISSION_COUNT = Object.keys(AGENT_TOOL_PERMISSIONS).length * 4;

/**
 * Total count of agents with permission entries.
 */
export const MIGRATED_AGENT_COUNT = Object.keys(AGENT_TOOL_PERMISSIONS).length;
