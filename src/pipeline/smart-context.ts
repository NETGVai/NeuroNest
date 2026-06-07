/**
 * Smart Context Manager — per-step context filtering for multi-step plans.
 *
 * Determines which files are relevant to each step of a plan and only loads
 * those, creating a sliding context window that grows and shrinks as needed.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ContextSelection {
  id: string;
  sessionId: string;
  stepNum: number;
  selectedFiles: string[];
  totalTokens: number;
  reason?: string;
  createdAt: string;
}

export class SmartContextManager {
  constructor(private db: Database.Database) {}

  /** Record which files were selected for a given step */
  recordSelection(sessionId: string, stepNum: number, files: string[], totalTokens: number, reason?: string): ContextSelection {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO context_selections (id, session_id, step_num, selected_files, total_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, sessionId, stepNum, JSON.stringify(files), totalTokens, reason || null, now);
    return { id, sessionId, stepNum, selectedFiles: files, totalTokens, reason, createdAt: now };
  }

  /** Get all context selections for a session */
  getSelections(sessionId: string): ContextSelection[] {
    return (this.db.prepare(
      'SELECT * FROM context_selections WHERE session_id = ? ORDER BY step_num ASC'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id, sessionId: r.session_id, stepNum: r.step_num,
      selectedFiles: JSON.parse(r.selected_files || '[]'),
      totalTokens: r.total_tokens, reason: r.reason || undefined,
      createdAt: r.created_at,
    }));
  }

  /** Get the latest context selection for a session */
  getLatest(sessionId: string): ContextSelection | null {
    const row = this.db.prepare(
      'SELECT * FROM context_selections WHERE session_id = ? ORDER BY step_num DESC LIMIT 1'
    ).get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id, sessionId: row.session_id, stepNum: row.step_num,
      selectedFiles: JSON.parse(row.selected_files || '[]'),
      totalTokens: row.total_tokens, reason: row.reason || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * Select relevant files for a step based on the task description.
   * Uses keyword matching against file paths and content summaries.
   * In production, this would use the LLM + project map for selection.
   */
  selectFilesForStep(allFiles: string[], taskDescription: string, maxTokenBudget: number): string[] {
    if (!taskDescription || allFiles.length === 0) return allFiles;

    const keywords = taskDescription.toLowerCase()
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (keywords.length === 0) return allFiles;

    // Score each file by keyword relevance
    const scored = allFiles.map(file => {
      const fileLower = file.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (fileLower.includes(kw)) score += 2;
        // Boost for exact filename matches
        const fileName = fileLower.split('/').pop() || '';
        if (fileName.includes(kw)) score += 3;
      }
      return { file, score };
    });

    // Sort by relevance and take top files within token budget
    scored.sort((a, b) => b.score - a.score);

    // Estimate ~500 tokens per file on average
    const maxFiles = Math.max(5, Math.floor(maxTokenBudget / 500));
    const selected = scored
      .filter(s => s.score > 0)
      .slice(0, maxFiles)
      .map(s => s.file);

    // Always include at least the top 3 files even if no keyword match
    if (selected.length < 3) {
      for (const s of scored) {
        if (!selected.includes(s.file)) {
          selected.push(s.file);
          if (selected.length >= 3) break;
        }
      }
    }

    return selected;
  }

  /** Get context usage stats for a session */
  getStats(sessionId: string): { totalSteps: number; avgFiles: number; avgTokens: number; peakTokens: number } {
    const selections = this.getSelections(sessionId);
    if (selections.length === 0) return { totalSteps: 0, avgFiles: 0, avgTokens: 0, peakTokens: 0 };

    const totalFiles = selections.reduce((s, c) => s + c.selectedFiles.length, 0);
    const totalTokens = selections.reduce((s, c) => s + c.totalTokens, 0);
    const peakTokens = Math.max(...selections.map(c => c.totalTokens));

    return {
      totalSteps: selections.length,
      avgFiles: Math.round(totalFiles / selections.length),
      avgTokens: Math.round(totalTokens / selections.length),
      peakTokens,
    };
  }
}
