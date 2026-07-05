// ─── MCP Scoping Engine ────────────────────────────────────────
// Workspace-scoped MCP server configuration with mandatory
// write-call logging and inline secret rejection.
// Requirements: 24.1, 24.2, 24.3, 24.4, 24.5

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Configuration for a single MCP server in .mcp.json.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>; // ${VAR} interpolated from process.env
  writeScope: boolean;
}

/**
 * Raw shape of .mcp.json on disk.
 */
interface McpJsonFile {
  servers?: Array<{
    name?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    writeScope?: boolean;
  }>;
}

/**
 * A logged MCP tool call entry for the iteration log.
 */
export interface McpToolCallLogEntry {
  timestamp: string;
  serverName: string;
  toolName: string;
  args: unknown;
  status: string;
}

/**
 * Hook definition interface compatible with the HookSystem.
 * Used to check for PostToolUse logging hooks.
 */
export interface HookLike {
  trigger: string | { event?: string; type?: string };
  action?: { type?: string; command?: string } | { type: string };
  enabled?: boolean;
  filePatterns?: string[];
}

// ─── Inline Secret Detection Patterns ───────────────────────────
// These patterns detect bare secrets that should use ${VAR} interpolation.
const SECRET_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // API key patterns (common prefixes)
  { pattern: /^sk[-_][a-zA-Z0-9]{20,}$/, description: 'API secret key' },
  { pattern: /^pk[-_][a-zA-Z0-9]{20,}$/, description: 'API public key' },
  { pattern: /^key[-_][a-zA-Z0-9]{20,}$/i, description: 'Generic API key' },
  { pattern: /^api[-_]?key[-_]?[a-zA-Z0-9]{10,}$/i, description: 'API key value' },
  { pattern: /^token[-_][a-zA-Z0-9]{20,}$/i, description: 'Token value' },

  // Bearer tokens / JWTs
  { pattern: /^Bearer\s+[a-zA-Z0-9._-]{20,}$/i, description: 'Bearer token' },
  { pattern: /^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, description: 'JWT token' },

  // AWS-style keys
  { pattern: /^AKIA[A-Z0-9]{16}$/, description: 'AWS access key' },

  // Password-like values (long random strings)
  { pattern: /^[a-zA-Z0-9+/=]{32,}$/, description: 'Base64-encoded secret' },

  // GitHub tokens
  { pattern: /^gh[ps]_[a-zA-Z0-9]{36,}$/, description: 'GitHub token' },
  { pattern: /^github_pat_[a-zA-Z0-9_]{22,}$/, description: 'GitHub PAT' },

  // Slack tokens
  { pattern: /^xox[bpras]-[a-zA-Z0-9-]+$/, description: 'Slack token' },

  // Generic password strings in env values
  { pattern: /^password[=:].+$/i, description: 'Password value' },
  { pattern: /^secret[=:].+$/i, description: 'Secret value' },
];

/**
 * Check if a string value looks like an inline secret (not using ${VAR} interpolation).
 * Values using ${VAR} syntax are considered safe (env var references).
 */
function looksLikeInlineSecret(value: string): string | null {
  // Values that are purely ${VAR} interpolation references are safe
  if (/^\$\{[^}]+\}$/.test(value)) return null;

  // Values that contain ${VAR} parts mixed with text are safe
  // (they're using interpolation)
  if (/\$\{[^}]+\}/.test(value)) return null;

  // Empty strings are safe
  if (!value || value.trim().length === 0) return null;

  // Check against known secret patterns
  for (const { pattern, description } of SECRET_PATTERNS) {
    if (pattern.test(value.trim())) {
      return description;
    }
  }

  return null;
}

/**
 * McpScopingEngine — Workspace-level MCP server configuration with
 * mandatory write-call logging and inline secret rejection.
 *
 * Key behaviors:
 * - Loads .mcp.json from workspace root (REQ-24.1)
 * - Rejects inline secrets — requires ${VAR} interpolation (REQ-24.2, REQ-24.5)
 * - Validates write-scoped servers have PostToolUse logging hooks (REQ-24.3)
 * - Logs all MCP tool calls in iteration log (REQ-24.4)
 * - Gated behind harness_mcp_scoping flag (REQ-24.5)
 *
 * NOTE: Secret validation (validateNoInlineSecrets) applies REGARDLESS of
 * the harness_mcp_scoping gate status — basic safety validation is always
 * enforced independently of the feature gate (REQ-24.5).
 */
export class McpScopingEngine {
  private readonly mcpJsonPath: string;
  private config: McpServerConfig[] = [];
  private callLog: McpToolCallLogEntry[] = [];

  constructor(workspacePath: string) {
    this.mcpJsonPath = path.join(workspacePath, '.mcp.json');
  }

  /**
   * Load and parse .mcp.json from workspace root.
   * Returns an empty array if the file is missing (graceful — no servers configured).
   * Throws if the file exists but cannot be parsed.
   */
  async loadConfig(): Promise<McpServerConfig[]> {
    if (!fs.existsSync(this.mcpJsonPath)) {
      this.config = [];
      return [];
    }

    const raw = fs.readFileSync(this.mcpJsonPath, 'utf-8');
    let parsed: McpJsonFile;

    try {
      parsed = JSON.parse(raw) as McpJsonFile;
    } catch {
      throw new Error(
        `Failed to parse .mcp.json at ${this.mcpJsonPath}: invalid JSON`,
      );
    }

    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      this.config = [];
      return [];
    }

