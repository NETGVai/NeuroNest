// ─── Sandbox_Manager ────────────────────────────────────────────
// Provisions isolated execution environments (local or Docker) for
// task execution. All code passes through Firewall_Engine before
// execution. Session metadata persisted to sandbox_sessions table.
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.8

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { SandboxBackend, SandboxSession, SandboxResult } from './types/sandbox-types.js';

// ─── Dependency Interfaces (for DI / testing) ───────────────────

export interface FirewallEngineLike {
  evaluate(input: string): { passed: boolean; blocked: boolean; sanitized: string };
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const SANDBOX_BASE_DIR = join(tmpdir(), 'neuronest-sandbox');

// ─── SandboxManager ─────────────────────────────────────────────

export class SandboxManager {
  private preferredBackend: SandboxBackend = 'local';
  private sessions: Map<string, SandboxSession> = new Map();
  private executedSessions: Set<string> = new Set();
  private db: Database.Database | null;
  private firewallEngine: FirewallEngineLike;
  private baseDir: string;

  constructor(db: Database.Database | null, firewallEngine: FirewallEngineLike, baseDir?: string) {
    this.db = db;
    this.firewallEngine = firewallEngine;
    this.baseDir = baseDir ?? SANDBOX_BASE_DIR;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Provision a new sandbox session with isolated directories.
   * Each session gets unique uploads/, workspace/, outputs/ subdirectories.
   * Falls back to local if docker is requested but unavailable.
   * Requirement 9.1, 9.2, 9.6
   */
  async create(backend?: SandboxBackend): Promise<SandboxSession> {
    let resolvedBackend = backend ?? this.preferredBackend;

    // Fallback to local if Docker requested but unavailable — Req 9.6
    if (resolvedBackend === 'docker') {
      const dockerAvailable = await this.isDockerAvailable();
      if (!dockerAvailable) {
        console.warn('[SandboxManager] Docker unavailable, falling back to local execution');
        resolvedBackend = 'local';
      }
    }

    const sessionId = randomUUID();
    const sessionDir = join(this.baseDir, sessionId);
    const uploadsDir = join(sessionDir, 'uploads');
    const workspaceDir = join(sessionDir, 'workspace');
    const outputsDir = join(sessionDir, 'outputs');

    // Create isolated directories
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });

    const session: SandboxSession = {
      id: sessionId,
      backend: resolvedBackend,
      uploadsDir,
      workspaceDir,
      outputsDir,
      status: 'running',
      createdAt: new Date(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };

    this.sessions.set(sessionId, session);

    // Persist to database if available
    this.persistSession(session);

    return session;
  }

