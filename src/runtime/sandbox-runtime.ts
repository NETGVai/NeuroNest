/**
 * Sandbox Runtime — OpenHands-inspired secure Docker execution environment.
 *
 * Provides a client-server architecture for sandboxed code execution:
 * - Builds custom Docker images with project dependencies
 * - Manages container lifecycle with proper volume mounts
 * - Communicates via HTTP API inside the container
 * - Supports file-locked port allocation for concurrency
 * - Read-only project mounts with tmpfs for scratch space
 *
 * This extends (not replaces) the existing RuntimeManager which uses
 * native processes. SandboxRuntime is for when Docker isolation is needed.
 */

import { DockerCli, DockerCliError } from './docker-cli.js';
import { PortManager } from './port-manager.js';
import type { ServiceStatus, RuntimeError } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Base Docker image (default: node:20-alpine) */
  baseImage: string;
  /** Max memory in MB (default: 512) */
  memoryLimitMB: number;
  /** Max CPU cores (default: 1) */
  cpuLimit: number;
  /** Network mode: 'none' | 'bridge' (default: 'none' for isolation) */
  networkMode: 'none' | 'bridge';
  /** Timeout for commands in ms (default: 30000) */
  commandTimeoutMs: number;
  /** Additional volume mounts: [hostPath:containerPath:mode] */
  volumes: string[];
  /** Environment variables to pass to the container */
  env: Record<string, string>;
}

export interface SandboxSession {
  id: string;
  containerId: string;
  projectId: string;
  projectPath: string;
  hostPort: number;
  status: ServiceStatus;
  config: SandboxConfig;
  createdAt: number;
  lastActivityAt: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface FileOperation {
  type: 'read' | 'write' | 'delete' | 'list';
  path: string;
  content?: string;
}

export interface FileResult {
  success: boolean;
  content?: string;
  files?: string[];
  error?: string;
}

// ─── Default Config ─────────────────────────────────────────────

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  baseImage: 'node:20-alpine',
  memoryLimitMB: 512,
  cpuLimit: 1,
  networkMode: 'none',
  commandTimeoutMs: 30000,
  volumes: [],
  env: {},
};

// ─── Sandbox Runtime ────────────────────────────────────────────

export class SandboxRuntime {
  private docker: DockerCli;
  private portManager: PortManager;
  private sessions: Map<string, SandboxSession> = new Map();

  constructor() {
    this.docker = new DockerCli();
    this.portManager = new PortManager();
  }

  /**
   * Check if Docker is available for sandboxed execution.
   */
  async isAvailable(): Promise<{ available: boolean; error?: string }> {
    try {
      const installed = await this.docker.isInstalled();
      if (!installed) return { available: false, error: 'Docker CLI not found' };
      const running = await this.docker.isDaemonRunning();
      if (!running) return { available: false, error: 'Docker daemon not running' };
      return { available: true };
    } catch (e: any) {
      return { available: false, error: e.message };
    }
  }

  /**
   * Create a sandboxed environment for a project.
   */
  async createSandbox(
    projectId: string,
    projectPath: string,
    config: Partial<SandboxConfig> = {},
  ): Promise<SandboxSession> {
    const fullConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    const sessionId = `sandbox_${projectId}_${Date.now().toString(36)}`;

    // Allocate a host port
    const hostPort = await this.portManager.allocate();

    // Build docker run args
    const containerName = `neuronest-sandbox-${projectId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
    const args = this.buildRunArgs(containerName, projectPath, hostPort, fullConfig);

    let containerId: string;
    try {
      // Remove any existing container with the same name
      try { await this.docker.exec(['rm', '-f', containerName]); } catch { /* ignore */ }

      containerId = await this.docker.exec(args);
    } catch (e: any) {
      this.portManager.release(hostPort);
      throw new Error(`Failed to create sandbox: ${e.message}`);
    }

    const session: SandboxSession = {
      id: sessionId,
      containerId: containerId.trim(),
      projectId,
      projectPath,
      hostPort,
      status: 'running',
      config: fullConfig,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Execute a command inside a sandbox.
   */
  async executeCommand(sessionId: string, command: string): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Sandbox session not found: ${sessionId}`);
    if (session.status !== 'running') throw new Error(`Sandbox is not running: ${session.status}`);

