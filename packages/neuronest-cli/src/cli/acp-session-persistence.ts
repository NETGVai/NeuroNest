// File: packages/neuronest-cli/src/cli/acp-session-persistence.ts
//
// ACP Session Persistence — Persists ACP session metadata and messages
// to SQLite so they survive process restarts and can be viewed in the
// desktop app. Also provides a `desktopCrossOpen` function to signal the
// desktop app to open a specific ACP session.
//
// The actual SQLite operations are abstracted behind an interface (dependency
// injection) rather than importing the main app's database directly — this
// keeps the CLI package decoupled from Electron/main-process internals.
//
// Validates: Requirements 20.7, 20.8 (mapped to Req 16.9, 16.10)

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection, type Socket } from 'node:net';

// ─── Types ──────────────────────────────────────────────────────

/** Status of an ACP session. */
export type ACPSessionStatus = 'active' | 'stopped' | 'error';

/** Persisted ACP session record. */
export interface ACPSessionRecord {
  sessionId: string;
  projectDir: string;
  createdAt: string;
  status: ACPSessionStatus;
  messageCount: number;
  lastActivityAt: string;
  crossOpenable: boolean;
}

/** A message stored within a session. */
export interface ACPSessionMessage {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/** Full session with messages for load/open operations. */
export interface ACPSessionWithMessages {
  session: ACPSessionRecord;
  messages: ACPSessionMessage[];
}

// ─── Storage Interface (Dependency Injection) ────────────────────

/**
 * Abstract storage interface for session persistence.
 * Implementations can use SQLite, in-memory storage, or any backend.
 * The CLI package programs against this interface rather than importing
 * the main app's database directly.
 */
export interface ACPSessionStorage {
  /** Persist or update a session record. */
  upsertSession(record: ACPSessionRecord): void;

  /** Retrieve a session record by ID. Returns null if not found. */
  getSession(sessionId: string): ACPSessionRecord | null;

  /** List all session records, optionally filtered by project directory. */
  listSessions(projectDir?: string): ACPSessionRecord[];

  /** Append a message to a session's message log. */
  appendMessage(message: ACPSessionMessage): void;

  /** Retrieve all messages for a session, ordered by timestamp. */
  getMessages(sessionId: string): ACPSessionMessage[];

  /** Delete a session and its messages. */
  deleteSession(sessionId: string): void;
}

// ─── Desktop Cross-Open Types ────────────────────────────────────

/** Result of a desktop cross-open attempt. */
export interface CrossOpenResult {
  success: boolean;
  method: 'ipc' | 'pending-marker';
  message: string;
}

/** Configuration for the persistence service. */
export interface ACPSessionPersistenceConfig {
  /** Storage backend (injected). */
  storage: ACPSessionStorage;
  /** Path for pending-open markers (default: ~/.neuronest/pending-opens/). */
  pendingOpenDir?: string;
  /** IPC socket path for desktop app communication (default: ~/.neuronest/desktop.sock). */
  ipcSocketPath?: string;
  /** Timeout for IPC connection attempts in ms (default: 2000). */
  ipcTimeoutMs?: number;
}

// ─── ACP Session Persistence Service ─────────────────────────────

/**
 * Manages ACP session persistence and desktop cross-open signaling.
 *
 * Sessions created through the ACP server are persisted so they:
 * 1. Survive process restarts (Req 20.7)
 * 2. Can be opened in the desktop app with full history (Req 20.7)
 *
 * The `desktopCrossOpen` function signals the desktop app to open
 * a session's conversation view, with a fallback to pending-open
 * markers when the desktop isn't running.
 */
export class ACPSessionPersistence {
  private readonly storage: ACPSessionStorage;
  private readonly pendingOpenDir: string;
  private readonly ipcSocketPath: string;
  private readonly ipcTimeoutMs: number;

