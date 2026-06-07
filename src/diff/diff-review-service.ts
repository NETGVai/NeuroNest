/**
 * Diff Review Service — manages AI-proposed file changes for visual review.
 *
 * Provides create/accept/reject workflow for inline red/green diffs.
 * Each diff review tracks original vs proposed content for a file,
 * allowing the user to accept, reject, or partially accept changes.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface DiffReview {
  id: string;
  sessionId: string;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  status: 'pending' | 'accepted' | 'rejected' | 'partial';
  agentId?: string;
  description?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface DiffReviewSummary {
  id: string;
  filePath: string;
  status: string;
  agentId?: string;
  description?: string;
  linesAdded: number;
  linesRemoved: number;
  createdAt: string;
}

export class DiffReviewService {
  private stmtCreate: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtPending: Database.Statement;
  private stmtUpdateStatus: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtCreate = db.prepare(
      'INSERT INTO diff_reviews (id, session_id, file_path, original_content, proposed_content, status, agent_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.stmtGet = db.prepare('SELECT * FROM diff_reviews WHERE id = ?');
    this.stmtList = db.prepare('SELECT * FROM diff_reviews WHERE session_id = ? ORDER BY created_at DESC');
    this.stmtPending = db.prepare("SELECT * FROM diff_reviews WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC");
    this.stmtUpdateStatus = db.prepare('UPDATE diff_reviews SET status = ?, reviewed_at = ? WHERE id = ?');
  }

  create(opts: {
    sessionId: string;
    filePath: string;
    originalContent: string;
    proposedContent: string;
    agentId?: string;
    description?: string;
  }): DiffReview {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmtCreate.run(
      id, opts.sessionId, opts.filePath,
      opts.originalContent, opts.proposedContent,
      'pending', opts.agentId || null, opts.description || null, now
    );
    return {
      id, sessionId: opts.sessionId, filePath: opts.filePath,
      originalContent: opts.originalContent, proposedContent: opts.proposedContent,
      status: 'pending', agentId: opts.agentId, description: opts.description,
      createdAt: now,
    };
  }

  get(id: string): DiffReview | null {
    const row = this.stmtGet.get(id) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  listForSession(sessionId: string): DiffReview[] {
    return (this.stmtList.all(sessionId) as any[]).map(r => this.mapRow(r));
  }

  pendingForSession(sessionId: string): DiffReview[] {
    return (this.stmtPending.all(sessionId) as any[]).map(r => this.mapRow(r));
  }

  accept(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.stmtUpdateStatus.run('accepted', now, id);
    return result.changes > 0;
  }

  reject(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.stmtUpdateStatus.run('rejected', now, id);
    return result.changes > 0;
  }

  getSummaries(sessionId: string): DiffReviewSummary[] {
    const reviews = this.listForSession(sessionId);
    return reviews.map(r => {
      const origLines = r.originalContent.split('\n');
      const propLines = r.proposedContent.split('\n');
      let added = 0, removed = 0;
      // Simple line-count diff approximation
      const maxLen = Math.max(origLines.length, propLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (i >= origLines.length) { added++; continue; }
        if (i >= propLines.length) { removed++; continue; }
        if (origLines[i] !== propLines[i]) { added++; removed++; }
      }
      return {
        id: r.id, filePath: r.filePath, status: r.status,
        agentId: r.agentId, description: r.description,
        linesAdded: added, linesRemoved: removed, createdAt: r.createdAt,
      };
    });
  }

  private mapRow(row: any): DiffReview {
    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      originalContent: row.original_content,
      proposedContent: row.proposed_content,
      status: row.status,
      agentId: row.agent_id || undefined,
      description: row.description || undefined,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || undefined,
    };
  }
}
