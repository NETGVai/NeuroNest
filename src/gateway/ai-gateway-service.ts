/**
 * AI Gateway Service — Centralized LLM proxy with audit logging and policy enforcement.
 *
 * Provides a single egress point for all model traffic so requests can be
 * authenticated, rate-checked against policy, and recorded to an audit trail
 * before they reach an upstream provider.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface GatewayAuditEntry {
  id: string; project_id: string | null; user_id: string | null;
  provider: string; model: string; prompt_tokens: number; completion_tokens: number;
  total_tokens: number; cost_usd: number; latency_ms: number;
  status: string; blocked_reason: string | null; created_at: string;
}
export interface GatewayConfig {
  enabled: boolean; centralized_keys: boolean; audit_all_requests: boolean;
  allowed_providers: string; allowed_models: string; rate_limit_rpm: number;
  max_tokens_per_request: number; block_on_policy_violation: boolean;
}

export class AIGatewayService {
  constructor(private db: Database.Database) {}

  getConfig(): GatewayConfig {
    const row = this.db.prepare("SELECT * FROM gateway_config WHERE id = 'global'").get() as any;
    if (row) return { ...row, enabled: !!row.enabled, centralized_keys: !!row.centralized_keys, audit_all_requests: !!row.audit_all_requests, block_on_policy_violation: !!row.block_on_policy_violation };
    this.db.prepare("INSERT INTO gateway_config (id) VALUES ('global')").run();
    return { enabled: false, centralized_keys: false, audit_all_requests: true, allowed_providers: '[]', allowed_models: '[]', rate_limit_rpm: 60, max_tokens_per_request: 0, block_on_policy_violation: true };
  }

  updateConfig(updates: Partial<GatewayConfig>): GatewayConfig {
    this.getConfig();
    const f: string[] = []; const v: any[] = [];
    if (updates.enabled !== undefined) { f.push('enabled = ?'); v.push(updates.enabled ? 1 : 0); }
    if (updates.centralized_keys !== undefined) { f.push('centralized_keys = ?'); v.push(updates.centralized_keys ? 1 : 0); }
    if (updates.audit_all_requests !== undefined) { f.push('audit_all_requests = ?'); v.push(updates.audit_all_requests ? 1 : 0); }
    if (updates.allowed_providers !== undefined) { f.push('allowed_providers = ?'); v.push(updates.allowed_providers); }
    if (updates.allowed_models !== undefined) { f.push('allowed_models = ?'); v.push(updates.allowed_models); }
    if (updates.rate_limit_rpm !== undefined) { f.push('rate_limit_rpm = ?'); v.push(updates.rate_limit_rpm); }
    if (updates.max_tokens_per_request !== undefined) { f.push('max_tokens_per_request = ?'); v.push(updates.max_tokens_per_request); }
    if (updates.block_on_policy_violation !== undefined) { f.push('block_on_policy_violation = ?'); v.push(updates.block_on_policy_violation ? 1 : 0); }
    if (f.length) { f.push('updated_at = CURRENT_TIMESTAMP'); this.db.prepare(`UPDATE gateway_config SET ${f.join(', ')} WHERE id = 'global'`).run(...v); }
    return this.getConfig();
  }

  logRequest(entry: Partial<GatewayAuditEntry>): GatewayAuditEntry {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO gateway_audit_log (id, project_id, user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, status, blocked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, entry.project_id || null, entry.user_id || null, entry.provider || '', entry.model || '', entry.prompt_tokens || 0, entry.completion_tokens || 0, entry.total_tokens || 0, entry.cost_usd || 0, entry.latency_ms || 0, entry.status || 'success', entry.blocked_reason || null
    );
    return this.db.prepare('SELECT * FROM gateway_audit_log WHERE id = ?').get(id) as GatewayAuditEntry;
  }

  getAuditLog(limit = 50, projectId?: string): GatewayAuditEntry[] {
    if (projectId) return this.db.prepare('SELECT * FROM gateway_audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as GatewayAuditEntry[];
    return this.db.prepare('SELECT * FROM gateway_audit_log ORDER BY created_at DESC LIMIT ?').all(limit) as GatewayAuditEntry[];
  }

  getStats(projectId?: string): { totalRequests: number; totalTokens: number; totalCost: number; blockedCount: number; avgLatency: number } {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const r = this.db.prepare(`SELECT COUNT(*) as t, COALESCE(SUM(total_tokens),0) as tok, COALESCE(SUM(cost_usd),0) as cost, SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) as blocked, AVG(latency_ms) as lat FROM gateway_audit_log ${where}`).get(...args) as any;
    return { totalRequests: r?.t || 0, totalTokens: r?.tok || 0, totalCost: r?.cost || 0, blockedCount: r?.blocked || 0, avgLatency: Math.round(r?.lat || 0) };
  }
}