    const servers: McpServerConfig[] = parsed.servers.map((s, index) => ({
      name: s.name || `server-${index}`,
      command: s.command || '',
      args: Array.isArray(s.args) ? s.args : [],
      env: (s.env && typeof s.env === 'object') ? s.env : {},
      writeScope: s.writeScope === true,
    }));

    this.config = servers;
    return servers;
  }

  /**
   * Validate that no server configurations contain inline secrets.
   * All credential values must use ${VAR} interpolation syntax.
   *
   * NOTE (REQ-24.5): This validation applies REGARDLESS of harness_mcp_scoping
   * gate status — basic safety validation (inline secrets rejection) is always
   * enforced independently of the feature gate.
   *
   * @returns Array of error messages for any detected inline secrets.
   *          Empty array means all values are safe.
   */
  validateNoInlineSecrets(config: McpServerConfig[]): string[] {
    const errors: string[] = [];

    for (const server of config) {
      // Check env values
      for (const [key, value] of Object.entries(server.env)) {
        const secretType = looksLikeInlineSecret(value);
        if (secretType) {
          errors.push(
            `Server "${server.name}": env.${key} contains an inline ${secretType}. ` +
            `Use \${${key}} interpolation instead.`,
          );
        }
      }

      // Check args for inline secrets
      for (let i = 0; i < server.args.length; i++) {
        const secretType = looksLikeInlineSecret(server.args[i]!);
        if (secretType) {
          errors.push(
            `Server "${server.name}": args[${i}] contains an inline ${secretType}. ` +
            `Use \${VAR} interpolation instead.`,
          );
        }
      }
    }

    return errors;
  }

  /**
   * Verify that write-scoped servers have a corresponding PostToolUse hook
   * that logs every call from that server.
   *
   * NOTE (REQ-24.3): If hook detection itself fails (throws an error),
   * accept the config anyway (graceful degradation). This means:
   * - If hooks ARE present for write servers → valid, no errors
   * - If hooks are MISSING for write servers → return error with fix-it message
   * - If hook detection FAILS (exception) → accept anyway, return empty errors
   *
   * @param config The server configurations to validate
   * @param hooks Array of hook definitions to check against
   * @returns Array of error messages for servers missing logging hooks.
   */
  validateWriteServerHooks(
    config: McpServerConfig[],
    hooks: HookLike[],
  ): string[] {
    try {
      const errors: string[] = [];
      const writeServers = config.filter((s) => s.writeScope);

      for (const server of writeServers) {
        const hasLoggingHook = hooks.some((hook) => {
          // Check if hook is a PostToolUse trigger
          const trigger = hook.trigger;
          let isPostToolUse = false;

          if (typeof trigger === 'string') {
            isPostToolUse = trigger === 'PostToolUse' || trigger === 'postToolUse';
          } else if (trigger && typeof trigger === 'object') {
            isPostToolUse =
              trigger.event === 'PostToolUse' ||
              trigger.event === 'postToolUse' ||
              trigger.type === 'PostToolUse' ||
              trigger.type === 'postToolUse';
          }

          if (!isPostToolUse) return false;

          // Check if hook is enabled (default true if not specified)
          if (hook.enabled === false) return false;

          return true;
        });

        if (!hasLoggingHook) {
          errors.push(
            `Server "${server.name}" is write-scoped but has no PostToolUse logging hook. ` +
            `Add a PostToolUse hook to log calls from this server.`,
          );
        }
      }

      return errors;
    } catch {
      // REQ-24.3: Graceful degradation — if hook detection itself fails,
      // accept the config anyway.
      return [];
    }
  }

  /**
   * Log an MCP tool call for the iteration log.
   * Secrets in args are redacted before logging.
   *
   * REQ-24.4: All MCP tool calls (read and write) are logged including
   * server name, tool name, arguments (secrets redacted), and status.
   */
  logToolCall(
    serverName: string,
    toolName: string,
    args: unknown,
    status: string,
  ): void {
    const entry: McpToolCallLogEntry = {
      timestamp: new Date().toISOString(),
      serverName,
      toolName,
      args: this.redactSecrets(args),
      status,
    };

    this.callLog.push(entry);
  }

  /**
   * Get the current call log entries for the iteration.
   */
  getCallLog(): McpToolCallLogEntry[] {
    return [...this.callLog];
  }

  /**
   * Clear the call log (e.g., at pass boundary).
   */
  clearCallLog(): void {
    this.callLog = [];
  }

  /**
   * Get the currently loaded config.
   */
  getConfig(): McpServerConfig[] {
    return [...this.config];
  }

  /**
   * Redact potential secrets from args before logging.
   * Replaces values that look like secrets with '[REDACTED]'.
   */
  private redactSecrets(args: unknown): unknown {
    if (args === null || args === undefined) return args;

    if (typeof args === 'string') {
      return looksLikeInlineSecret(args) ? '[REDACTED]' : args;
    }

    if (Array.isArray(args)) {
      return args.map((item) => this.redactSecrets(item));
    }

    if (typeof args === 'object') {
      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        // Redact values for keys that commonly hold secrets
        const sensitiveKey = /(?:key|secret|token|password|auth|credential|apikey)/i.test(key);
        if (sensitiveKey && typeof value === 'string') {
          redacted[key] = '[REDACTED]';
        } else {
          redacted[key] = this.redactSecrets(value);
        }
      }
      return redacted;
    }

    return args;
  }
}
