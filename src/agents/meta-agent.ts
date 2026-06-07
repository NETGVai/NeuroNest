/**
 * MetaAgent — Self-improvement loop for SuperAgents.
 *
 * Evaluates agent performance, proposes improvements, applies/reverts them,
 * and maintains version history. Supports user review/approve flow and
 * enable/disable per SuperAgent.
 *
 * Requirements: 4.2, 9.1–9.8
 */

import { randomUUID } from 'node:crypto';
import type { SuperAgent } from './super-agent-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export interface TaskResult {
  taskDescription: string;
  output: string;
  success: boolean;
  tokensUsed: number;
  durationMs: number;
}

export interface PerformanceEvaluation {
  agentId: string;
  taskDescription: string;
  qualityScore: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

export interface ImprovementProposal {
  id: string;
  agentId: string;
  version: number;
  changes: ImprovementChange[];
  expectedBenefit: string;
  status: 'proposed' | 'approved' | 'applied' | 'reverted';
}

export interface ImprovementChange {
  type: 'system_prompt' | 'tool_permissions' | 'model_preference' | 'strategy';
  description: string;
  before: string;
  after: string;
}

export interface ImprovementRecord {
  id: string;
  agentId: string;
  version: number;
  changes: ImprovementChange[];
  performanceBefore: number;
  performanceAfter: number | null;
  applied: boolean;
  createdAt: Date;
}

// ─── MetaAgent ──────────────────────────────────────────────────

export class MetaAgent {
  private improvementHistory: ImprovementRecord[] = [];
  private proposals = new Map<string, ImprovementProposal>();
  private enabledAgents = new Set<string>();
  private agentVersions = new Map<string, number>();
  private agentSnapshots = new Map<string, Map<number, AgentSnapshot>>();

  /**
   * Evaluate a SuperAgent's performance on a completed task.
   * Requirements: 9.2
   */
  evaluate(agent: SuperAgent, taskResult: TaskResult): PerformanceEvaluation {
    // Stub: generate evaluation based on task result
    const qualityScore = taskResult.success ? 0.7 + Math.random() * 0.3 : 0.2 + Math.random() * 0.3;
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const suggestions: string[] = [];

    if (taskResult.success) {
      strengths.push('Task completed successfully');
    } else {
      weaknesses.push('Task failed to complete');
      suggestions.push('Consider adjusting system prompt for better task handling');
    }

    if (taskResult.tokensUsed > 10000) {
      weaknesses.push('High token usage');
      suggestions.push('Optimize prompt for conciseness');
    } else {
      strengths.push('Efficient token usage');
    }

    return {
      agentId: agent.id,
      taskDescription: taskResult.taskDescription,
      qualityScore,
      strengths,
      weaknesses,
      suggestions,
    };
  }

  /**
   * Propose an improvement for a SuperAgent based on evaluation.
   * Requirements: 9.3, 9.4
   */
  proposeImprovement(
    agent: SuperAgent,
    evaluation: PerformanceEvaluation,
  ): ImprovementProposal {
    const currentVersion = this.agentVersions.get(agent.id) ?? 0;
    const nextVersion = currentVersion + 1;

    const changes: ImprovementChange[] = [];

    for (const suggestion of evaluation.suggestions) {
      changes.push({
        type: 'system_prompt',
        description: suggestion,
        before: agent.template.systemPrompt.substring(0, 100),
        after: `${agent.template.systemPrompt} [Improved: ${suggestion}]`.substring(0, 200),
      });
    }

    if (changes.length === 0) {
      changes.push({
        type: 'strategy',
        description: 'Minor optimization based on performance data',
        before: 'current strategy',
        after: 'optimized strategy',
      });
    }

    const proposal: ImprovementProposal = {
      id: randomUUID(),
      agentId: agent.id,
      version: nextVersion,
      changes,
      expectedBenefit: `Improve quality score from ${evaluation.qualityScore.toFixed(2)}`,
      status: 'proposed',
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Apply an approved improvement to a SuperAgent.
   * Requirements: 9.3, 9.4
   */
  applyImprovement(agent: SuperAgent, proposal: ImprovementProposal): void {
    if (proposal.status !== 'proposed' && proposal.status !== 'approved') {
      throw new Error(`Cannot apply proposal with status: ${proposal.status}`);
    }

    // Snapshot current state before applying
    const currentVersion = this.agentVersions.get(agent.id) ?? 0;
    this.saveSnapshot(agent, currentVersion);

    // Apply changes (stub: just update version tracking)
    proposal.status = 'applied';
    this.agentVersions.set(agent.id, proposal.version);
    this.proposals.set(proposal.id, proposal);

    // Record in history
    this.improvementHistory.push({
      id: proposal.id,
      agentId: agent.id,
      version: proposal.version,
      changes: proposal.changes,
      performanceBefore: 0.5,
      performanceAfter: null,
      applied: true,
      createdAt: new Date(),
    });
  }

  /**
   * Revert a SuperAgent to a previous version.
   * Requirements: 9.7
   */
  revertImprovement(agent: SuperAgent, version: number): void {
    const snapshots = this.agentSnapshots.get(agent.id);
    if (!snapshots || !snapshots.has(version)) {
      throw new Error(`No snapshot found for agent ${agent.id} at version ${version}`);
    }

    this.agentVersions.set(agent.id, version);

    // Mark the reverted improvement in history
    const record = this.improvementHistory.find(
      (r) => r.agentId === agent.id && r.version > version && r.applied,
    );
    if (record) {
      record.applied = false;
    }
  }

  /**
   * Get improvement history for an agent.
   * Requirements: 9.5
   */
  getImprovementHistory(agentId: string): ImprovementRecord[] {
    return this.improvementHistory.filter((r) => r.agentId === agentId);
  }

  /**
   * Enable self-improvement loop for a SuperAgent.
   * Requirements: 9.6
   */
  enableForAgent(agentId: string): void {
    this.enabledAgents.add(agentId);
  }

  /**
   * Disable self-improvement loop for a SuperAgent.
   * Requirements: 9.6
   */
  disableForAgent(agentId: string): void {
    this.enabledAgents.delete(agentId);
  }

  /**
   * Check if self-improvement is enabled for an agent.
   */
  isEnabledForAgent(agentId: string): boolean {
    return this.enabledAgents.has(agentId);
  }

  /**
   * Get current version of an agent.
   */
  getAgentVersion(agentId: string): number {
    return this.agentVersions.get(agentId) ?? 0;
  }

  // ── Private helpers ─────────────────────────────────────────

  private saveSnapshot(agent: SuperAgent, version: number): void {
    let snapshots = this.agentSnapshots.get(agent.id);
    if (!snapshots) {
      snapshots = new Map();
      this.agentSnapshots.set(agent.id, snapshots);
    }
    snapshots.set(version, {
      template: { ...agent.template },
      identity: { ...agent.identity },
      model: { ...agent.model },
    });
  }
}

interface AgentSnapshot {
  template: SuperAgent['template'];
  identity: SuperAgent['identity'];
  model: SuperAgent['model'];
}
