/**
 * Permission System — Tool invocation authorization, audit logging.
 *
 * Implements risk level categorization, configurable permission modes,
 * per-agent allow lists, and in-memory audit logging.
 *
 * Requirements: 21.1–21.9
 */

import type {
  PermissionRequest,
  PermissionDecision,
  PermissionMode,
  RiskLevel,
} from '../shared/types.js';

// ─── Additional types ───────────────────────────────────────────

export interface AuditEntry {
  timestamp: Date;
  toolId: string;
  agentId: string;
  input: unknown;
  decision: 'approved' | 'denied';
  mode: PermissionMode;
}

export interface AuditFilter {
  agentId?: string;
  toolId?: string;
  decision?: 'approved' | 'denied';
  since?: Date;
  until?: Date;
}

// ─── PermissionSystem ───────────────────────────────────────────

export class PermissionSystem {
  private globalMode: PermissionMode = 'prompt';
  private agentModes = new Map<string, PermissionMode>();
  private allowList = new Map<string, Set<string>>(); // agentId -> Set<toolId>
  private auditLog: AuditEntry[] = [];

  // ── Permission check ────────────────────────────────────────

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    const mode = this.getEffectiveMode(request.agentId);

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
