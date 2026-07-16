/**
 * Permission System — Tool invocation audit logging and legacy authorization.
 *
 * As of task 2.4, this module's primary role is as the **AuthAuditSink** for
 * the Authorization Pipeline. Every pipeline decision (deny, allow, ask) is
 * recorded here with full context: verdict, stage, reason, project, session,
 * agent, tool, args, and timestamp (Req 10.9).
 *
 * The `check()` method is retained for backward compatibility but is no longer
 * called from `ToolSystem.execute`. The Authorization Pipeline is now the ONLY
 * authorization gate (Req 1.3).
 *
 * Requirements: 10.9, 1.1, 1.2, 1.3
 */

import type {
  PermissionRequest,
  PermissionDecision,
  PermissionMode,
  RiskLevel,
} from '../shared/types.js';
import type { AuthAuditEntry, AuthAuditSink } from './authorization-pipeline.js';

// ─── Additional types ───────────────────────────────────────────

export interface AuditEntry {
  timestamp: Date;
  toolId: string;
  agentId: string;
  input: unknown;
  decision: 'approved' | 'denied';
  mode: PermissionMode;
}

/** Extended audit entry that captures full pipeline decision context (Req 10.9) */
export interface PipelineAuditEntry {
  timestamp: Date;
  verdict: 'deny' | 'allow' | 'ask';
  stage: string;
  reason: string;
  projectId: string | undefined;
  sessionId: string;
  agentId: string;
  toolId: string;
  toolName: string;
  args: unknown;
}

export interface AuditFilter {
  agentId?: string;
  toolId?: string;
  decision?: 'approved' | 'denied';
  since?: Date;
  until?: Date;
}

// ─── PermissionSystem ───────────────────────────────────────────

/**
 * PermissionSystem now implements AuthAuditSink so it can be wired into
 * the AuthorizationPipeline as the audit recorder for all stages (Req 10.9).
 *
 * Every decision from any pipeline stage is recorded with:
 * verdict, stage, reason, project, session, agent, tool, args, timestamp.
 */
export class PermissionSystem implements AuthAuditSink {
  private globalMode: PermissionMode = 'prompt';
  private agentModes = new Map<string, PermissionMode>();
  private allowList = new Map<string, Set<string>>(); // agentId -> Set<toolId>
  private auditLog: AuditEntry[] = [];
  private pipelineAuditLog: PipelineAuditEntry[] = [];

  // ── AuthAuditSink implementation (Req 10.9) ─────────────────

  /**
   * Record an authorization pipeline decision.
   * Every decision records: verdict, stage, reason, project, session, agent, tool, args, timestamp.
   */
  record(entry: AuthAuditEntry): void {
    this.pipelineAuditLog.push({
      timestamp: entry.timestamp,
      verdict: entry.verdict,
      stage: entry.stage,
      reason: entry.reason,
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      toolId: entry.toolId,
      toolName: entry.toolName,
      args: entry.args,
    });
  }

  /**
   * Retrieve pipeline audit entries with optional filtering.
   */
  getPipelineAuditLog(filter?: {
    agentId?: string;
    toolId?: string;
    verdict?: 'deny' | 'allow' | 'ask';
    stage?: string;
    since?: Date;
    until?: Date;
  }): PipelineAuditEntry[] {
    let entries = this.pipelineAuditLog;

    if (filter?.agentId) {
      const agentId = filter.agentId;
      entries = entries.filter((e) => e.agentId === agentId);
    }
    if (filter?.toolId) {
      const toolId = filter.toolId;
      entries = entries.filter((e) => e.toolId === toolId);
    }
    if (filter?.verdict) {
      const verdict = filter.verdict;
      entries = entries.filter((e) => e.verdict === verdict);
    }
    if (filter?.stage) {
      const stage = filter.stage;
      entries = entries.filter((e) => e.stage === stage);
    }
    if (filter?.since) {
      const since = filter.since;
      entries = entries.filter((e) => e.timestamp >= since);
    }
    if (filter?.until) {
      const until = filter.until;
      entries = entries.filter((e) => e.timestamp <= until);
    }

    return entries;
  }

  // ── Permission check ────────────────────────────────────────

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    const mode = request.modeOverride ?? this.getEffectiveMode(request.agentId);

    // Allow-list override: if tool is in agent's allow list, auto-approve
    if (this.isAllowListed(request.agentId, request.toolId)) {
      const decision: PermissionDecision = {
        allowed: true,
        reason: 'Tool is in agent allow list',
        requiresUserApproval: false,
      };
      this.logAudit(request, 'approved', mode);
      return decision;
    }

