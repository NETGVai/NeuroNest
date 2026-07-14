/**
 * Interactive Terminal — PTY-based agent terminal with real-time I/O handling.
 *
 * Allocates a PTY per interactive session using node-pty, providing full terminal
 * emulation (ANSI escape sequences, cursor movement). Exposes agent tools:
 * `terminal_write`, `terminal_read`, `terminal_status`. Enforces idle timeout,
 * credential injection via CredentialVault, and concurrent session limits.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.6, 19.7
 */

import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from '../tools/tool-system.js';
import { safeExecute, type FieldSchema } from '../tools/built-in/input-validator.js';

// ─── Types ──────────────────────────────────────────────────────

/** Session status values for a PTY session */
export type TerminalSessionStatus = 'active' | 'idle' | 'timed_out' | 'closed';

/** Configuration for the InteractiveTerminal */
export interface InteractiveTerminalConfig {
  /** Maximum idle time in milliseconds before returning control to user (default: 60000) */
  idleTimeoutMs: number;
  /** Maximum concurrent PTY sessions per workspace (default: 3) */
  maxConcurrentSessions: number;
  /** Default shell to use (auto-detected if not specified) */
  defaultShell?: string;
  /** Default shell args */
  defaultShellArgs?: string[];
  /** Default columns for the PTY */
  cols?: number;
  /** Default rows for the PTY */
  rows?: number;
}

/** Represents a single interactive PTY session */
export interface TerminalSession {
  /** Unique session identifier */
  id: string;
  /** Workspace ID this session belongs to */
  workspaceId: string;
  /** Current session status */
  status: TerminalSessionStatus;
  /** Output buffer since last read */
  outputBuffer: string;
  /** Timestamp of last agent activity (write or read) */
  lastActivityAt: number;
  /** Timestamp when session was created */
  createdAt: number;
  /** The PTY process (opaque — typed as any for portability with node-pty) */
  pty: PtyProcess | null;
  /** Idle timeout timer handle */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Minimal interface for node-pty IPty to avoid hard dependency at type level */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (exitCode: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  pid: number;
}

/** Factory function to spawn a PTY process */
export type PtySpawnFn = (
  shell: string,
  args: string[],
  options: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
) => PtyProcess;

/** Credential vault interface for password injection */
export interface CredentialProvider {
  /**
   * Retrieve a decrypted credential by name.
   * Returns null if not found or user denies access.
   */
  getCredential(name: string, agentRole: string): Promise<string | null>;
}

/** Callback for requesting user approval before credential injection */
export type ApprovalCallback = (message: string) => Promise<boolean>;

// ─── Password Detection Patterns ────────────────────────────────

/**
 * Patterns that indicate the terminal is requesting a password/secret.
 * When detected, agents are blocked from directly typing and must use
 * credential injection via the CredentialVault.
 */
const PASSWORD_PROMPT_PATTERNS: RegExp[] = [
  /password\s*[:>]/i,
  /passphrase\s*[:>]/i,
  /enter\s+pass/i,
  /secret\s*[:>]/i,
  /token\s*[:>]/i,
  /auth.*[:>]\s*$/i,
  /\[sudo\]\s*password/i,
  /login\s*[:>]/i,
];

// ─── Input Schemas for Agent Tools ──────────────────────────────

const terminalWriteSchema: FieldSchema[] = [
  { name: 'sessionId', type: 'string' },
  { name: 'input', type: 'string' },
];

const terminalReadSchema: FieldSchema[] = [
  { name: 'sessionId', type: 'string' },
  { name: 'timeout', type: 'number', required: false },
];

const terminalStatusSchema: FieldSchema[] = [
  { name: 'sessionId', type: 'string' },
];

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_OUTPUT_BUFFER_SIZE = 100_000; // 100KB max output buffer

// ─── InteractiveTerminal Class ──────────────────────────────────

/**
 * Manages PTY-based interactive terminal sessions for agent use.
 * Singleton per workspace — lazily initialized when the `interactive_terminal`
 * feature flag is enabled.
 */
export class InteractiveTerminal {
  private sessions: Map<string, TerminalSession> = new Map();
  private config: InteractiveTerminalConfig;
  private spawnPty: PtySpawnFn;
  private credentialProvider: CredentialProvider | null;
  private approvalCallback: ApprovalCallback | null;
  private sessionCounter = 0;

