/**
 * DevOps Engine — Argv-Only Command Execution
 *
 * Provides a safe command execution model that:
 * 1. Rejects shell metacharacters from argv elements
 * 2. Blocks interpreter invocations (bash, sh, zsh, cmd, powershell, python -c, node -e)
 * 3. Resolves {{secret:NAME}} patterns into environment variables
 * 4. Scrubs sensitive token patterns from command output
 * 5. Executes commands with child_process.spawn (shell: false)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { spawn } from 'node:child_process';
import type { CommandRequest, CommandResult } from './types';
import { buildSanitizedEnv } from '../pipeline/tool-executor';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Regex that matches any shell metacharacter within an argv element.
 * Covers: |, ;, &&, ||, `, $(, >, <, &
 */
const SHELL_META_REGEX = /(\|{1,2}|;|&&|`|\$\(|>|<|&)/;

/**
 * Blocked interpreter base names (case-insensitive matching on the first argv element
 * or any argv element that is a path ending in these names).
 */
const BLOCKED_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

/**
 * Interpreter + flag combinations that must be blocked.
 * e.g., ['python', '-c'] or ['node', '-e']
 */
const BLOCKED_INTERPRETER_FLAGS: Array<{ command: string; flag: string }> = [
  { command: 'python', flag: '-c' },
  { command: 'python3', flag: '-c' },
  { command: 'node', flag: '-e' },
];

/** Regex to detect {{secret:NAME}} patterns in argv elements. */
const SECRET_PATTERN = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Token patterns to scrub from command output.
 * Each entry is a regex that matches known sensitive token formats.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // OpenAI-style API keys
  { pattern: /sk-[A-Za-z0-9]{20,}/g, label: '[REDACTED:API_KEY]' },
  // Slack tokens
  { pattern: /xoxb-[A-Za-z0-9\-]{20,}/g, label: '[REDACTED:SLACK_TOKEN]' },
  // GitHub personal access tokens
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, label: '[REDACTED:GITHUB_TOKEN]' },
  // GitHub fine-grained tokens
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, label: '[REDACTED:GITHUB_TOKEN]' },
  // AWS Access Key IDs
  { pattern: /AKIA[A-Z0-9]{16,}/g, label: '[REDACTED:AWS_KEY]' },
  // JWTs (three base64url segments separated by dots, starting with eyJ)
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: '[REDACTED:JWT]' },
  // Bearer tokens in output
  { pattern: /Bearer\s+[A-Za-z0-9._\-]{20,}/gi, label: 'Bearer [REDACTED:TOKEN]' },
  // High-entropy base64 strings (>20 chars, mostly base64 alphabet)
  { pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{21,}={0,2}(?![A-Za-z0-9+/=])/g, label: '[REDACTED:SECRET]' },
];

// ─────────────────────────────────────────────
// DevOps Engine Interface
// ─────────────────────────────────────────────

export interface DevOpsEngine {
  execute(request: CommandRequest, agentId: string): Promise<CommandResult>;
  validateArgv(argv: string[]): { valid: boolean; violations: string[] };
  resolveSecrets(argv: string[]): { cleanArgv: string[]; envVars: Record<string, string> };
  scrubOutput(output: string): string;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

/**
 * Validates that argv elements do not contain shell metacharacters.
 * Returns a list of violations if any are found.
 */
export function validateArgv(argv: string[]): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (!argv || argv.length === 0) {
    violations.push('argv must be a non-empty array');
    return { valid: false, violations };
  }

  for (let i = 0; i < argv.length; i++) {
    const element = argv[i]!;

    // Check for shell metacharacters
    if (SHELL_META_REGEX.test(element)) {
      const matched = element.match(SHELL_META_REGEX);
      violations.push(
        `argv[${i}] contains shell metacharacter "${matched?.[0]}" in: "${element}"`,
      );
    }
  }

  // Check for blocked interpreters as the command (first element)
  const command = extractCommandName(argv[0] ?? '');
  if (BLOCKED_INTERPRETERS.has(command.toLowerCase())) {
    violations.push(
      `argv[0] invokes blocked interpreter: "${command}"`,
    );
  }

  // Check for interpreter + flag combinations
  for (const { command: interp, flag } of BLOCKED_INTERPRETER_FLAGS) {
    const cmdName = extractCommandName(argv[0] ?? '');
    if (cmdName.toLowerCase() === interp || cmdName.toLowerCase() === `${interp}.exe`) {
      // Check if the flag is present in any subsequent argv element
      if (argv.slice(1).some((arg) => arg === flag)) {
        violations.push(
          `argv invokes blocked interpreter pattern: "${interp} ${flag}"`,
        );
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Extracts the base command name from a path.
 * e.g., "/usr/bin/bash" -> "bash", "C:\\Windows\\cmd.exe" -> "cmd.exe"
 */
function extractCommandName(commandPath: string): string {
  const parts = commandPath.split(/[/\\]/);
  return parts[parts.length - 1] || commandPath;
}

/**
 * Resolves {{secret:NAME}} patterns in argv elements.
 * Returns a cleaned argv (with secret patterns removed) and a map of env vars to set.
 */
export function resolveSecrets(argv: string[]): { cleanArgv: string[]; envVars: Record<string, string> } {
  const envVars: Record<string, string> = {};
  const cleanArgv: string[] = [];

  for (const element of argv) {
    let cleanElement = element;
    let match: RegExpExecArray | null;

    // Reset lastIndex for global regex
    SECRET_PATTERN.lastIndex = 0;

    while ((match = SECRET_PATTERN.exec(element)) !== null) {
      const secretName = match[1] ?? '';
      // Resolve the secret value from process.env (or a placeholder if not found)
      const secretValue = process.env[secretName] ?? '';
      envVars[secretName] = secretValue;
      // Remove the pattern from the element
      cleanElement = cleanElement.replace(match[0], '');
    }

    // Only add to cleanArgv if there's content remaining after secret removal
    const trimmed = cleanElement.trim();
    if (trimmed.length > 0) {
      cleanArgv.push(trimmed);
    }
  }

  return { cleanArgv, envVars };
}

/**
 * Scrubs known token patterns and high-entropy strings from command output.
 */
export function scrubOutput(output: string): string {
  let scrubbed = output;

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, label);
  }

  return scrubbed;
}

/**
 * Executes a command using argv-only semantics (shell: false).
 * Validates the command, resolves secrets, runs the process, and scrubs output.
 *
 * Returns a denied result with reason when validation fails (does not throw).
 */
export async function execute(request: CommandRequest, _agentId: string): Promise<CommandResult> {
  const startTime = Date.now();

  // Step 1: Validate argv for shell metacharacters and blocked interpreters
  const validation = validateArgv(request.argv);
  if (!validation.valid) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: '',
      duration: Date.now() - startTime,
      denied: { reason: validation.violations.join('; ') },
    };
  }

  // Step 2: Resolve secrets from argv elements
  const { cleanArgv, envVars } = resolveSecrets(request.argv);

  if (cleanArgv.length === 0) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: '',
      duration: Date.now() - startTime,
      denied: { reason: 'argv is empty after secret resolution' },
    };
  }

  // Step 3: Build environment using sanitized base (Requirement 30.2)
  // Never spread full process.env — only allowlisted vars + request overrides + resolved secrets
  const sanitizedBase = buildSanitizedEnv(request.cwd ?? process.cwd());
  const env: Record<string, string> = {
    ...sanitizedBase as Record<string, string>,
    ...(request.env ?? {}),
    ...envVars,
  };

  // Step 4: Execute using child_process.spawn with shell: false
  const command = cleanArgv[0] ?? '';
  const args = cleanArgv.slice(1);
  const timeout = request.timeout ?? 30_000;

  try {
    const spawnOpts: { cwd?: string; env: Record<string, string>; timeout: number } = {
      env,
      timeout,
    };
    if (request.cwd !== undefined) {
      spawnOpts.cwd = request.cwd;
    }
    const result = await spawnCommand(command, args, spawnOpts);

    // Step 5: Scrub sensitive patterns from output
    return {
      exitCode: result.exitCode,
      stdout: scrubOutput(result.stdout),
      stderr: scrubOutput(result.stderr),
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: scrubOutput(error instanceof Error ? error.message : String(error)),
      duration: Date.now() - startTime,
      denied: { reason: 'Execution failed: ' + (error instanceof Error ? error.message : String(error)) },
    };
  }
}

/**
 * Spawns a child process with shell: false and collects stdout/stderr.
 */
function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ exitCode: -1, stdout, stderr: stderr + '\nProcess killed: timeout exceeded' });
      } else {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      }
    });
  });
}

// ─────────────────────────────────────────────
// Default Export
// ─────────────────────────────────────────────

/**
 * Creates a DevOpsEngine instance with all methods bound.
 */
export function createDevOpsEngine(): DevOpsEngine {
  return {
    execute,
    validateArgv,
    resolveSecrets,
    scrubOutput,
  };
}

export default createDevOpsEngine;
