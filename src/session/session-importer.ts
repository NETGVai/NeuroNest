/**
 * Session Importer — Imports shared session archives and reconstructs them in a new context.
 *
 * Handles import of JSON session archives, optional re-execution (replay of agent steps),
 * and generation of shareable links when cloud sync is enabled.
 *
 * Requirements: 6.3, 6.4
 */

import { randomUUID } from 'node:crypto';
import type {
  SessionArchive,
  ExportedToolCall,
} from './session-exporter.js';
import { SessionExporter } from './session-exporter.js';

// ─── Types ──────────────────────────────────────────────────────

/** Options for session import */
export interface ImportOptions {
  /** Override the session name (defaults to archive's session name) */
  sessionName?: string;
  /** Whether to replay agent tool calls (re-execute steps) */
  replayToolCalls?: boolean;
  /** Assign to a specific project */
  projectId?: string;
  /** If true, create a new session ID rather than using the archived one */
  forceNewId?: boolean;
}

/** Result of an import operation */
export interface ImportResult {
  success: boolean;
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  messagesImported?: number | undefined;
  toolCallsImported?: number | undefined;
  fileChangesImported?: number | undefined;
  replayResults?: ReplayResult[] | undefined;
  error?: string | undefined;
}

/** Result of replaying a single tool call */
export interface ReplayResult {
  toolCallId: string;
  tool: string;
  success: boolean;
  output?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/** Options for generating a shareable link */
export interface ShareLinkOptions {
  /** Link expiration in hours (default: 24) */
  expirationHours?: number;
  /** Whether link requires a PIN to access */
  requirePin?: boolean;
  /** Maximum number of accesses before link expires */
  maxAccesses?: number;
}

/** Result of share link generation */
export interface ShareLinkResult {
  success: boolean;
  url?: string;
  shareId?: string;
  expiresAt?: string;
  error?: string;
}

/** Validation result for an archive */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  archive?: SessionArchive | undefined;
}

// ─── Session Importer ───────────────────────────────────────────

/**
 * SessionImporter handles reconstruction of sessions from archive data.
 * Uses a lazy-initialized singleton pattern consistent with the codebase.
 */
export class SessionImporter {
  private static instance: SessionImporter | null = null;
  private db: any;

  private constructor(db: any) {
    this.db = db;
  }

  static getInstance(db?: any): SessionImporter {
    if (!SessionImporter.instance) {
      if (!db) throw new Error('SessionImporter requires database on first initialization');
      SessionImporter.instance = new SessionImporter(db);
    }
    return SessionImporter.instance;
  }

  /**
   * Validate an archive buffer or JSON before importing.
   */
  validate(input: Buffer | SessionArchive): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let archive: SessionArchive | undefined;