  constructor(
    config: Partial<InteractiveTerminalConfig>,
    spawnPty: PtySpawnFn,
    credentialProvider?: CredentialProvider | null,
    approvalCallback?: ApprovalCallback | null,
  ) {
    this.config = {
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxConcurrentSessions: config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
      defaultShell: config.defaultShell ?? InteractiveTerminal.detectDefaultShell(),
      defaultShellArgs: config.defaultShellArgs ?? [],
      cols: config.cols ?? DEFAULT_COLS,
      rows: config.rows ?? DEFAULT_ROWS,
    };
    this.spawnPty = spawnPty;
    this.credentialProvider = credentialProvider ?? null;
    this.approvalCallback = approvalCallback ?? null;
  }

  // ─── Session Lifecycle ──────────────────────────────────────────

  /**
   * Create a new interactive terminal session.
   * Allocates a PTY and starts tracking output.
   *
   * @param workspaceId - Workspace this session belongs to
   * @param cwd - Working directory for the terminal
   * @param env - Additional environment variables
   * @returns Session ID or error if limit exceeded
   */
  createSession(
    workspaceId: string,
    cwd?: string,
    env?: Record<string, string>,
  ): { sessionId: string } | { error: string } {
    // Enforce concurrent session limit per workspace
    const activeCount = this.getActiveSessionCount(workspaceId);
    if (activeCount >= this.config.maxConcurrentSessions) {
      return {
        error: `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached for this workspace. Close an existing session first.`,
      };
    }

    const sessionId = this.generateSessionId();
    const now = Date.now();

    // Spawn PTY process
    const pty = this.spawnPty(
      this.config.defaultShell!,
      this.config.defaultShellArgs ?? [],
      {
        cols: this.config.cols!,
        rows: this.config.rows!,
        cwd,
        env: { ...process.env, ...env } as Record<string, string>,
      },
    );

    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      status: 'active',
      outputBuffer: '',
      lastActivityAt: now,
      createdAt: now,
      pty,
      idleTimer: null,
    };

    // Listen to PTY output
    pty.onData((data: string) => {
      this.appendOutput(sessionId, data);
    });

    // Handle PTY exit
    pty.onExit(() => {
      this.handleSessionExit(sessionId);
    });

    this.sessions.set(sessionId, session);
    this.resetIdleTimer(sessionId);

    return { sessionId };
  }

