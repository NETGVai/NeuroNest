/**
 * Scoped Terminal Operations — Owner/world-scoped pseudo-terminals with bounded
 * retained and model-visible output.
 *
 * Each PTY is scoped to an owner and Execution_World. Output is bounded both for
 * retention (full history limit) and model visibility (what the model can see).
 * Terminals are closed during owner or session teardown.
 *
 * Requirements: 23.5–23.6
 */

import type {
  PtyConfig,
  PtySession,
  BoundedOutput,
} from './bounded-operations-schemas';
import { PtyConfigSchema } from './bounded-operations-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Terminal authority port for creating and managing PTY sessions.
 */
export interface ScopedTerminalAuthorityPort {
  /** Create a new pseudo-terminal session. */
  createPty(config: PtyCreateConfig): Promise<PtyHandle>;
  /** Write input to a PTY session. */
  writeInput(handle: PtyHandle, data: string): Promise<void>;
  /** Read output from a PTY session. */
  readOutput(handle: PtyHandle): Promise<string>;
  /** Close a PTY session. */
  close(handle: PtyHandle): Promise<void>;
  /** Resize a PTY session. */
  resize(handle: PtyHandle, cols: number, rows: number): Promise<void>;
}

export interface PtyCreateConfig {
  shell?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PtyHandle {
  id: string;
  pid: number;
}

/**
 * Security authority port for verifying terminal access.
 */
export interface ScopedTerminalSecurityPort {
  /** Verify that terminal creation is allowed in the execution world. */
  verifyTerminalAccess(
    executionWorldId: string,
    scope: Record<string, unknown>,
  ): Promise<boolean>;
  /** Verify that a terminal belongs to the given owner and world. */
  verifyOwnership(
    terminalId: string,
    owner: string,
    executionWorldId: string,
  ): Promise<boolean>;
}

export interface ScopedTerminalDeps {
  terminal: ScopedTerminalAuthorityPort;
  security: ScopedTerminalSecurityPort;
}

// ─── Scoped Terminal Operations Service ─────────────────────────

/**
 * ScopedTerminalOps manages pseudo-terminals that are scoped to an owner and
 * Execution_World. Output is bounded for both retention and model visibility.
 */
export class ScopedTerminalOps {
  private readonly deps: ScopedTerminalDeps;
  private readonly sessions: Map<string, TerminalSession> = new Map();

  constructor(deps: ScopedTerminalDeps) {
    this.deps = deps;
  }

  /**
   * Create a new owner/world-scoped pseudo-terminal.
   *
   * Requirement 23.5: Scope the pseudo-terminal to an owner and Execution_World.
   * Requirement 23.6: Bound retained and model-visible output.
   */
  async create(config: PtyConfig): Promise<PtySession | null> {
    // Validate configuration
    const validation = PtyConfigSchema.safeParse(config);
    if (!validation.success) {
      return null;
    }

    // Verify terminal access through security authority
    const hasAccess = await this.deps.security.verifyTerminalAccess(
      config.executionWorldId,
      config.scope,
    );
    if (!hasAccess) {
      return null;
    }

    // Create the PTY through the terminal authority
    const handle = await this.deps.terminal.createPty({
      ...(config.shell !== undefined ? { shell: config.shell } : {}),
      ...(config.cols !== undefined ? { cols: config.cols } : {}),
      ...(config.rows !== undefined ? { rows: config.rows } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
    });

    const session = new TerminalSession(
      config.terminalId,
      config.owner,
      config.executionWorldId,
      handle,
      config.retainedOutputBound,
      config.modelVisibleOutputBound,
    );

    this.sessions.set(config.terminalId, session);
    return session.getState();
  }

  /**
   * Write input to a terminal session (verified by ownership).
   */
  async writeInput(terminalId: string, owner: string, data: string): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    if (!session || session.owner !== owner || session.state !== 'active') {
      return false;
    }

    await this.deps.terminal.writeInput(session.handle, data);
    return true;
  }

  /**
   * Read current output from a terminal session (bounded).
   */
  async readOutput(terminalId: string, owner: string): Promise<BoundedOutput | null> {
    const session = this.sessions.get(terminalId);
    if (!session || session.owner !== owner) {
      return null;
    }

    const rawOutput = await this.deps.terminal.readOutput(session.handle);
    session.appendOutput(rawOutput);
    return session.getModelVisibleOutput();
  }

  /**
   * Get retained output (full bounded history).
   */
  getRetainedOutput(terminalId: string, owner: string): BoundedOutput | null {
    const session = this.sessions.get(terminalId);
    if (!session || session.owner !== owner) {
      return null;
    }
    return session.getRetainedOutput();
  }

