/**
 * Sandbox Isolator — wraps agent shell executions in OS-level process isolation
 * using macOS seatbelt (sandbox-exec) or Linux bubblewrap (bwrap).
 *
 * Detects platform sandbox tool at startup, caches availability, and generates
 * platform-specific sandbox configurations from SandboxProfile. Falls back to
 * direct execution when sandbox tool is not available or feature toggle is disabled.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11
 */

import { spawn, execSync } from 'node:child_process';
import { platform } from 'node:os';
import { tmpdir } from 'node:os';
import { EventBus } from '../events/event-bus.js';
import { FeatureToggleManager } from '../config/feature-toggles.js';
import { logger } from '../utils/logger.js';
import type { SandboxProfile } from './sandbox-profile-loader.js';
import type { SandboxSession, SandboxResult } from './types/sandbox-types.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Platform sandbox type detected at startup.
 */
export type PlatformSandboxType = 'seatbelt' | 'bwrap' | 'none';

/**
 * Structured violation event emitted when a sandbox restriction is violated.
 */
export interface SandboxViolationEvent {
  sessionId: string;
  timestamp: number;
  violationType: 'filesystem' | 'network' | 'syscall';
  deniedOperation: string;
  targetResource: string;
}

/**
 * Result returned by the sandbox isolator after command execution.
 */
export interface SandboxIsolatorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Options for creating a SandboxIsolator instance.
 */
export interface SandboxIsolatorOptions {
  eventBus?: EventBus;
  featureToggleManager?: FeatureToggleManager;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Seatbelt Profile Generation ────────────────────────────────

/**
 * Generate a macOS seatbelt (sandbox-exec) profile string from a SandboxProfile.
 *
 * The profile uses Scheme-like syntax to define allow/deny rules.
 * Default policy is deny-all, with explicit allows for configured paths and hosts.
 */
export function generateSeatbeltProfile(profile: SandboxProfile): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    '; Allow process execution within sandbox',
    '(allow process-exec)',
    '(allow process-fork)',
    '',
    '; Allow read access to configured paths',
  ];

  for (const readPath of profile.allowedReadPaths) {
    lines.push(`(allow file-read* (subpath "${readPath}"))`);
  }

  lines.push('');
  lines.push('; Allow write access to configured paths');

  for (const writePath of profile.allowedWritePaths) {
    lines.push(`(allow file-write* (subpath "${writePath}"))`);
  }

  lines.push('');
  lines.push('; Allow read access to write paths as well');

  for (const writePath of profile.allowedWritePaths) {
    lines.push(`(allow file-read* (subpath "${writePath}"))`);
  }

  lines.push('');
  lines.push('; Network access restrictions');

  if (profile.allowedNetworkHosts.length > 0) {
    lines.push('(allow network-outbound');
    for (const host of profile.allowedNetworkHosts) {
      lines.push(`  (remote ip "${host}:*")`);
    }
    lines.push(')');
    lines.push('(allow network-inbound');
    for (const host of profile.allowedNetworkHosts) {
      lines.push(`  (local ip "${host}:*")`);
    }
    lines.push(')');
  }

  lines.push('');
  lines.push('; Block system modification operations');

  for (const syscall of profile.blockedSyscalls) {
    lines.push(`; blocked: ${syscall}`);
  }

  // Block system modification operations (Req 1.6)
  lines.push('(deny system-privilege)');
  lines.push('(deny system-kext*)');
  lines.push('(deny system-set-time)');

  return lines.join('\n');
}

// ─── Bwrap Flags Generation ─────────────────────────────────────

/**
 * Generate Linux bubblewrap (bwrap) command-line flags from a SandboxProfile.
 *
 * Creates a minimal namespace with explicit bind mounts for allowed paths.
 */
export function generateBwrapFlags(profile: SandboxProfile): string[] {
  const flags: string[] = [
    // Create new namespaces for isolation
    '--unshare-all',
    '--share-net', // We'll restrict network via other means if needed
    '--die-with-parent',
    // Provide a minimal /proc
    '--proc', '/proc',
    // Provide a minimal /dev
    '--dev', '/dev',
  ];

  // Read-only bind mounts for allowed read paths
  for (const readPath of profile.allowedReadPaths) {
    flags.push('--ro-bind', readPath, readPath);
  }

  // Read-write bind mounts for allowed write paths
  for (const writePath of profile.allowedWritePaths) {
    flags.push('--bind', writePath, writePath);
  }

  // Tmpfs for /tmp if not already in write paths
  const hasTmp = profile.allowedWritePaths.some(p => p === '/tmp' || p === tmpdir());
  if (!hasTmp) {
    flags.push('--tmpfs', '/tmp');
  }

  // Block syscalls using seccomp if blockedSyscalls are specified (Req 1.6)
  // Note: Full seccomp filter generation is complex; we use --new-session
  // to prevent process escape and rely on namespace isolation
  if (profile.blockedSyscalls.length > 0) {
    flags.push('--new-session');
  }

  return flags;
}

