/**
 * Goose Features Service — subagents, tool permissions, adversary reviewer,
 * context compaction, turn management, response schema validation.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Subagent Tasks ─────────────────────────────────────────────

export interface SubagentTask {
  id: string; parentSessionId: string; instructions: string;
  status: string; result?: string; model?: string; maxTurns: number;
  createdAt: string; completedAt?: string;
}

export class SubagentService {
  constructor(private db: Database.Database) {}

  create(parentSessionId: string, instructions: string, model?: string, maxTurns?: number): SubagentTask {
    const id = randomUUID();
    this.db.prepare('INSERT INTO subagent_tasks (id, parent_session_id, instructions, status, model, max_turns, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, parentSessionId, instructions, 'pending', model || null, maxTurns || 10, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): SubagentTask | null {
    const r = this.db.prepare('SELECT * FROM subagent_tasks WHERE id = ?').get(id) as any;
    return r ? { id: r.id, parentSessionId: r.parent_session_id, instructions: r.instructions, status: r.status, result: r.result || undefined, model: r.model || undefined, maxTurns: r.max_turns, createdAt: r.created_at, completedAt: r.completed_at || undefined } : null;
  }

  listForSession(parentSessionId: string): SubagentTask[] {
    return (this.db.prepare('SELECT * FROM subagent_tasks WHERE parent_session_id = ? ORDER BY created_at DESC').all(parentSessionId) as any[])
      .map(r => ({ id: r.id, parentSessionId: r.parent_session_id, instructions: r.instructions, status: r.status, result: r.result || undefined, model: r.model || undefined, maxTurns: r.max_turns, createdAt: r.created_at, completedAt: r.completed_at || undefined }));
  }

  updateStatus(id: string, status: string, result?: string): void {
    this.db.prepare('UPDATE subagent_tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run(status, result || null, status === 'completed' || status === 'failed' ? new Date().toISOString() : null, id);
  }
}

// ── Tool Permissions ───────────────────────────────────────────

export interface ToolPermission { projectId: string; toolName: string; level: 'allow' | 'confirm' | 'deny'; }

export class ToolPermissionService {
  constructor(private db: Database.Database) {}

  get(projectId: string, toolName: string): string {
    const r = this.db.prepare('SELECT level FROM tool_permissions WHERE project_id = ? AND tool_name = ?').get(projectId, toolName) as any;
    return r ? r.level : 'confirm';
  }

  set(projectId: string, toolName: string, level: string): void {
    this.db.prepare('INSERT OR REPLACE INTO tool_permissions (id, project_id, tool_name, level, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, toolName, level, new Date().toISOString());
  }

  listForProject(projectId: string): ToolPermission[] {
    return (this.db.prepare('SELECT * FROM tool_permissions WHERE project_id = ? ORDER BY tool_name ASC').all(projectId) as any[])
      .map(r => ({ projectId: r.project_id, toolName: r.tool_name, level: r.level }));
  }

  delete(projectId: string, toolName: string): boolean {
    return this.db.prepare('DELETE FROM tool_permissions WHERE project_id = ? AND tool_name = ?').run(projectId, toolName).changes > 0;
  }
}

// ── Adversary Reviewer ─────────────────────────────────────────

export interface AdversaryReview {
  id: string; sessionId: string; actionType: string; actionDetail: string;
  riskLevel: string; flagged: boolean; reason?: string; reviewedAt: string;
}

export class AdversaryReviewerService {
  constructor(private db: Database.Database) {}

  review(sessionId: string, actionType: string, actionDetail: string): AdversaryReview {
    const id = randomUUID();
    // Analyze the action for risk
    const risk = this.assessRisk(actionType, actionDetail);
    this.db.prepare('INSERT INTO adversary_reviews (id, session_id, action_type, action_detail, risk_level, flagged, reason, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, actionType, actionDetail, risk.level, risk.flagged ? 1 : 0, risk.reason || null, new Date().toISOString());
    return { id, sessionId, actionType, actionDetail, riskLevel: risk.level, flagged: risk.flagged, reason: risk.reason, reviewedAt: new Date().toISOString() };
  }

  getFlags(sessionId: string): AdversaryReview[] {
    return (this.db.prepare('SELECT * FROM adversary_reviews WHERE session_id = ? AND flagged = 1 ORDER BY reviewed_at DESC').all(sessionId) as any[])
      .map(r => ({ id: r.id, sessionId: r.session_id, actionType: r.action_type, actionDetail: r.action_detail, riskLevel: r.risk_level, flagged: r.flagged === 1, reason: r.reason || undefined, reviewedAt: r.reviewed_at }));
  }

  getStats(sessionId: string): { total: number; flagged: number; critical: number } {
    const r = this.db.prepare('SELECT COUNT(*) as total, SUM(flagged) as flagged, SUM(CASE WHEN risk_level = \'critical\' THEN 1 ELSE 0 END) as critical FROM adversary_reviews WHERE session_id = ?').get(sessionId) as any;
    return { total: r?.total || 0, flagged: r?.flagged || 0, critical: r?.critical || 0 };
  }

  private assessRisk(actionType: string, detail: string): { level: string; flagged: boolean; reason?: string } {
    const lowerDetail = detail.toLowerCase();
    // Critical: destructive operations
    if (/rm\s+-rf|drop\s+table|delete\s+from|format\s+c:|sudo\s+rm/i.test(detail)) {
      return { level: 'critical', flagged: true, reason: 'Destructive system command detected' };
    }
    // High: network exfiltration, credential access
    if (/curl.*\|.*sh|wget.*\|.*bash|eval\(|exec\(|process\.env\./i.test(detail)) {
      return { level: 'high', flagged: true, reason: 'Potential code injection or credential access' };
    }
    // Medium: file system writes outside project
    if (/\/etc\/|\/usr\/|~\/\.|\.ssh|\.aws|\.env/i.test(detail) && actionType === 'file_write') {
      return { level: 'medium', flagged: true, reason: 'File operation outside project directory' };
    }
    // Low: normal operations
    return { level: 'low', flagged: false };
  }
}

// ── Context Compaction ─────────────────────────────────────────

export class ContextCompactionService {
  constructor(private db: Database.Database) {}

  record(sessionId: string, tokensBefore: number, tokensAfter: number, messagesRemoved: number): void {
    this.db.prepare('INSERT INTO context_compactions (id, session_id, tokens_before, tokens_after, messages_removed, compacted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, tokensBefore, tokensAfter, messagesRemoved, new Date().toISOString());
  }

  getHistory(sessionId: string): { tokensBefore: number; tokensAfter: number; messagesRemoved: number; compactedAt: string }[] {
    return (this.db.prepare('SELECT * FROM context_compactions WHERE session_id = ? ORDER BY compacted_at DESC').all(sessionId) as any[])
      .map(r => ({ tokensBefore: r.tokens_before, tokensAfter: r.tokens_after, messagesRemoved: r.messages_removed, compactedAt: r.compacted_at }));
  }

  getStats(sessionId: string): { totalCompactions: number; totalTokensSaved: number } {
    const r = this.db.prepare('SELECT COUNT(*) as total, SUM(tokens_before - tokens_after) as saved FROM context_compactions WHERE session_id = ?').get(sessionId) as any;
    return { totalCompactions: r?.total || 0, totalTokensSaved: r?.saved || 0 };
  }
}

// ── Turn Management ────────────────────────────────────────────

export class TurnManagementService {
  constructor(private db: Database.Database) {}

  getLimit(sessionId: string): { maxTurns: number; currentTurn: number } {
    const r = this.db.prepare('SELECT * FROM turn_limits WHERE session_id = ?').get(sessionId) as any;
    return r ? { maxTurns: r.max_turns, currentTurn: r.current_turn } : { maxTurns: 100, currentTurn: 0 };
  }

  setLimit(sessionId: string, maxTurns: number): void {
    this.db.prepare('INSERT OR REPLACE INTO turn_limits (session_id, max_turns, current_turn, updated_at) VALUES (?, ?, COALESCE((SELECT current_turn FROM turn_limits WHERE session_id = ?), 0), ?)')
      .run(sessionId, maxTurns, sessionId, new Date().toISOString());
  }

  incrementTurn(sessionId: string): { currentTurn: number; maxTurns: number; exceeded: boolean } {
    const current = this.getLimit(sessionId);
    const newTurn = current.currentTurn + 1;
    this.db.prepare('INSERT OR REPLACE INTO turn_limits (session_id, max_turns, current_turn, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, current.maxTurns, newTurn, new Date().toISOString());
    return { currentTurn: newTurn, maxTurns: current.maxTurns, exceeded: newTurn >= current.maxTurns };
  }

  reset(sessionId: string): void {
    this.db.prepare('UPDATE turn_limits SET current_turn = 0, updated_at = ? WHERE session_id = ?')
      .run(new Date().toISOString(), sessionId);
  }
}

// ── Response Schema Validation ─────────────────────────────────

export class ResponseSchemaService {
  constructor(private db: Database.Database) {}

  create(name: string, schema: unknown, description?: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO response_schemas (id, name, schema, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, JSON.stringify(schema), description || null, new Date().toISOString());
    return id;
  }

  get(id: string): { id: string; name: string; schema: unknown; description?: string } | null {
    const r = this.db.prepare('SELECT * FROM response_schemas WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, schema: JSON.parse(r.schema), description: r.description || undefined } : null;
  }

  list(): { id: string; name: string; description?: string }[] {
    return (this.db.prepare('SELECT id, name, description FROM response_schemas ORDER BY name ASC').all() as any[])
      .map(r => ({ id: r.id, name: r.name, description: r.description || undefined }));
  }

  validate(data: unknown, schema: unknown): { valid: boolean; errors: string[] } {
    // Basic JSON schema validation
    const errors: string[] = [];
    const s = schema as any;
    if (s.type === 'object' && typeof data === 'object' && data !== null) {
      if (s.properties) {
        for (const [key, prop] of Object.entries(s.properties) as any[]) {
          if (s.required && s.required.includes(key) && !(key in (data as any))) {
            errors.push('Missing required field: ' + key);
          }
        }
      }
    } else if (s.type && typeof data !== s.type) {
      errors.push('Expected type ' + s.type + ' but got ' + typeof data);
    }
    return { valid: errors.length === 0, errors };
  }

  update(id: string, name: string, schema: unknown, description?: string): boolean {
    const result = this.db.prepare('UPDATE response_schemas SET name = ?, schema = ?, description = ? WHERE id = ?')
      .run(name, JSON.stringify(schema), description || null, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM response_schemas WHERE id = ?').run(id).changes > 0;
  }

  /** Activate a schema for a specific project/session. Pass null to deactivate. */
  activate(sessionId: string, schemaId: string | null): void {
    const key = `active-schema:${sessionId}`;
    if (schemaId) {
      this.db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)")
        .run(key, schemaId, new Date().toISOString());
    } else {
      this.db.prepare("DELETE FROM config WHERE key = ?").run(key);
    }
  }

  /** Get the active schema for a session, or null if none. */
  getActive(sessionId: string): { id: string; name: string; schema: unknown; description?: string } | null {
    const key = `active-schema:${sessionId}`;
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    return this.get(row.value);
  }

  /**
   * Validate AI output against the active schema for a session.
   * Returns null if no schema is active (pass-through).
   * Returns { valid, errors, schema } if a schema is active.
   */
  validateForSession(sessionId: string, aiOutput: string): { valid: boolean; errors: string[]; schema: unknown; schemaName: string } | null {
    const active = this.getActive(sessionId);
    if (!active) return null;

    // Try to parse the AI output as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(aiOutput);
    } catch {
      return { valid: false, errors: ['Response is not valid JSON'], schema: active.schema, schemaName: active.name };
    }

    const result = this.validate(parsed, active.schema);
    return { ...result, schema: active.schema, schemaName: active.name };
  }
}