  constructor(config: ACPSessionPersistenceConfig) {
    this.storage = config.storage;
    this.pendingOpenDir = config.pendingOpenDir
      ?? join(homedir(), '.neuronest', 'pending-opens');
    this.ipcSocketPath = config.ipcSocketPath
      ?? join(homedir(), '.neuronest', 'desktop.sock');
    this.ipcTimeoutMs = config.ipcTimeoutMs ?? 2000;
  }

  /**
   * Persist a new or updated ACP session to storage.
   *
   * Call this when a session is created (agent/start) and whenever
   * meaningful state changes occur (messages, status changes).
   */
  saveSession(session: ACPSessionRecord): void {
    if (!session.sessionId) {
      throw new Error('sessionId is required');
    }
    if (!session.projectDir) {
      throw new Error('projectDir is required');
    }
    this.storage.upsertSession(session);
  }

  /**
   * Load a persisted session with all its messages.
   *
   * @returns The session record and messages, or null if not found.
   */
  loadSession(sessionId: string): ACPSessionWithMessages | null {
    const session = this.storage.getSession(sessionId);
    if (!session) return null;

    const messages = this.storage.getMessages(sessionId);
    return { session, messages };
  }

  /**
   * List all persisted ACP sessions, optionally filtered by project directory.
   *
   * Sessions are returned sorted by lastActivityAt descending (most recent first).
   */
  listSessions(projectDir?: string): ACPSessionRecord[] {
    const sessions = this.storage.listSessions(projectDir);
    return sessions.sort((a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }

  /**
   * Mark a session as viewable from the desktop app.
   *
   * This sets the `crossOpenable` flag, indicating the session has enough
   * context to be meaningfully opened in a desktop conversation view.
   */
  markCrossOpenable(sessionId: string): void {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.storage.upsertSession({ ...session, crossOpenable: true });
  }

  /**
   * Append a message to a session's persisted message log.
   *
   * Also updates the session's messageCount and lastActivityAt.
   */
  addMessage(sessionId: string, role: ACPSessionMessage['role'], content: string): ACPSessionMessage {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message: ACPSessionMessage = {
      messageId: randomUUID(),
      sessionId,
      role,
      content,
      timestamp: new Date().toISOString(),
    };

    this.storage.appendMessage(message);

    // Update session activity metadata
    this.storage.upsertSession({
      ...session,
      messageCount: session.messageCount + 1,
      lastActivityAt: message.timestamp,
    });

    return message;
  }

  /**
   * Signal the desktop app to open an ACP session's conversation view.
   *
   * Strategy:
   * 1. Check if the desktop app is running (via IPC socket check)
   * 2. If running: send `open-session` IPC message
   * 3. If not running: write a pending-open marker file that the desktop
   *    reads on next launch
   *
   * @returns Result indicating which method was used and whether it succeeded.
   */
  async desktopCrossOpen(sessionId: string): Promise<CrossOpenResult> {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      return {
        success: false,
        method: 'pending-marker',
        message: `Session not found: ${sessionId}`,
      };
    }

    // Attempt IPC connection to desktop app
    const desktopRunning = await this.isDesktopRunning();

    if (desktopRunning) {
      return this.sendOpenSessionIPC(sessionId);
    }

    // Desktop not running — write pending-open marker
    return this.writePendingOpenMarker(sessionId);
  }

  /**
   * Check if the desktop app is running by attempting to connect
   * to its IPC socket.
   */
  private isDesktopRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      let socket: Socket | null = null;
      const timeout = setTimeout(() => {
        if (socket) {
          socket.destroy();
        }
        resolve(false);
      }, this.ipcTimeoutMs);

      try {
        socket = createConnection(this.ipcSocketPath, () => {
          clearTimeout(timeout);
          socket!.destroy();
          resolve(true);
        });

        socket.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      } catch {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  /**
   * Send an `open-session` IPC message to the running desktop app.
   */
  private sendOpenSessionIPC(sessionId: string): Promise<CrossOpenResult> {
    return new Promise((resolve) => {
      let socket: Socket | null = null;
      const timeout = setTimeout(() => {
        if (socket) {
          socket.destroy();
        }
        // Fallback to pending marker on timeout
        resolve(this.writePendingOpenMarker(sessionId));
      }, this.ipcTimeoutMs);

      try {
        socket = createConnection(this.ipcSocketPath, () => {
          const message = JSON.stringify({
            type: 'open-session',
            sessionId,
            timestamp: new Date().toISOString(),
          });
          socket!.write(message + '\n');
          clearTimeout(timeout);
          socket!.destroy();
          resolve({
            success: true,
            method: 'ipc',
            message: `Sent open-session IPC for ${sessionId}`,
          });
        });

        socket.on('error', () => {
          clearTimeout(timeout);
          // Fallback to pending marker
          resolve(this.writePendingOpenMarker(sessionId));
        });
      } catch {
        clearTimeout(timeout);
        resolve(this.writePendingOpenMarker(sessionId));
      }
    });
  }

  /**
   * Write a pending-open marker file for the desktop app to read on next launch.
   *
   * Marker format: JSON file named `{sessionId}.json` containing session metadata
   * and the requested open time.
   */
  private writePendingOpenMarker(sessionId: string): CrossOpenResult {
    try {
      if (!existsSync(this.pendingOpenDir)) {
        mkdirSync(this.pendingOpenDir, { recursive: true });
      }

      const markerPath = join(this.pendingOpenDir, `${sessionId}.json`);
      const marker = {
        sessionId,
        requestedAt: new Date().toISOString(),
        source: 'acp',
      };

      writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');

      return {
        success: true,
        method: 'pending-marker',
        message: `Pending-open marker written for ${sessionId}`,
      };
    } catch (err) {
      return {
        success: false,
        method: 'pending-marker',
        message: `Failed to write pending-open marker: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Read and consume pending-open markers (called by the desktop app on launch).
   *
   * Returns session IDs that should be opened, and removes the marker files.
   */
  consumePendingOpens(): string[] {
    const sessionIds: string[] = [];

    if (!existsSync(this.pendingOpenDir)) {
      return sessionIds;
    }

    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const files = readdirSync(this.pendingOpenDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const markerPath = join(this.pendingOpenDir, file);
        try {
          const content = readFileSync(markerPath, 'utf-8');
          const marker = JSON.parse(content) as { sessionId: string };
          if (marker.sessionId) {
            sessionIds.push(marker.sessionId);
          }
          unlinkSync(markerPath);
        } catch {
          // Skip malformed markers
        }
      }
    } catch {
      // Directory read failure — return empty
    }

    return sessionIds;
  }
}

// ─── In-Memory Storage (for testing and fallback) ────────────────

/**
 * In-memory implementation of ACPSessionStorage.
 * Useful for testing and as a fallback when SQLite is unavailable.
 */
export class InMemorySessionStorage implements ACPSessionStorage {
  private sessions = new Map<string, ACPSessionRecord>();
  private messages = new Map<string, ACPSessionMessage[]>();

  upsertSession(record: ACPSessionRecord): void {
    this.sessions.set(record.sessionId, { ...record });
  }

  getSession(sessionId: string): ACPSessionRecord | null {
    const record = this.sessions.get(sessionId);
    return record ? { ...record } : null;
  }

  listSessions(projectDir?: string): ACPSessionRecord[] {
    const all = Array.from(this.sessions.values());
    if (projectDir) {
      return all.filter(s => s.projectDir === projectDir);
    }
    return all;
  }

  appendMessage(message: ACPSessionMessage): void {
    const existing = this.messages.get(message.sessionId) ?? [];
    existing.push({ ...message });
    this.messages.set(message.sessionId, existing);
  }

  getMessages(sessionId: string): ACPSessionMessage[] {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
  }

  /** Helper for tests — clear all data. */
  clear(): void {
    this.sessions.clear();
    this.messages.clear();
  }
}
