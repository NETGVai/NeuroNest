/**
 * Inline Code Completion Service — provides real-time code suggestions as the user types.
 *
 * Sends the current file prefix to the configured LLM and returns completion suggestions.
 * Tracks acceptance rate for analytics.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface CompletionRequest {
  filePath: string;
  prefix: string;        // code before cursor
  suffix?: string;       // code after cursor
  language?: string;
  maxTokens?: number;
  sessionId?: string;
}

export interface CompletionResult {
  id: string;
  completion: string;
  provider?: string;
  model?: string;
  latencyMs: number;
}

export interface CompletionStats {
  totalCompletions: number;
  acceptedCompletions: number;
  acceptanceRate: number;
  avgLatencyMs: number;
}

export class InlineCompletionService {
  private stmtRecord: Database.Statement;
  private stmtAccept: Database.Statement;
  private stmtStats: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtRecord = db.prepare(
      'INSERT INTO completion_history (id, session_id, file_path, prefix, completion, accepted, provider, model, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)'
    );
    this.stmtAccept = db.prepare('UPDATE completion_history SET accepted = 1 WHERE id = ?');
    this.stmtStats = db.prepare(
      'SELECT COUNT(*) as total, SUM(accepted) as accepted, AVG(latency_ms) as avg_latency FROM completion_history WHERE session_id = ? OR ? IS NULL'
    );
  }

  /**
   * Generate a completion using the provided LLM client.
   * The actual LLM call is delegated to the caller — this service handles
   * recording, tracking, and stats.
   */
  recordCompletion(req: CompletionRequest, completion: string, provider?: string, model?: string, latencyMs?: number): CompletionResult {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmtRecord.run(
      id, req.sessionId || null, req.filePath,
      req.prefix.slice(-500), // Store last 500 chars of prefix
      completion, provider || null, model || null, latencyMs || 0, now
    );
    return { id, completion, provider, model, latencyMs: latencyMs || 0 };
  }

  acceptCompletion(id: string): boolean {
    return this.stmtAccept.run(id).changes > 0;
  }

  getStats(sessionId?: string): CompletionStats {
    const row = this.stmtStats.get(sessionId || null, sessionId || null) as any;
    const total = row?.total || 0;
    const accepted = row?.accepted || 0;
    return {
      totalCompletions: total,
      acceptedCompletions: accepted,
      acceptanceRate: total > 0 ? Math.round((accepted / total) * 100) : 0,
      avgLatencyMs: Math.round(row?.avg_latency || 0),
    };
  }

  /**
   * Build a completion prompt from the file context.
   * Returns a system+user message pair suitable for any LLM.
   */
  buildCompletionPrompt(req: CompletionRequest): { system: string; user: string } {
    const lang = req.language || 'unknown';
    return {
      system: `You are an expert code completion engine. Given the code context, provide a natural continuation. Output ONLY the completion code, no explanations, no markdown fences. Keep completions concise (1-5 lines typically). Language: ${lang}`,
      user: `Complete the following code:\n\n${req.prefix.slice(-2000)}`,
    };
  }
}