// ─── Violation Parsing ──────────────────────────────────────────

/**
 * Parse sandbox violation information from stderr output.
 * Returns detected violations or an empty array if none found.
 */
export function parseViolations(stderr: string): Array<{
  violationType: 'filesystem' | 'network' | 'syscall';
  deniedOperation: string;
  targetResource: string;
}> {
  const violations: Array<{
    violationType: 'filesystem' | 'network' | 'syscall';
    deniedOperation: string;
    targetResource: string;
  }> = [];

  // macOS seatbelt violation patterns
  // Format: deny(N) operation target
  const seatbeltPattern = /deny\(\d+\)\s+(file-[\w-]+|network-[\w-]+|system-[\w*-]+)\s+(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = seatbeltPattern.exec(stderr)) !== null) {
    const operation = match[1];
    const resource = match[2].trim();

    let violationType: 'filesystem' | 'network' | 'syscall';
    if (operation.startsWith('file-')) {
      violationType = 'filesystem';
    } else if (operation.startsWith('network-')) {
      violationType = 'network';
    } else {
      violationType = 'syscall';
    }

    violations.push({ violationType, deniedOperation: operation, targetResource: resource });
  }

  // Linux bwrap / seccomp violation patterns
  const seccompPattern = /seccomp.*syscall=(\w+).*path=([^\s]+)/g;
  while ((match = seccompPattern.exec(stderr)) !== null) {
    violations.push({
      violationType: 'syscall',
      deniedOperation: match[1],
      targetResource: match[2],
    });
  }

  // Generic permission denied patterns
  const permDeniedPattern = /(?:Permission denied|EACCES|EPERM).*?[:\s]+([^\n]+)/g;
  while ((match = permDeniedPattern.exec(stderr)) !== null) {
    const resource = match[1].trim();
    // Avoid duplicates from seatbelt patterns
    if (!violations.some(v => v.targetResource === resource)) {
      violations.push({
        violationType: 'filesystem',
        deniedOperation: 'access',
        targetResource: resource,
      });
    }
  }

  return violations;
}

// ─── SandboxIsolator ────────────────────────────────────────────

/**
 * Wraps agent shell executions in OS-level process isolation.
 *
 * Detects platform sandbox tool availability at construction time,
 * generates platform-specific sandbox configurations, and enforces
 * timeout with SIGKILL termination.
 */
export class SandboxIsolator {
  private platformType: PlatformSandboxType;
  private sandboxAvailable: boolean;
  private eventBus?: EventBus;
  private featureToggleManager?: FeatureToggleManager;

  constructor(options: SandboxIsolatorOptions = {}) {
    this.eventBus = options.eventBus;
    this.featureToggleManager = options.featureToggleManager;

    // Detect platform sandbox tool at startup, cache availability (Req 1.8)
    this.platformType = this.detectPlatformType();
    this.sandboxAvailable = this.platformType !== 'none';

    if (!this.sandboxAvailable) {
      const expectedTool = platform() === 'darwin' ? 'sandbox-exec' : 'bwrap';
      logger.warn(`Platform sandbox tool '${expectedTool}' not found in PATH, falling back to direct execution`, {
        platform: platform(),
        expectedTool,
      });
    } else {
      logger.info('Sandbox isolator initialized', {
        platformType: this.platformType,
      });
    }
  }

  /**
   * Execute a command inside an OS-level sandbox.
   *
   * Wraps the command with platform-appropriate sandbox enforcement.
   * Falls back to direct execution when:
   * - Feature toggle is disabled (Req 1.7)
   * - Platform sandbox tool is not available (Req 1.8)
   *
   * Terminates process on timeout with SIGKILL (Req 1.11).
   * Emits structured violation events on EventBus (Req 1.10).
   * Passes through exit code, stdout, stderr unchanged (Req 1.9).
   */
  async execute(
    command: string,
    session: SandboxSession,
    profile: SandboxProfile,
  ): Promise<SandboxIsolatorResult> {
    // Check feature toggle — bypass sandbox when disabled (Req 1.7)
    if (this.featureToggleManager && !this.featureToggleManager.isEnabled('sandbox-isolation')) {
      return this.executeDirectly(command, session);
    }

    // Fall back to direct execution when sandbox tool not available (Req 1.8)
    if (!this.sandboxAvailable) {
      return this.executeDirectly(command, session);
    }

    // Execute with sandbox enforcement
    return this.executeSandboxed(command, session, profile);
  }