  /**
   * Execute code in a sandbox session.
   * All code passes through Firewall_Engine before execution — Req 9.8.
   * Supports local and docker backends — Req 9.2, 9.3.
   * Enforces configurable timeout — Req 9.4.
   */
  async execute(sessionId: string, code: string, language: string): Promise<SandboxResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sandbox session not found: ${sessionId}`);
    }

    // Firewall gate — Req 9.8
    const firewallResult = this.firewallEngine.evaluate(code);
    if (firewallResult.blocked) {
      return {
        sessionId,
        exitCode: 1,
        stdout: '',
        stderr: 'Code blocked by firewall',
        outputFiles: [],
      };
    }

    const sanitizedCode = firewallResult.sanitized;

    try {
      let result: { exitCode: number; stdout: string; stderr: string };

      if (session.backend === 'docker') {
        result = this.executeDocker(session, sanitizedCode, language);
      } else {
        result = this.executeLocal(session, sanitizedCode, language);
      }

      this.executedSessions.add(sessionId);

      // Collect output files
      const outputFiles = this.collectOutputFiles(session.outputsDir);

      // Update session status
      session.status = 'completed';
      this.updateSessionStatus(sessionId, 'completed', result.exitCode);

      return {
        sessionId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        outputFiles,
      };
    } catch (err: any) {
      const isTimeout = err?.message?.includes('ETIMEDOUT') || err?.status === null;
      session.status = isTimeout ? 'timed_out' : 'error';
      this.updateSessionStatus(sessionId, session.status);

      return {
        sessionId,
        exitCode: 1,
        stdout: '',
        stderr: err?.message ?? 'Execution failed',
        outputFiles: [],
      };
    }
  }

  /**
   * Collect output files and destroy the sandbox.
   * Returns all file paths from the session's outputsDir — Req 9.5.
   */
  async destroy(sessionId: string): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sandbox session not found: ${sessionId}`);
    }

    // Collect output files before cleanup
    const outputFiles = this.collectOutputFiles(session.outputsDir);

    // Clean up session directory
    const sessionDir = join(this.baseDir, sessionId);
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      console.warn(`[SandboxManager] Failed to clean up session directory: ${sessionDir}`);
    }

    // Update status and remove from active sessions
    session.status = 'completed';
    this.updateSessionStatus(sessionId, 'completed');
    this.sessions.delete(sessionId);
    this.executedSessions.delete(sessionId);

    return outputFiles;
  }

  /**
   * Set preferred execution backend.
   * Falls back to local if docker unavailable at execution time — Req 9.6.
   */
  setBackend(backend: SandboxBackend): void {
    this.preferredBackend = backend;
  }

  /**
   * Check if Docker is available on the host.
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Execute code locally with OS-level directory isolation — Req 9.2.
   */
  private executeLocal(
    session: SandboxSession,
    code: string,
    language: string,
  ): { exitCode: number; stdout: string; stderr: string } {
    const ext = this.getFileExtension(language);
    const scriptPath = join(session.workspaceDir, `script${ext}`);
    writeFileSync(scriptPath, code, 'utf-8');

    const cmd = this.getExecutionCommand(language, scriptPath);

    try {
      const stdout = execSync(cmd, {
        cwd: session.workspaceDir,
        timeout: session.timeoutMs,
        encoding: 'utf-8',
        env: { ...process.env, SANDBOX_OUTPUT_DIR: session.outputsDir },
      });
      return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
      };
    }
  }

  /**
   * Execute code in a Docker container — Req 9.2, 9.3.
   * Read-only workspace, write-only outputs.
   */
  private executeDocker(
    session: SandboxSession,
    code: string,
    language: string,
  ): { exitCode: number; stdout: string; stderr: string } {
    const ext = this.getFileExtension(language);
    const scriptPath = join(session.workspaceDir, `script${ext}`);
    writeFileSync(scriptPath, code, 'utf-8');

    const image = this.getDockerImage(language);
    const containerCmd = this.getContainerCommand(language, `/workspace/script${ext}`);

    // Docker: read-only workspace, write-only outputs — Req 9.3
    const cmd = [
      'docker', 'run', '--rm',
      '-v', `${session.workspaceDir}:/workspace:ro`,
      '-v', `${session.outputsDir}:/outputs`,
      '--network', 'none',
      '--memory', '256m',
      '--cpus', '1',
      image,
      ...containerCmd,
    ].join(' ');

    try {
      const stdout = execSync(cmd, {
        timeout: session.timeoutMs,
        encoding: 'utf-8',
      });
      return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
      };
    }
  }

  /**
   * Collect all file paths from a directory (non-recursive).
   */
  private collectOutputFiles(dir: string): string[] {
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((f) => join(dir, f));
    } catch {
      return [];
    }
  }

  /**
   * Persist session metadata to sandbox_sessions table.
   */
  private persistSession(session: SandboxSession): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO sandbox_sessions (id, backend, uploads_dir, workspace_dir, outputs_dir, status, timeout_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.backend,
        session.uploadsDir,
        session.workspaceDir,
        session.outputsDir,
        session.status,
        session.timeoutMs,
        session.createdAt.toISOString(),
      );
    } catch (err: any) {
      console.warn(`[SandboxManager] Failed to persist session: ${err?.message}`);
    }
  }

  /**
   * Update session status in the database.
   */
  private updateSessionStatus(sessionId: string, status: string, exitCode?: number): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE sandbox_sessions SET status = ?, exit_code = ?, completed_at = ? WHERE id = ?
      `).run(status, exitCode ?? null, new Date().toISOString(), sessionId);
    } catch (err: any) {
      console.warn(`[SandboxManager] Failed to update session status: ${err?.message}`);
    }
  }

  private getFileExtension(language: string): string {
    const map: Record<string, string> = {
      javascript: '.js', typescript: '.ts', python: '.py',
      bash: '.sh', shell: '.sh', ruby: '.rb', go: '.go',
    };
    return map[language.toLowerCase()] ?? '.txt';
  }

  private getExecutionCommand(language: string, scriptPath: string): string {
    const map: Record<string, string> = {
      javascript: `node "${scriptPath}"`,
      typescript: `npx tsx "${scriptPath}"`,
      python: `python3 "${scriptPath}"`,
      bash: `bash "${scriptPath}"`,
      shell: `sh "${scriptPath}"`,
      ruby: `ruby "${scriptPath}"`,
    };
    return map[language.toLowerCase()] ?? `cat "${scriptPath}"`;
  }

  private getDockerImage(language: string): string {
    const map: Record<string, string> = {
      javascript: 'node:20-alpine',
      typescript: 'node:20-alpine',
      python: 'python:3.12-alpine',
      bash: 'alpine:latest',
      shell: 'alpine:latest',
      ruby: 'ruby:3.3-alpine',
    };
    return map[language.toLowerCase()] ?? 'alpine:latest';
  }

  private getContainerCommand(language: string, scriptPath: string): string[] {
    const map: Record<string, string[]> = {
      javascript: ['node', scriptPath],
      typescript: ['npx', 'tsx', scriptPath],
      python: ['python3', scriptPath],
      bash: ['bash', scriptPath],
      shell: ['sh', scriptPath],
      ruby: ['ruby', scriptPath],
    };
    return map[language.toLowerCase()] ?? ['cat', scriptPath];
  }
}

export default SandboxManager;