  /**
   * Get the session state.
   */
  getSession(terminalId: string): PtySession | null {
    const session = this.sessions.get(terminalId);
    return session?.getState() ?? null;
  }

  /**
   * Get all sessions for a given owner in a given execution world.
   */
  getSessionsByOwner(owner: string, executionWorldId: string): PtySession[] {
    const results: PtySession[] = [];
    for (const session of this.sessions.values()) {
      if (session.owner === owner && session.executionWorldId === executionWorldId) {
        results.push(session.getState());
      }
    }
    return results;
  }

  /**
   * Close a terminal session.
   */
  async close(terminalId: string, owner: string): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    if (!session || session.owner !== owner) {
      return false;
    }

    session.setState('closing');
    await this.deps.terminal.close(session.handle);
    session.setState('closed');
    return true;
  }

  /**
   * Requirement 23.7: Close all owned pseudo-terminals during owner teardown.
   * Returns the number of terminals closed.
   */
  async teardownOwner(owner: string, executionWorldId: string): Promise<number> {
    let closed = 0;
    const toRemove: string[] = [];

    for (const [termId, session] of this.sessions.entries()) {
      if (session.owner === owner && session.executionWorldId === executionWorldId) {
        if (session.state === 'active' || session.state === 'suspended') {
          session.setState('closing');
          await this.deps.terminal.close(session.handle);
          session.setState('closed');
        }
        toRemove.push(termId);
        closed++;
      }
    }

    for (const termId of toRemove) {
      this.sessions.delete(termId);
    }

    return closed;
  }

  /**
   * Get total active terminal count.
   */
  getActiveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'active') count++;
    }
    return count;
  }
}

// ─── Terminal Session Internal State ────────────────────────────

class TerminalSession {
  readonly terminalId: string;
  readonly owner: string;
  readonly executionWorldId: string;
  readonly handle: PtyHandle;
  readonly retainedOutputBound: number;
  readonly modelVisibleOutputBound: number;
  readonly createdAt: string;

  state: 'active' | 'suspended' | 'closing' | 'closed' = 'active';
  closedAt?: string;

  private outputBuffer: string = '';

  constructor(
    terminalId: string,
    owner: string,
    executionWorldId: string,
    handle: PtyHandle,
    retainedOutputBound: number,
    modelVisibleOutputBound: number,
  ) {
    this.terminalId = terminalId;
    this.owner = owner;
    this.executionWorldId = executionWorldId;
    this.handle = handle;
    this.retainedOutputBound = retainedOutputBound;
    this.modelVisibleOutputBound = modelVisibleOutputBound;
    this.createdAt = new Date().toISOString();
  }

  appendOutput(data: string): void {
    this.outputBuffer += data;
    // Keep output buffer within retained bound
    const bytes = Buffer.byteLength(this.outputBuffer, 'utf-8');
    if (bytes > this.retainedOutputBound) {
      // Trim from the beginning to stay within bounds
      const buf = Buffer.from(this.outputBuffer, 'utf-8');
      const trimmed = buf.subarray(bytes - this.retainedOutputBound);
      this.outputBuffer = trimmed.toString('utf-8');
    }
  }

  setState(state: 'active' | 'suspended' | 'closing' | 'closed'): void {
    this.state = state;
    if (state === 'closed') {
      this.closedAt = new Date().toISOString();
    }
  }

  /**
   * Get model-visible output (bounded to modelVisibleOutputBound).
   */
  getModelVisibleOutput(): BoundedOutput {
    return this.boundOutput(this.outputBuffer, this.modelVisibleOutputBound);
  }

  /**
   * Get retained output (bounded to retainedOutputBound).
   */
  getRetainedOutput(): BoundedOutput {
    return this.boundOutput(this.outputBuffer, this.retainedOutputBound);
  }

  getState(): PtySession {
    return {
      terminalId: this.terminalId,
      owner: this.owner,
      executionWorldId: this.executionWorldId,
      state: this.state,
      retainedOutput: this.getRetainedOutput(),
      modelVisibleOutput: this.getModelVisibleOutput(),
      createdAt: this.createdAt,
      closedAt: this.closedAt,
      schemaVersion: 1,
    };
  }

  private boundOutput(data: string, limitBytes: number): BoundedOutput {
    const bytes = Buffer.byteLength(data, 'utf-8');
    if (bytes <= limitBytes) {
      return { data, byteLength: bytes, truncated: false };
    }
    // Return the tail of the output (most recent), bounded by limit
    const buf = Buffer.from(data, 'utf-8');
    const truncated = buf.subarray(bytes - limitBytes).toString('utf-8');
    return {
      data: truncated,
      byteLength: limitBytes,
      truncated: true,
      truncatedAt: limitBytes,
    };
  }
}