    // Mode-based decision
    switch (mode) {
      case 'auto-approve': {
        const decision: PermissionDecision = {
          allowed: true,
          reason: 'Auto-approve mode: all tools allowed',
          requiresUserApproval: false,
        };
        this.logAudit(request, 'approved', mode);
        return decision;
      }

      case 'plan-mode': {
        if (request.riskLevel === 'read-only') {
          const decision: PermissionDecision = {
            allowed: true,
            reason: 'Plan mode: read-only tools auto-approved',
            requiresUserApproval: false,
          };
          this.logAudit(request, 'approved', mode);
          return decision;
        }
        // Non-read-only tools require approval in plan mode
        const decision: PermissionDecision = {
          allowed: false,
          reason: `Plan mode: ${request.riskLevel} tools require user approval`,
          requiresUserApproval: true,
        };
        this.logAudit(request, 'denied', mode);
        return decision;
      }

      case 'prompt':
      default: {
        if (request.riskLevel === 'read-only') {
          const decision: PermissionDecision = {
            allowed: true,
            reason: 'Prompt mode: read-only tools auto-approved',
            requiresUserApproval: false,
          };
          this.logAudit(request, 'approved', mode);
          return decision;
        }
        // Write, execute, destructive require user approval
        const decision: PermissionDecision = {
          allowed: false,
          reason: `Prompt mode: ${request.riskLevel} tools require user approval`,
          requiresUserApproval: true,
        };
        this.logAudit(request, 'denied', mode);
        return decision;
      }
    }
  }

  // ── Mode management ─────────────────────────────────────────

  setGlobalMode(mode: PermissionMode): void {
    this.globalMode = mode;
  }

  getGlobalMode(): PermissionMode {
    return this.globalMode;
  }

  setAgentMode(agentId: string, mode: PermissionMode): void {
    this.agentModes.set(agentId, mode);
  }

  getAgentMode(agentId: string): PermissionMode | undefined {
    return this.agentModes.get(agentId);
  }

  // ── Allow list management ───────────────────────────────────

  addAllowListEntry(agentId: string, toolId: string): void {
    let agentSet = this.allowList.get(agentId);
    if (!agentSet) {
      agentSet = new Set();
      this.allowList.set(agentId, agentSet);
    }
    agentSet.add(toolId);
  }

  removeAllowListEntry(agentId: string, toolId: string): void {
    const agentSet = this.allowList.get(agentId);
    if (agentSet) {
      agentSet.delete(toolId);
      if (agentSet.size === 0) {
        this.allowList.delete(agentId);
      }
    }
  }

  isAllowListed(agentId: string, toolId: string): boolean {
    return this.allowList.get(agentId)?.has(toolId) ?? false;
  }

  // ── Audit log ───────────────────────────────────────────────

  getAuditLog(filter: AuditFilter): AuditEntry[] {
    let entries = this.auditLog;

    if (filter.agentId) {
      const agentId = filter.agentId;
      entries = entries.filter((e) => e.agentId === agentId);
    }
    if (filter.toolId) {
      const toolId = filter.toolId;
      entries = entries.filter((e) => e.toolId === toolId);
    }
    if (filter.decision) {
      const decision = filter.decision;
      entries = entries.filter((e) => e.decision === decision);
    }
    if (filter.since) {
      const since = filter.since;
      entries = entries.filter((e) => e.timestamp >= since);
    }
    if (filter.until) {
      const until = filter.until;
      entries = entries.filter((e) => e.timestamp <= until);
    }

    return entries;
  }

  // ── Risk level categorization helper ────────────────────────

  static categorizeRisk(riskLevel: string): RiskLevel {
    const valid: RiskLevel[] = ['read-only', 'write', 'execute', 'destructive'];
    if (valid.includes(riskLevel as RiskLevel)) {
      return riskLevel as RiskLevel;
    }
    throw new Error(`Unknown risk level: ${riskLevel}`);
  }

  // ── Private helpers ─────────────────────────────────────────

  private getEffectiveMode(agentId: string): PermissionMode {
    return this.agentModes.get(agentId) ?? this.globalMode;
  }

  private logAudit(
    request: PermissionRequest,
    decision: 'approved' | 'denied',
    mode: PermissionMode,
  ): void {
    this.auditLog.push({
      timestamp: new Date(),
      toolId: request.toolId,
      agentId: request.agentId,
      input: request.input,
      decision,
      mode,
    });
  }
}