    try {
      if (Buffer.isBuffer(input)) {
        const exporter = SessionExporter.getInstance();
        const decompressed = exporter.decompress(input);
        if (!decompressed) {
          errors.push('Failed to decompress archive — invalid gzip data');
          return { valid: false, errors, warnings };
        }
        archive = decompressed;
      } else {
        archive = input;
      }

      // Validate version
      if (!archive.version || archive.version !== '1.0') {
        errors.push(`Unsupported archive version: ${archive.version || 'missing'}`);
      }

      // Validate metadata
      if (!archive.metadata) {
        errors.push('Missing metadata section');
      } else {
        if (!archive.metadata.sessionId) errors.push('Missing metadata.sessionId');
        if (!archive.metadata.sessionName) warnings.push('Missing metadata.sessionName');
        if (!archive.metadata.exportedAt) warnings.push('Missing metadata.exportedAt');
      }

      // Validate messages
      if (!Array.isArray(archive.messages)) {
        errors.push('Missing or invalid messages array');
      } else if (archive.messages.length === 0) {
        warnings.push('Archive contains no messages');
      }

      // Validate tool calls
      if (archive.toolCalls && !Array.isArray(archive.toolCalls)) {
        errors.push('Invalid toolCalls — expected array');
      }

      // Validate file changes
      if (archive.fileChanges && !Array.isArray(archive.fileChanges)) {
        errors.push('Invalid fileChanges — expected array');
      }
    } catch (err: any) {
      errors.push(`Validation error: ${err?.message || 'unknown'}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      archive: errors.length === 0 ? archive : undefined,
    };
  }

  /**
   * Import a session archive into the local database.
   */
  async import(
    input: Buffer | SessionArchive,
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const validation = this.validate(input);
    if (!validation.valid || !validation.archive) {
      return { success: false, error: `Invalid archive: ${validation.errors.join('; ')}` };
    }

    const archive = validation.archive;
    const {
      sessionName = archive.metadata.sessionName || 'Imported Session',
      replayToolCalls = false,
      projectId: _projectId,
      forceNewId = true,
    } = options;

    try {
      const newSessionId = forceNewId ? randomUUID() : archive.metadata.sessionId;
      const now = new Date().toISOString();

      // Create the session record
      this.db.prepare(
        'INSERT OR REPLACE INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(newSessionId, sessionName, now, now);

      // Import messages
      const msgStmt = this.db.prepare(
        'INSERT INTO messages (id, session_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      let messagesImported = 0;
      for (const msg of archive.messages) {
        const msgId = forceNewId ? randomUUID() : (msg.id || randomUUID());
        msgStmt.run(
          msgId,
          newSessionId,
          msg.role,
          msg.content,
          msg.agent ? JSON.stringify({ agent: msg.agent }) : null,
          msg.createdAt || now,
        );
        messagesImported++;
      }

      // Record the import in session_exports table
      try {
        this.db.prepare(
          `INSERT INTO session_exports (id, session_id, export_type, status, metadata, created_at)
           VALUES (?, ?, 'import', 'completed', ?, ?)`,
        ).run(
          randomUUID(),
          newSessionId,
          JSON.stringify({
            originalSessionId: archive.metadata.sessionId,
            originalName: archive.metadata.sessionName,
            exportedAt: archive.metadata.exportedAt,
            messageCount: messagesImported,
            toolCallCount: archive.toolCalls?.length || 0,
            fileChangeCount: archive.fileChanges?.length || 0,
            scrubbed: archive.metadata.scrubbed,
          }),
          now,
        );
      } catch {
        // session_exports table may not exist yet (migration pending) — non-fatal
      }

      // Replay tool calls if requested
      let replayResults: ReplayResult[] | undefined;
      if (replayToolCalls && archive.toolCalls && archive.toolCalls.length > 0) {
        replayResults = await this.replayToolCalls(archive.toolCalls, newSessionId);
      }

      return {
        success: true,
        sessionId: newSessionId,
        sessionName,
        messagesImported,
        toolCallsImported: archive.toolCalls?.length || 0,
        fileChangesImported: archive.fileChanges?.length || 0,
        replayResults,
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Import failed' };
    }
  }

  /**
   * Replay tool calls from an imported session.
   * Each tool call is attempted in order; failures are recorded but don't block subsequent calls.
   */
  private async replayToolCalls(
    toolCalls: ExportedToolCall[],
    sessionId: string,
  ): Promise<ReplayResult[]> {
    const results: ReplayResult[] = [];

    // Tools that are safe to replay (read-only or idempotent)
    const SAFE_TO_REPLAY = new Set([
      'file_read', 'file_list', 'search', 'grep',
      'web_fetch', 'web_search', 'browser:fetch',
    ]);

    // Tools that should never be replayed (destructive or side-effecting)
    const NEVER_REPLAY = new Set([
      'terminal', 'file_delete', 'file_write', 'git_push',
      'deploy', 'send_email', 'send_message',
    ]);

    for (const tc of toolCalls) {
      if (NEVER_REPLAY.has(tc.tool)) {
        results.push({
          toolCallId: tc.id,
          tool: tc.tool,
          success: false,
          skipped: true,
          skipReason: `Tool '${tc.tool}' is destructive and cannot be replayed`,
        });
        continue;
      }

      if (!SAFE_TO_REPLAY.has(tc.tool)) {
        results.push({
          toolCallId: tc.id,
          tool: tc.tool,
          success: false,
          skipped: true,
          skipReason: `Tool '${tc.tool}' is not in the safe-to-replay list`,
        });
        continue;
      }

      // Attempt replay via tool executor
      try {
        const { executeTool } = await import('../pipeline/tool-executor.js');
        const result = executeTool({ tool: tc.tool as import('../pipeline/tool-executor.js').ToolType, ...tc.args, projectId: sessionId } as any);
        results.push({
          toolCallId: tc.id,
          tool: tc.tool,
          success: result?.success ?? false,
          output: result?.output?.slice(0, 2000),
          error: result?.error,
        });
      } catch (err: any) {
        results.push({
          toolCallId: tc.id,
          tool: tc.tool,
          success: false,
          error: err?.message || 'Replay execution failed',
        });
      }
    }

    return results;
  }

  /**
   * Generate a shareable link for an exported session.
   * Requires cloud sync to be enabled (configured via settings).
   */
  generateShareLink(
    sessionId: string,
    archiveBuffer: Buffer,
    options: ShareLinkOptions = {},
  ): ShareLinkResult {
    const {
      expirationHours = 24,
      requirePin = false,
      maxAccesses = 100,
    } = options;

    try {
      // Check if cloud sync is configured
      const cloudConfig = this.getCloudSyncConfig();
      if (!cloudConfig || !cloudConfig.enabled) {
        return {
          success: false,
          error: 'Cloud sync is not enabled. Configure cloud sync in Settings to generate shareable links.',
        };
      }

      const shareId = randomUUID();
      const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000).toISOString();

      // Store the share record locally
      try {
        this.db.prepare(
          `INSERT INTO session_exports (id, session_id, export_type, status, metadata, created_at, expires_at)
           VALUES (?, ?, 'share_link', 'active', ?, ?, ?)`,
        ).run(
          shareId,
          sessionId,
          JSON.stringify({
            requirePin,
            maxAccesses,
            currentAccesses: 0,
            archiveSize: archiveBuffer.length,
          }),
          new Date().toISOString(),
          expiresAt,
        );
      } catch {
        // session_exports table may not exist yet — non-fatal for link generation
      }

      // In a full implementation, this would upload the archive to the cloud
      // service and return a public URL. For now, return a local reference.
      const url = `${cloudConfig.baseUrl || 'neuronest://share'}/${shareId}`;

      return {
        success: true,
        url,
        shareId,
        expiresAt,
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to generate share link' };
    }
  }

  /**
   * Read cloud sync configuration from the database.
   */
  private getCloudSyncConfig(): { enabled: boolean; baseUrl?: string } | null {
    try {
      const row = this.db.prepare("SELECT value FROM config WHERE key = 'cloud-sync-config'").get() as any;
      if (row) {
        return JSON.parse(row.value);
      }
    } catch {
      // Config not found — cloud sync is not configured
    }
    return null;
  }
}