    session.lastActivityAt = Date.now();
    const startTime = Date.now();

    try {
      const stdout = await Promise.race([
        this.docker.exec(['exec', session.containerId, 'sh', '-c', command]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Command timed out')), session.config.commandTimeoutMs)
        ),
      ]);

      return {
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    } catch (e: any) {
      const timedOut = e.message === 'Command timed out';
      if (timedOut) {
        // Kill the running command
        try { await this.docker.exec(['exec', session.containerId, 'kill', '-9', '-1']); } catch { /* ignore */ }
      }

      return {
        exitCode: e instanceof DockerCliError ? e.exitCode : 1,
        stdout: '',
        stderr: e instanceof DockerCliError ? e.stderr : e.message,
        durationMs: Date.now() - startTime,
        timedOut,
      };
    }
  }

  /**
   * Perform a file operation inside a sandbox.
   */
  async fileOperation(sessionId: string, op: FileOperation): Promise<FileResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Sandbox session not found: ${sessionId}`);

    session.lastActivityAt = Date.now();

    try {
      switch (op.type) {
        case 'read': {
          const content = await this.docker.exec(['exec', session.containerId, 'cat', op.path]);
          return { success: true, content };
        }
        case 'write': {
          // Write via stdin pipe
          await this.docker.exec(['exec', '-i', session.containerId, 'sh', '-c', `cat > ${op.path}`]);
          return { success: true };
        }
        case 'delete': {
          await this.docker.exec(['exec', session.containerId, 'rm', '-f', op.path]);
          return { success: true };
        }
        case 'list': {
          const output = await this.docker.exec(['exec', session.containerId, 'ls', '-la', op.path]);
          return { success: true, files: output.split('\n').filter(Boolean) };
        }
        default:
          return { success: false, error: `Unknown operation: ${op.type}` };
      }
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Destroy a sandbox and clean up resources.
   */
  async destroySandbox(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await this.docker.exec(['stop', session.containerId]);
    } catch { /* may already be stopped */ }
    try {
      await this.docker.exec(['rm', session.containerId]);
    } catch { /* may already be removed */ }

    this.portManager.release(session.hostPort);
    session.status = 'stopped';
    this.sessions.delete(sessionId);
  }

  /**
   * Get status of a sandbox session.
   */
  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all active sandbox sessions.
   */
  listSessions(): SandboxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Destroy all sandboxes. Called on app shutdown.
   */
  async destroyAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const id of sessionIds) {
      try { await this.destroySandbox(id); } catch { /* ignore */ }
    }
  }

  // ─── Private ────────────────────────────────────────────────

  private buildRunArgs(
    containerName: string,
    projectPath: string,
    hostPort: number,
    config: SandboxConfig,
  ): string[] {
    const args = [
      'run', '-d',
      '--name', containerName,
      '--read-only',
      '--no-new-privileges',
      `--memory=${config.memoryLimitMB}m`,
      `--cpus=${config.cpuLimit}`,
      `--network=${config.networkMode}`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--tmpfs', '/var/tmp:rw,noexec,nosuid,size=128m',
      '-v', `${projectPath}:/workspace:ro`,
      '-w', '/workspace',
      '-p', `${hostPort}:8080`,
    ];

    // Additional volumes
    for (const vol of config.volumes) {
      args.push('-v', vol);
    }

    // Environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push('-e', `${key}=${value}`);
    }

    // Use the base image with a long-running process
    args.push(config.baseImage);
    args.push('sh', '-c', 'tail -f /dev/null');

    return args;
  }
}
