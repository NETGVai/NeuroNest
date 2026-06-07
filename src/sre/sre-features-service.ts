/**
 * SRE Features Service — evidence-backed analysis, runbooks, predictive detection,
 * investigation reports, and integration validation.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Evidence Citations ─────────────────────────────────────────

export interface EvidenceCitation {
  id: string; sessionId: string; claim: string; filePath?: string;
  lineStart?: number; lineEnd?: number; snippet?: string;
  evidenceType: string; confidence: number; createdAt: string;
}

export class EvidenceCitationService {
  constructor(private db: Database.Database) {}

  cite(sessionId: string, claim: string, opts: { filePath?: string; lineStart?: number; lineEnd?: number; snippet?: string; evidenceType?: string; confidence?: number }): EvidenceCitation {
    const id = randomUUID();
    this.db.prepare('INSERT INTO evidence_citations (id, session_id, claim, file_path, line_start, line_end, snippet, evidence_type, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, claim, opts.filePath || null, opts.lineStart || null, opts.lineEnd || null, opts.snippet || null, opts.evidenceType || 'code', opts.confidence || 0.8, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): EvidenceCitation | null {
    const r = this.db.prepare('SELECT * FROM evidence_citations WHERE id = ?').get(id) as any;
    return r ? { id: r.id, sessionId: r.session_id, claim: r.claim, filePath: r.file_path || undefined, lineStart: r.line_start || undefined, lineEnd: r.line_end || undefined, snippet: r.snippet || undefined, evidenceType: r.evidence_type, confidence: r.confidence, createdAt: r.created_at } : null;
  }

  listForSession(sessionId: string): EvidenceCitation[] {
    return (this.db.prepare('SELECT * FROM evidence_citations WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as any[])
      .map(r => ({ id: r.id, sessionId: r.session_id, claim: r.claim, filePath: r.file_path || undefined, lineStart: r.line_start || undefined, lineEnd: r.line_end || undefined, snippet: r.snippet || undefined, evidenceType: r.evidence_type, confidence: r.confidence, createdAt: r.created_at }));
  }
}

// ── Runbooks ───────────────────────────────────────────────────

export interface Runbook {
  id: string; projectId: string; name: string; description?: string;
  triggerPattern?: string; steps: { title: string; instruction: string; automated?: boolean }[];
  isBuiltin: boolean; enabled: boolean; timesUsed: number; createdAt: string;
}

const BUILTIN_RUNBOOKS: Omit<Runbook, 'id' | 'createdAt' | 'timesUsed'>[] = [
  {
    projectId: '*', name: 'Debug Failing Test', description: 'Step-by-step procedure for debugging a failing test',
    triggerPattern: 'test.*fail|failing test|broken test',
    steps: [
      { title: 'Read the error', instruction: 'Read the full test error output. Identify the assertion that failed and the expected vs actual values.' },
      { title: 'Find the test file', instruction: 'Locate the test file and the specific test case that failed. Read the test to understand what it expects.' },
      { title: 'Find the source', instruction: 'Trace from the test to the source code being tested. Read the implementation.' },
      { title: 'Identify the bug', instruction: 'Compare the test expectation with the implementation. Identify where the behavior diverges.' },
      { title: 'Fix and verify', instruction: 'Make the minimal fix. Run the test again to confirm it passes. Check that no other tests broke.' },
    ],
    isBuiltin: true, enabled: true,
  },
  {
    projectId: '*', name: 'Optimize Slow Query', description: 'Procedure for diagnosing and fixing slow database queries',
    triggerPattern: 'slow query|query.*slow|performance.*database|optimize.*query',
    steps: [
      { title: 'Identify the query', instruction: 'Find the exact SQL query or ORM call that is slow. Get the execution time.' },
      { title: 'Check indexes', instruction: 'Run EXPLAIN/EXPLAIN ANALYZE on the query. Check if it uses indexes or does a full table scan.' },
      { title: 'Add missing indexes', instruction: 'If the query scans without indexes, add appropriate indexes on the WHERE/JOIN columns.' },
      { title: 'Optimize the query', instruction: 'Simplify JOINs, reduce selected columns, add LIMIT, or restructure subqueries.' },
      { title: 'Verify improvement', instruction: 'Re-run the query and compare execution time. Ensure the fix doesn\'t break other queries.' },
    ],
    isBuiltin: true, enabled: true,
  },
  {
    projectId: '*', name: 'Security Vulnerability Fix', description: 'Procedure for fixing a security vulnerability',
    triggerPattern: 'security.*vuln|vulnerability|CVE|injection|XSS',
    steps: [
      { title: 'Assess severity', instruction: 'Determine the severity (critical/high/medium/low) and potential impact. Check if it\'s exploitable.' },
      { title: 'Reproduce', instruction: 'Create a minimal reproduction of the vulnerability. Document the attack vector.' },
      { title: 'Fix the root cause', instruction: 'Apply the fix: input validation, parameterized queries, output encoding, or access control.' },
      { title: 'Add regression test', instruction: 'Write a test that would have caught this vulnerability. Ensure it passes with the fix.' },
      { title: 'Review and deploy', instruction: 'Review the fix for completeness. Check for similar patterns elsewhere in the codebase.' },
    ],
    isBuiltin: true, enabled: true,
  },
];

export class RunbookService {
  constructor(private db: Database.Database) { this.ensureBuiltins(); }

  private ensureBuiltins(): void {
    for (const rb of BUILTIN_RUNBOOKS) {
      const existing = this.db.prepare('SELECT id FROM runbooks WHERE name = ? AND is_builtin = 1').get(rb.name) as any;
      if (!existing) {
        this.db.prepare('INSERT INTO runbooks (id, project_id, name, description, trigger_pattern, steps, is_builtin, enabled, times_used, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, ?)')
          .run(randomUUID(), '*', rb.name, rb.description || null, rb.triggerPattern || null, JSON.stringify(rb.steps), new Date().toISOString());
      }
    }
  }

  list(projectId?: string): Runbook[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM runbooks WHERE project_id = ? OR project_id = '*' ORDER BY is_builtin DESC, name ASC").all(projectId) as any[]
      : this.db.prepare('SELECT * FROM runbooks ORDER BY is_builtin DESC, name ASC').all() as any[];
    return rows.map(r => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description || undefined, triggerPattern: r.trigger_pattern || undefined, steps: JSON.parse(r.steps || '[]'), isBuiltin: r.is_builtin === 1, enabled: r.enabled === 1, timesUsed: r.times_used, createdAt: r.created_at }));
  }

  create(opts: { projectId: string; name: string; description?: string; triggerPattern?: string; steps: { title: string; instruction: string }[] }): Runbook {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runbooks (id, project_id, name, description, trigger_pattern, steps, is_builtin, enabled, times_used, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, ?)')
      .run(id, opts.projectId, opts.name, opts.description || null, opts.triggerPattern || null, JSON.stringify(opts.steps), new Date().toISOString());
    return this.list().find(r => r.id === id)!;
  }

  toggle(id: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE runbooks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM runbooks WHERE id = ? AND is_builtin = 0').run(id).changes > 0;
  }

  findMatching(text: string): Runbook | null {
    const all = this.list().filter(r => r.enabled && r.triggerPattern);
    for (const rb of all) {
      try { if (new RegExp(rb.triggerPattern!, 'i').test(text)) { this.db.prepare('UPDATE runbooks SET times_used = times_used + 1 WHERE id = ?').run(rb.id); return rb; } } catch {}
    }
    return null;
  }
}

// ── Predictive Alerts ──────────────────────────────────────────

export class PredictiveAlertService {
  constructor(private db: Database.Database) {}

  create(projectId: string, alertType: string, message: string, trendData?: Record<string, unknown>): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO predictive_alerts (id, project_id, alert_type, severity, message, trend_data, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, projectId, alertType, alertType.includes('declining') || alertType.includes('dropping') ? 'warning' : 'info', message, JSON.stringify(trendData || {}), new Date().toISOString());
    return id;
  }

  getActive(projectId: string): { id: string; alertType: string; severity: string; message: string; createdAt: string }[] {
    return (this.db.prepare('SELECT * FROM predictive_alerts WHERE project_id = ? AND acknowledged = 0 ORDER BY created_at DESC').all(projectId) as any[])
      .map(r => ({ id: r.id, alertType: r.alert_type, severity: r.severity, message: r.message, createdAt: r.created_at }));
  }

  acknowledge(id: string): boolean {
    return this.db.prepare('UPDATE predictive_alerts SET acknowledged = 1 WHERE id = ?').run(id).changes > 0;
  }

  /** Analyze trends and generate predictive alerts */
  analyzeTrends(projectId: string): string[] {
    const generated: string[] = [];

    // Check architectural quality trend
    const evoRows = this.db.prepare('SELECT score FROM arch_evolution WHERE project_id = ? ORDER BY recorded_at DESC LIMIT 5').all(projectId) as any[];
    if (evoRows.length >= 3) {
      const scores = evoRows.map(r => r.score);
      const declining = scores.every((s, i) => i === 0 || s <= scores[i - 1]!);
      if (declining && scores[0] < scores[scores.length - 1]!) {
        generated.push(this.create(projectId, 'quality_declining', 'Architectural quality has been declining over the last ' + scores.length + ' scans (' + scores[scores.length - 1] + ' → ' + scores[0] + '). Consider reviewing recent changes.'));
      }
    }

    // Check cost trend
    try {
      const costRows = this.db.prepare("SELECT value FROM config WHERE key = 'total-cost'").get() as any;
      if (costRows && parseFloat(costRows.value) > 10) {
        generated.push(this.create(projectId, 'cost_increasing', 'Total AI cost has exceeded $' + parseFloat(costRows.value).toFixed(2) + '. Consider using Cost Saver model pack or local models.'));
      }
    } catch {}

    return generated;
  }
}

