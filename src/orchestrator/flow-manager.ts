/**
 * FlowManager — Scheduled flow management and cross-provider orchestration.
 *
 * Stub implementation with in-memory state. Manages flow creation,
 * cron scheduling, cross-provider orchestration, and tool restrictions
 * for role-based access control.
 *
 * Requirements: 6.11–6.14
 */

import { randomUUID } from 'node:crypto';
import type { FlowConfig } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface Flow {
  id: string;
  config: FlowConfig;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  createdAt: Date;
}

export interface FlowRun {
  id: string;
  flowId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface ProviderAssignment {
  agentId: string;
  providerId: string;
  model: string;
}

export interface ToolRestriction {
  agentId: string;
  allowedTools: string[];
}

// ─── FlowManager ────────────────────────────────────────────────

export class FlowManager {
  private flows = new Map<string, Flow>();
  private flowRuns: FlowRun[] = [];
  private providerAssignments = new Map<string, ProviderAssignment>();
  private toolRestrictions = new Map<string, ToolRestriction>();

  /**
   * Create a new scheduled flow.
   * Requirements: 6.11
   */
  createFlow(config: FlowConfig): Flow {
    if (!config.name || config.name.length === 0) {
      throw new Error('Flow name is required');
    }
    if (!config.schedule || config.schedule.length === 0) {
      throw new Error('Flow schedule is required');
    }
    if (!this.isValidCron(config.schedule)) {
      throw new Error(`Invalid cron expression: ${config.schedule}`);
    }

    const id = randomUUID();
    const flow: Flow = {
      id,
      config,
      runCount: 0,
      createdAt: new Date(),
      nextRun: config.enabled ? this.computeNextRun(config.schedule) : undefined,
    };

    this.flows.set(id, flow);
    return flow;
  }

  /**
   * List all flows.
   */
  listFlows(): Flow[] {
    return Array.from(this.flows.values());
  }

  /**
   * Get a flow by ID.
   */
  getFlow(flowId: string): Flow | null {
    return this.flows.get(flowId) ?? null;
  }

  /**
   * Delete a flow.
   */
  deleteFlow(flowId: string): void {
    if (!this.flows.has(flowId)) {
      throw new Error(`Flow not found: ${flowId}`);
    }
    this.flows.delete(flowId);
  }

  /**
   * Enable a flow.
   */
  enableFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    flow.config.enabled = true;
    flow.nextRun = this.computeNextRun(flow.config.schedule);
  }

  /**
   * Disable a flow.
   */
  disableFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    flow.config.enabled = false;
    flow.nextRun = undefined;
  }

  /**
   * Trigger a flow run (stub).
   */
  async triggerFlow(flowId: string): Promise<FlowRun> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    if (!flow.config.enabled) throw new Error(`Flow is disabled: ${flowId}`);

    const run: FlowRun = {
      id: randomUUID(),
      flowId,
      status: 'running',
      startedAt: new Date(),
    };

    this.flowRuns.push(run);

    // Stub: mark as completed
    run.status = 'completed';
    run.completedAt = new Date();
    flow.lastRun = run.completedAt;
    flow.runCount++;
    flow.nextRun = this.computeNextRun(flow.config.schedule);

    return run;
  }

  /**
   * Get run history for a flow.
   */
  getFlowRuns(flowId: string): FlowRun[] {
    return this.flowRuns.filter((r) => r.flowId === flowId);
  }

  /**
   * Assign a specific provider to an agent for cross-provider orchestration.
   * Requirements: 6.12
   */
  setProviderAssignment(assignment: ProviderAssignment): void {
    this.providerAssignments.set(assignment.agentId, assignment);
  }

  /**
   * Get provider assignment for an agent.
   */
  getProviderAssignment(agentId: string): ProviderAssignment | null {
    return this.providerAssignments.get(agentId) ?? null;
  }

  /**
   * List all provider assignments.
   */
  listProviderAssignments(): ProviderAssignment[] {
    return Array.from(this.providerAssignments.values());
  }

  /**
   * Set tool restrictions for an agent (role-based access control).
   * Requirements: 6.13
   */
  setToolRestriction(restriction: ToolRestriction): void {
    this.toolRestrictions.set(restriction.agentId, restriction);
  }

  /**
   * Get tool restrictions for an agent.
   */
  getToolRestriction(agentId: string): ToolRestriction | null {
    return this.toolRestrictions.get(agentId) ?? null;
  }

  /**
   * Check if an agent is allowed to use a specific tool.
   * Requirements: 6.13
   */
  isToolAllowed(agentId: string, toolId: string): boolean {
    const restriction = this.toolRestrictions.get(agentId);
    if (!restriction) return true; // No restrictions = all tools allowed
    return restriction.allowedTools.includes(toolId) || restriction.allowedTools.includes('*');
  }

  /**
   * Remove tool restrictions for an agent.
   */
  removeToolRestriction(agentId: string): void {
    this.toolRestrictions.delete(agentId);
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Basic cron expression validation (stub).
   * Accepts standard 5-field cron expressions.
   */
  private isValidCron(expression: string): boolean {
    const parts = expression.trim().split(/\s+/);
    return parts.length === 5;
  }

  /**
   * Compute next run time from cron expression (stub).
   */
  private computeNextRun(_schedule: string): Date {
    // Stub: return 1 hour from now
    return new Date(Date.now() + 60 * 60 * 1000);
  }
}
