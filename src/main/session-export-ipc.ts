/**
 * Session Export/Import/Share IPC Handlers
 *
 * Wires the session portability feature (export, import, share-link) to
 * renderer-accessible IPC channels. Gated behind the `session_portability` flag.
 *
 * Channels:
 *   - session:export   — Export a session as compressed JSON archive
 *   - session:import   — Import a session archive into the local database
 *   - session:share-link — Generate a shareable link (requires cloud sync)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { ipcMain } from 'electron';
import { SessionExporter } from '../session/session-exporter.js';
import { SessionImporter } from '../session/session-importer.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

export interface SessionExportIPCDeps {
  getDb: () => any;
  featureGate?: FeatureGateSystem;
  getActiveSessionId?: () => string | null;
}

/**
 * Register session export/import/share IPC handlers.
 */
export function registerSessionExportIPC(deps: SessionExportIPCDeps): void {
  const { getDb, featureGate, getActiveSessionId } = deps;

  // ── session:export ────────────────────────────────────────────
  ipcMain.handle('session:export', async (_ev, args: any) => {
    try {
      // Feature gate check
      if (featureGate && !featureGate.isEnabled('session_portability')) {
        return { success: false, error: 'Session portability feature is not enabled' };
      }

      const db = getDb();
      if (!db) return { success: false, error: 'Database not available' };

      const sessionId = args?.sessionId || getActiveSessionId?.();
      if (!sessionId) return { success: false, error: 'No session ID provided' };

      const exporter = SessionExporter.getInstance();

      // Check eligibility
      const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
      if (!sessionRow) return { success: false, error: 'Session not found' };

      const eligibility = exporter.checkEligibility({
        id: sessionId,
        securityClassification: sessionRow.security_classification,
        locked: sessionRow.locked === 1,
      });

      if (!eligibility.eligible) {
        return { success: false, error: eligibility.reason };
      }

      // Gather messages
      const messages = (db.prepare(
        'SELECT id, role, content, tool_calls, created_at FROM messages WHERE session_id = ? ORDER BY rowid ASC',
      ).all(sessionId) as any[]).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content || '',
        agent: row.tool_calls ? JSON.parse(row.tool_calls)?.agent : undefined,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        createdAt: row.created_at,
      }));

      // Gather tool calls from pipeline events (if available)
      let toolCalls: any[] = [];
      try {
        const toolRows = db.prepare(
          "SELECT * FROM pipeline_events WHERE session_id = ? AND kind LIKE 'tool.%' ORDER BY seq ASC",
        ).all(sessionId) as any[];
        toolCalls = toolRows.map((row) => {
          const payload = row.payload ? JSON.parse(row.payload) : {};
          return {
            id: row.id || payload.callId || row.seq,
            tool: payload.name || 'unknown',
            args: payload.args || {},
            result: payload.result ? JSON.stringify(payload.result).slice(0, 5000) : undefined,
            success: row.kind === 'tool.success',
            timestamp: row.created_at || new Date().toISOString(),
          };
        });
      } catch {
        // pipeline_events table may not exist — tool calls are optional
      }

      // Export
      const result = exporter.export(
        messages,
        toolCalls,
        [], // file changes would come from a diff tracker if available
        { id: sessionId, name: sessionRow.name, projectId: sessionRow.project_id },
        {
          scrubSensitiveData: args?.scrubSensitiveData !== false,
          includeToolCalls: args?.includeToolCalls !== false,
          includeFileChanges: args?.includeFileChanges !== false,
          compress: args?.compress !== false,
          customData: args?.customData,
        },
      );

      if (result.success && result.archive) {
        // Record the export
        try {
          const crypto = require('node:crypto');
          db.prepare(
            `INSERT INTO session_exports (id, session_id, export_type, status, metadata, archive_size, created_at)
             VALUES (?, ?, 'export', 'completed', ?, ?, ?)`,
          ).run(
            crypto.randomUUID(),
            sessionId,
            JSON.stringify(result.metadata),
            result.archive.length,
            new Date().toISOString(),
          );
        } catch {
          // session_exports table may not exist yet — non-fatal
        }

        return {
          success: true,
          archive: result.archive.toString('base64'),
          metadata: result.metadata,
        };
      }

      if (result.success && result.archiveJson) {
        return {
          success: true,
          archiveJson: result.archiveJson,
          metadata: result.metadata,
        };
      }

      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Export failed' };
    }
  });

  // ── session:import ────────────────────────────────────────────
  ipcMain.handle('session:import', async (_ev, args: any) => {
    try {
      // Feature gate check
      if (featureGate && !featureGate.isEnabled('session_portability')) {
        return { success: false, error: 'Session portability feature is not enabled' };
      }

      const db = getDb();
      if (!db) return { success: false, error: 'Database not available' };

      const importer = SessionImporter.getInstance(db);

      let input: Buffer | any;
      if (args?.archiveBase64) {
        input = Buffer.from(args.archiveBase64, 'base64');
      } else if (args?.archiveJson) {
        input = args.archiveJson;
      } else {
        return { success: false, error: 'No archive data provided (supply archiveBase64 or archiveJson)' };
      }

      const result = await importer.import(input, {
        sessionName: args?.sessionName,
        replayToolCalls: args?.replayToolCalls === true,
        projectId: args?.projectId,
        forceNewId: args?.forceNewId !== false,
      });

      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Import failed' };
    }
  });

  // ── session:share-link ────────────────────────────────────────
  ipcMain.handle('session:share-link', async (_ev, args: any) => {
    try {
      // Feature gate check
      if (featureGate && !featureGate.isEnabled('session_portability')) {
        return { success: false, error: 'Session portability feature is not enabled' };
      }

      const db = getDb();
      if (!db) return { success: false, error: 'Database not available' };

      const sessionId = args?.sessionId || getActiveSessionId?.();
      if (!sessionId) return { success: false, error: 'No session ID provided' };

      // First, export the session to get the archive
      const exporter = SessionExporter.getInstance();

      const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
      if (!sessionRow) return { success: false, error: 'Session not found' };

      const eligibility = exporter.checkEligibility({
        id: sessionId,
        securityClassification: sessionRow.security_classification,
        locked: sessionRow.locked === 1,
      });

      if (!eligibility.eligible) {
        return { success: false, error: eligibility.reason };
      }

      // Gather messages for the archive
      const messages = (db.prepare(
        'SELECT id, role, content, tool_calls, created_at FROM messages WHERE session_id = ? ORDER BY rowid ASC',
      ).all(sessionId) as any[]).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content || '',
        agent: row.tool_calls ? JSON.parse(row.tool_calls)?.agent : undefined,
        createdAt: row.created_at,
      }));

      const exportResult = exporter.export(
        messages,
        [],
        [],
        { id: sessionId, name: sessionRow.name },
        { scrubSensitiveData: true, compress: true },
      );

      if (!exportResult.success || !exportResult.archive) {
        return { success: false, error: 'Failed to create archive for sharing' };
      }

      // Generate the share link
      const importer = SessionImporter.getInstance(db);
      const linkResult = importer.generateShareLink(sessionId, exportResult.archive, {
        expirationHours: args?.expirationHours || 24,
        requirePin: args?.requirePin === true,
        maxAccesses: args?.maxAccesses || 100,
      });

      return linkResult;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Share link generation failed' };
    }
  });

  console.log('[IPC] Session Export/Import/Share handlers registered');
}