  /**
   * Close a terminal session, killing the PTY process.
   */
  closeSession(sessionId: string): { success: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: `Session not found: ${sessionId}` };
    }

    this.cleanupSession(session);
    this.sessions.delete(sessionId);
    return { success: true };
  }

  /**
   * Close all sessions for a workspace (e.g., on workspace close).
   */
  closeAllSessions(workspaceId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.workspaceId === workspaceId) {
        this.cleanupSession(session);
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Destroy all sessions (e.g., on app shutdown).
   */
  dispose(): void {
    for (const [id, session] of this.sessions) {
      this.cleanupSession(session);
      this.sessions.delete(id);
    }
  }

  // ─── Agent Tool Operations ──────────────────────────────────────

  /**
   * Write input to a terminal session (agent tool: terminal_write).
   * Blocks direct password entry — detects password prompts and requires
   * credential injection from CredentialVault with user approval.
   */
  async terminalWrite(
    sessionId: string,
    input: string,
    agentRole?: string,
  ): Promise<ToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, output: null, error: `Session not found: ${sessionId}` };
    }

    if (session.status === 'closed' || session.status === 'timed_out') {
      return {
        success: false,
        output: null,
        error: `Session is ${session.status}. Create a new session to continue.`,
      };
    }

    if (!session.pty) {
      return { success: false, output: null, error: 'PTY process is not available' };
    }

    // Check if the terminal is at a password prompt
    if (this.isPasswordPrompt(session.outputBuffer)) {
      return {
        success: false,
        output: null,
        error:
          'Password prompt detected. Direct password entry is blocked for security. ' +
          'Use the credential_inject tool to inject credentials from the CredentialVault with user approval.',
      };
    }

    // Check if the input itself looks like a password/secret being typed
    if (this.looksLikeSecret(input)) {
      return {
        success: false,
        output: null,
        error:
          'Input appears to contain a password or secret. Direct credential entry is blocked. ' +
          'Use the credential_inject tool to safely inject credentials from the CredentialVault.',
      };
    }

    // Write to PTY
    session.pty.write(input);
    session.lastActivityAt = Date.now();
    session.status = 'active';
    this.resetIdleTimer(sessionId);

    return {
      success: true,
      output: { sessionId, written: input.length, status: session.status },
    };
  }

  /**
   * Read output from a terminal session since the last read (agent tool: terminal_read).
   * Optionally waits for new output up to a timeout.
   */
  async terminalRead(
    sessionId: string,
    timeout?: number,
  ): Promise<ToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, output: null, error: `Session not found: ${sessionId}` };
    }

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(sessionId);

    // If there's buffered output, return it immediately
    if (session.outputBuffer.length > 0) {
      const output = session.outputBuffer;
      session.outputBuffer = '';
      return {
        success: true,
        output: {
          sessionId,
          content: output,
          status: session.status,
          hasMore: false,
        },
      };
    }

    // If no buffer and a timeout is specified, wait for output
    if (timeout && timeout > 0) {
      const waitMs = Math.min(timeout, 30_000); // Cap at 30s
      const content = await this.waitForOutput(sessionId, waitMs);
      return {
        success: true,
        output: {
          sessionId,
          content,
          status: session.status,
          hasMore: false,
        },
      };
    }

    // No output available and no wait requested
    return {
      success: true,
      output: {
        sessionId,
        content: '',
        status: session.status,
        hasMore: false,
      },
    };
  }

  /**
   * Get the status of a terminal session (agent tool: terminal_status).
   */
  terminalStatus(sessionId: string): ToolResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, output: null, error: `Session not found: ${sessionId}` };
    }

    return {
      success: true,
      output: {
        sessionId,
        status: session.status,
        workspaceId: session.workspaceId,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        pid: session.pty?.pid ?? null,
        hasBufferedOutput: session.outputBuffer.length > 0,
        bufferSize: session.outputBuffer.length,
      },
    };
  }

  /**
   * Inject a credential from the CredentialVault into the terminal.
   * Requires user approval before injection.
   */
  async injectCredential(
    sessionId: string,
    credentialName: string,
    agentRole: string,
  ): Promise<ToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, output: null, error: `Session not found: ${sessionId}` };
    }

    if (!this.credentialProvider) {
      return {
        success: false,
        output: null,
        error: 'CredentialVault is not available. Enable the credential_vault feature flag.',
      };
    }

    // Request user approval
    if (this.approvalCallback) {
      const approved = await this.approvalCallback(
        `Agent "${agentRole}" wants to inject credential "${credentialName}" into terminal session ${sessionId}. Allow?`,
      );
      if (!approved) {
        return {
          success: false,
          output: null,
          error: 'User denied credential injection',
        };
      }
    }

    // Retrieve credential from vault
    const credential = await this.credentialProvider.getCredential(credentialName, agentRole);
    if (credential === null) {
      return {
        success: false,
        output: null,
        error: `Credential "${credentialName}" not found or access denied for role "${agentRole}"`,
      };
    }

    if (!session.pty) {
      return { success: false, output: null, error: 'PTY process is not available' };
    }

    // Write the credential followed by Enter (credential never appears in agent context)
    session.pty.write(credential + '\r');
    session.lastActivityAt = Date.now();
    this.resetIdleTimer(sessionId);

    return {
      success: true,
      output: {
        sessionId,
        credentialInjected: credentialName,
        status: 'injected',
      },
    };
  }

  // ─── Query Methods ──────────────────────────────────────────────

  /** Get the count of active sessions for a workspace */
  getActiveSessionCount(workspaceId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.workspaceId === workspaceId &&
        (session.status === 'active' || session.status === 'idle')
      ) {
        count++;
      }
    }
    return count;
  }

  /** Get all sessions for a workspace */
  getWorkspaceSessions(workspaceId: string): TerminalSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.workspaceId === workspaceId,
    );
  }

  /** Get a session by ID */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get total session count across all workspaces */
  getTotalSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private generateSessionId(): string {
    this.sessionCounter++;
    return `pty-${Date.now()}-${this.sessionCounter}`;
  }

  private appendOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.outputBuffer += data;

    // Truncate buffer if it exceeds the max size
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
      session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
    }
  }

  private resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clear existing timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Set new idle timer
    session.idleTimer = setTimeout(() => {
      this.handleIdleTimeout(sessionId);
    }, this.config.idleTimeoutMs);
  }

  private handleIdleTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'timed_out';
    session.idleTimer = null;
    // PTY stays alive — user can still interact directly.
    // Agent loses control until a new session is created.
  }

  private handleSessionExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'closed';
    session.pty = null;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  private cleanupSession(session: TerminalSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.pty) {
      try {
        session.pty.kill();
      } catch {
        // PTY may already be dead
      }
      session.pty = null;
    }
    session.status = 'closed';
  }

  private waitForOutput(sessionId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const pollInterval = 100; // Check every 100ms

      const poll = () => {
        const session = this.sessions.get(sessionId);
        if (!session) {
          resolve('');
          return;
        }

        if (session.outputBuffer.length > 0) {
          const output = session.outputBuffer;
          session.outputBuffer = '';
          resolve(output);
          return;
        }

        if (session.status === 'closed' || session.status === 'timed_out') {
          resolve('');
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          resolve('');
          return;
        }

        setTimeout(poll, pollInterval);
      };

      poll();
    });
  }

  /**
   * Detect if the current terminal output indicates a password prompt.
   * Checks the last few lines of the output buffer.
   */
  isPasswordPrompt(outputBuffer: string): boolean {
    // Check the last 200 chars of the buffer for password prompts
    const tail = outputBuffer.slice(-200);
    return PASSWORD_PROMPT_PATTERNS.some((pattern) => pattern.test(tail));
  }

  /**
   * Check if input text looks like a raw secret/password being typed.
   * Heuristic: long strings without spaces that contain mixed case/numbers/special chars.
   */
  looksLikeSecret(input: string): boolean {
    const trimmed = input.trim();
    // Skip if it's a normal command (contains spaces, starts with common commands)
    if (trimmed.includes(' ') || trimmed.length < 8) return false;
    if (/^(ls|cd|cat|echo|grep|find|npm|git|python|node|cargo|go)\b/.test(trimmed)) return false;

    // Looks like a token/key: long alphanumeric with mixed chars
    const hasUppercase = /[A-Z]/.test(trimmed);
    const hasLowercase = /[a-z]/.test(trimmed);
    const hasDigits = /\d/.test(trimmed);
    const hasSpecial = /[^a-zA-Z0-9]/.test(trimmed);
    const mixedCount = [hasUppercase, hasLowercase, hasDigits, hasSpecial].filter(Boolean).length;

    // If it has 3+ character classes and is longer than 16 chars, likely a secret
    return mixedCount >= 3 && trimmed.length >= 16;
  }

  /** Detect the default shell for the current platform */
  static detectDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }
}

