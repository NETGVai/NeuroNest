/**
 * ToolIntegration — Wire Tool_System to Compounding_Memory and Self_Improvement_Loop.
 *
 * Connects Tool_System to Compounding_Memory for persisting tool usage patterns,
 * and connects Tool_System to Self_Improvement_Loop for Meta_Agent optimization.
 *
 * Requirements: 15.13, 15.14
 */

import { randomUUID } from 'node:crypto';
import { ToolSystem } from '../tools/tool-system.js';
import { CompoundingMemory, type MemoryEntry } from '../agents/compounding-memory.js';
import { MetaAgent, type ImprovementProposal } from '../agents/meta-agent.js';
import type { ToolResult, ToolContext } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ToolUsageRecord {
  toolId: string;
  agentId: string;
  sessionId: string;
  success: boolean;
  timestamp: Date;
}

// ─── ToolIntegration ────────────────────────────────────────────

export class ToolIntegration {
  private toolSystem: ToolSystem;
  private memory: CompoundingMemory;
  private metaAgent: MetaAgent;
  private usageLog: ToolUsageRecord[] = [];

  constructor(
    toolSystem: ToolSystem,
    memory: CompoundingMemory,
    metaAgent: MetaAgent,
  ) {
    this.toolSystem = toolSystem;
    this.memory = memory;
    this.metaAgent = metaAgent;
  }

  /**
   * Execute a tool and persist usage patterns to Compounding_Memory.
   * Requirements: 15.13
   */
  async executeAndPersist(
    toolId: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const result = await this.toolSystem.execute(toolId, input, context);

    // Record usage
    const record: ToolUsageRecord = {
      toolId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      success: result.success,
      timestamp: new Date(),
    };
    this.usageLog.push(record);

    // Persist to Compounding_Memory
    const memoryEntry: MemoryEntry = {
      id: randomUUID(),
      agentId: context.agentId,
      type: result.success ? 'strategy' : 'error',
      content: `Tool ${toolId}: ${result.success ? 'success' : `failed - ${result.error}`}`,
      context: `Session ${context.sessionId}, input: ${JSON.stringify(input).slice(0, 200)}`,
      relevanceScore: result.success ? 0.7 : 0.9, // Errors are more relevant for learning
      createdAt: new Date(),
    };
    await this.memory.store(context.agentId, memoryEntry);

    return result;
  }

  /**
   * Feed tool usage data to Self_Improvement_Loop for Meta_Agent optimization.
   * Requirements: 15.14
   */
  async feedToSelfImprovement(agentId: string): Promise<void> {
    const agentUsage = this.usageLog.filter((r) => r.agentId === agentId);
    if (agentUsage.length === 0) return;

    const successRate = agentUsage.filter((r) => r.success).length / agentUsage.length;
    const toolFrequency = new Map<string, number>();
    for (const record of agentUsage) {
      toolFrequency.set(record.toolId, (toolFrequency.get(record.toolId) ?? 0) + 1);
    }

    // Store tool strategy insights
    const insight: MemoryEntry = {
      id: randomUUID(),
      agentId,
      type: 'insight',
      content: `Tool usage analysis: ${successRate * 100}% success rate across ${agentUsage.length} invocations. Most used: ${[...toolFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ')}`,
      context: 'Self-improvement tool strategy analysis',
      relevanceScore: 0.8,
      createdAt: new Date(),
    };
    await this.memory.store(agentId, insight);
  }

  /**
   * Get tool usage log for an agent.
   */
  getUsageLog(agentId?: string): ToolUsageRecord[] {
    if (agentId) {
      return this.usageLog.filter((r) => r.agentId === agentId);
    }
    return [...this.usageLog];
  }
}