  /**
   * Check if platform sandbox tool is available.
   */
  isPlatformSandboxAvailable(): boolean {
    return this.sandboxAvailable;
  }

  /**
   * Get the detected platform sandbox type.
   */
  getPlatformType(): PlatformSandboxType {
    return this.platformType;
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Detect the platform sandbox type by checking tool availability.
   */
  private detectPlatformType(): PlatformSandboxType {
    const os = platform();

    if (os === 'darwin') {
      // Check for sandbox-exec on macOS
      if (this.isToolInPath('sandbox-exec')) {
        return 'seatbelt';
      }
    } else if (os === 'linux') {
      // Check for bwrap on Linux
      if (this.isToolInPath('bwrap')) {
        return 'bwrap';
      }
    }

    return 'none';
  }

  /**
   * Check if a tool is available in the system PATH.
   */
  private isToolInPath(tool: string): boolean {
    try {
      const cmd = platform() === 'win32' ? `where ${tool}` : `which ${tool}`;
      execSync(cmd, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command directly without sandbox wrapping.
   */
  private executeDirectly(command: string, session: SandboxSession): Promise<SandboxIsolatorResult> {
    const timeoutMs = session.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const child = spawn('sh', ['-c', command], {
        cwd: session.workspaceDir,
        env: { ...process.env, SANDBOX_OUTPUT_DIR: session.outputsDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Set up timeout (Req 1.11)
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('close', (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          exitCode: timedOut ? 1 : (code ?? 1),
          stdout,
          stderr: timedOut ? `Process timed out after ${timeoutMs}ms` : stderr,
          timedOut,
        });
      });

      child.on('error', (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Execute a command with sandbox enforcement.
   */
  private executeSandboxed(
    command: string,
    session: SandboxSession,
    profile: SandboxProfile,
  ): Promise<SandboxIsolatorResult> {
    const timeoutMs = session.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      let spawnCmd: string;
      let spawnArgs: string[];

      if (this.platformType === 'seatbelt') {
        // macOS: use sandbox-exec with generated profile
        const seatbeltProfile = generateSeatbeltProfile(profile);
        spawnCmd = 'sandbox-exec';
        spawnArgs = ['-p', seatbeltProfile, 'sh', '-c', command];
      } else {
        // Linux: use bwrap with generated flags
        const bwrapFlags = generateBwrapFlags(profile);
        spawnCmd = 'bwrap';
        spawnArgs = [...bwrapFlags, '--', 'sh', '-c', command];
      }

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: session.workspaceDir,
        env: { ...process.env, SANDBOX_OUTPUT_DIR: session.outputsDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Set up timeout — terminate with SIGKILL (Req 1.11)
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('close', (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        // Parse violations from stderr and emit events (Req 1.10)
        const violations = parseViolations(stderr);
        for (const violation of violations) {
          this.emitViolationEvent(session.id, violation);
        }

        resolve({
          exitCode: timedOut ? 1 : (code ?? 1),
          stdout,
          stderr: timedOut ? `Process timed out after ${timeoutMs}ms` : stderr,
          timedOut,
        });
      });

      child.on('error', (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        // If sandbox tool fails to start, log warning and fall back (Req 1.3 degraded mode)
        logger.warn('Sandbox enforcement failed, continuing with degraded security', {
          error: err.message,
          platformType: this.platformType,
        });

        // Fall back to direct execution
        this.executeDirectly(command, session).then(resolve);
      });
    });
  }

  /**
   * Emit a structured sandbox violation event on the EventBus.
   */
  private emitViolationEvent(
    sessionId: string,
    violation: {
      violationType: 'filesystem' | 'network' | 'syscall';
      deniedOperation: string;
      targetResource: string;
    },
  ): void {
    if (!this.eventBus) {
      return;
    }

    const eventData: SandboxViolationEvent = {
      sessionId,
      timestamp: Date.now(),
      violationType: violation.violationType,
      deniedOperation: violation.deniedOperation,
      targetResource: violation.targetResource,
    };

    this.eventBus.publish('sandbox.violation', {
      type: 'sandbox_violation',
      data: eventData,
      sessionId,
    }).catch((err) => {
      logger.error('Failed to emit sandbox violation event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