// ─── Agent Tool Definitions ─────────────────────────────────────

/**
 * Create the `terminal_write` tool definition.
 * Sends input to an active terminal session.
 */
export function createTerminalWriteTool(
  getTerminal: () => InteractiveTerminal | null,
): ExecutableToolDefinition {
  return {
    id: 'terminal_write',
    name: 'TerminalWrite',
    description:
      'Send input to an interactive terminal session. Cannot type passwords directly — ' +
      'use credential_inject for secrets. The input is written to the PTY.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The terminal session ID to write to',
        },
        input: {
          type: 'string',
          description: 'The input text to send to the terminal (include \\r\\n for Enter)',
        },
      },
      required: ['sessionId', 'input'],
    },
    riskLevel: 'execute',
    execute: safeExecute<{ sessionId: string; input: string }>(
      terminalWriteSchema,
      async (input, context) => {
        const terminal = getTerminal();
        if (!terminal) {
          return {
            success: false,
            output: null,
            error: 'InteractiveTerminal is not available. Enable the interactive_terminal feature flag.',
          };
        }
        return terminal.terminalWrite(input.sessionId, input.input, context.agentId);
      },
    ),
  };
}

/**
 * Create the `terminal_read` tool definition.
 * Reads output from a terminal session since the last read.
 */