// ── Investigation Reports ──────────────────────────────────────

export interface InvestigationReport {
  id: string; sessionId: string; projectId: string; title: string;
  summary: string; rootCause?: string; evidence: string[];
  recommendations: string[]; nextSteps: string[];
  severity: string; status: string; createdAt: string;
}

export class InvestigationReportService {
  constructor(private db: Database.Database) {}

  create(opts: { sessionId: string; projectId: string; title: string; summary: string; rootCause?: string; evidence?: string[]; recommendations?: string[]; nextSteps?: string[]; severity?: string }): InvestigationReport {
    const id = randomUUID();
    this.db.prepare('INSERT INTO investigation_reports (id, session_id, project_id, title, summary, root_cause, evidence, recommendations, next_steps, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.sessionId, opts.projectId, opts.title, opts.summary, opts.rootCause || null, JSON.stringify(opts.evidence || []), JSON.stringify(opts.recommendations || []), JSON.stringify(opts.nextSteps || []), opts.severity || 'info', 'open', new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): InvestigationReport | null {
    const r = this.db.prepare('SELECT * FROM investigation_reports WHERE id = ?').get(id) as any;
    return r ? { id: r.id, sessionId: r.session_id, projectId: r.project_id, title: r.title, summary: r.summary, rootCause: r.root_cause || undefined, evidence: JSON.parse(r.evidence || '[]'), recommendations: JSON.parse(r.recommendations || '[]'), nextSteps: JSON.parse(r.next_steps || '[]'), severity: r.severity, status: r.status, createdAt: r.created_at } : null;
  }

  listForProject(projectId: string): InvestigationReport[] {
    return (this.db.prepare('SELECT * FROM investigation_reports WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId) as any[])
      .map(r => ({ id: r.id, sessionId: r.session_id, projectId: r.project_id, title: r.title, summary: r.summary, rootCause: r.root_cause || undefined, evidence: JSON.parse(r.evidence || '[]'), recommendations: JSON.parse(r.recommendations || '[]'), nextSteps: JSON.parse(r.next_steps || '[]'), severity: r.severity, status: r.status, createdAt: r.created_at }));
  }

  updateStatus(id: string, status: string): boolean {
    return this.db.prepare('UPDATE investigation_reports SET status = ? WHERE id = ?').run(status, id).changes > 0;
  }
}

// ── Integration Validation ─────────────────────────────────────

export class IntegrationValidationService {
  constructor(private db: Database.Database) {}

  record(name: string, status: string, errorMessage?: string, details?: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT id FROM integration_validations WHERE integration_name = ?').get(name) as any;
    if (existing) {
      this.db.prepare('UPDATE integration_validations SET status = ?, last_tested_at = ?, error_message = ?, details = ? WHERE id = ?')
        .run(status, new Date().toISOString(), errorMessage || null, JSON.stringify(details || {}), existing.id);
    } else {
      this.db.prepare('INSERT INTO integration_validations (id, integration_name, status, last_tested_at, error_message, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), name, status, new Date().toISOString(), errorMessage || null, JSON.stringify(details || {}));
    }
  }

  getAll(): { name: string; status: string; lastTestedAt?: string; errorMessage?: string }[] {
    return (this.db.prepare('SELECT * FROM integration_validations ORDER BY integration_name ASC').all() as any[])
      .map(r => ({ name: r.integration_name, status: r.status, lastTestedAt: r.last_tested_at || undefined, errorMessage: r.error_message || undefined }));
  }

  getStatus(name: string): string {
    const r = this.db.prepare('SELECT status FROM integration_validations WHERE integration_name = ?').get(name) as any;
    return r ? r.status : 'untested';
  }
}