export function createTerminalReadTool(
  getTerminal: () => InteractiveTerminal | null,
): ExecutableToolDefinition {
  return {
    id: 'terminal_read',
    name: 'TerminalRead',
    description:
      'Read output from an interactive terminal session since the last read. ' +
      'Optionally specify a timeout (ms) to wait for new output.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The terminal session ID to read from',
        },
        timeout: {
          type: 'number',
          description: 'Milliseconds to wait for new output if buffer is empty (max: 30000)',
        },
      },
      required: ['sessionId'],
    },
    riskLevel: 'read-only',
    execute: safeExecute<{ sessionId: string; timeout?: number }>(
      terminalReadSchema,
      async (input, _context) => {
        const terminal = getTerminal();
        if (!terminal) {
          return {
            success: false,
            output: null,
            error: 'InteractiveTerminal is not available. Enable the interactive_terminal feature flag.',
          };
        }
        return terminal.terminalRead(input.sessionId, input.timeout);
      },
    ),
  };
}

/**
 * Create the `terminal_status` tool definition.
 * Returns the current status of a terminal session.
 */
export function createTerminalStatusTool(
  getTerminal: () => InteractiveTerminal | null,
): ExecutableToolDefinition {
  return {
    id: 'terminal_status',
    name: 'TerminalStatus',
    description:
      'Get the current status of an interactive terminal session including ' +
      'whether it has buffered output, is active, idle, or timed out.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The terminal session ID to check',
        },
      },
      required: ['sessionId'],
    },
    riskLevel: 'read-only',
    execute: safeExecute<{ sessionId: string }>(
      terminalStatusSchema,
      async (input, _context) => {
        const terminal = getTerminal();
        if (!terminal) {
          return {
            success: false,
            output: null,
            error: 'InteractiveTerminal is not available. Enable the interactive_terminal feature flag.',
          };
        }
        return terminal.terminalStatus(input.sessionId);
      },
    ),
  };
}

// ─── Registration Helper ────────────────────────────────────────

/**
 * Register all interactive terminal tools with a ToolSystem instance.
 *
 * @param toolSystem - The ToolSystem to register tools with
 * @param getTerminal - Getter returning the InteractiveTerminal instance (or null if not ready)
 */
export function registerInteractiveTerminalTools(
  toolSystem: { register: (tool: ExecutableToolDefinition) => void },
  getTerminal: () => InteractiveTerminal | null,
): void {
  toolSystem.register(createTerminalWriteTool(getTerminal));
  toolSystem.register(createTerminalReadTool(getTerminal));
  toolSystem.register(createTerminalStatusTool(getTerminal));
}
