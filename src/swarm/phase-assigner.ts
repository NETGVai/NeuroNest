/**
 * PhaseAssigner — Sequence agents into plan→build→integrate→review phases.
 *
 * Uses agent department and specialty from the AgentRegistry to classify
 * agents into execution phases. Phases execute sequentially, but agents
 * within a phase run in parallel.
 *
 * Phase 0: architecture/planning agents
 * Phase 1: code-generation agents (parallel within phase)
 * Phase 2: integration agents
 * Phase 3: review/testing agents
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import type { CapabilityMatch } from './capability-router.js';
import type { DeliverableType } from '../optimizer/deliverable-guard.js';
import type { AgentDefinition } from '../agents/agent-registry.js';

// ─── Types ──────────────────────────────────────────────────────

export type PhaseNumber = 0 | 1 | 2 | 3;

export interface PhaseAssignment {
  phase: PhaseNumber;
  agentId: string;
  role: 'planning' | 'building' | 'integrating' | 'reviewing';
}

export interface PhasedExecutionPlan {
  phases: Map<PhaseNumber, PhaseAssignment[]>;
  totalPhases: number;
}

// ─── Phase Classification Rules ─────────────────────────────────

/**
 * Specialty keywords that indicate Phase 0 (planning/architecture).
 */
const PHASE_0_SPECIALTIES: string[] = [
  'architect',
  'system design',
  'project manag',
  'planning',
  'technical lead',
  'solution design',
];

/**
 * Specialty keywords that indicate Phase 1 (building/code-generation).
 */
const PHASE_1_SPECIALTIES: string[] = [
  'frontend develop',
  'backend develop',
  'ai engineer',
  'rapid prototyp',
  'senior develop',
  'full-stack',
  'fullstack',
  'developer',
  'programmer',
  'software engineer',
  'code generat',
  'scaffold',
  'implement',
];

/**
 * Specialty keywords that indicate Phase 2 (integration/infrastructure).
 */
const PHASE_2_SPECIALTIES: string[] = [
  'integration engineer',
  'devops',
  'infrastructure',
  'deploy',
  'ci/cd',
  'ci/cd pipeline',
  'cloud engineer',
  'platform engineer',
];

/**
 * Specialty keywords that indicate Phase 3 (review/testing).
 */
const PHASE_3_SPECIALTIES: string[] = [
  'code review',
  'tester',
  'testing',
  'security engineer',
  'qa',
  'quality assurance',
  'audit',
  'vulnerability',
  'penetration',
  'security analys',
];

/**
 * Department-to-phase mapping as a fallback when specialty keywords don't match.
 */
const DEPARTMENT_PHASE_MAP: Record<string, PhaseNumber> = {
  'Project Management': 0,
  'Engineering': 1,
  'Software Delivery': 1,
  'Infrastructure': 2,
  'Testing': 3,
};

// ─── Role Mapping ───────────────────────────────────────────────

const PHASE_ROLE_MAP: Record<PhaseNumber, PhaseAssignment['role']> = {
  0: 'planning',
  1: 'building',
  2: 'integrating',
  3: 'reviewing',
};

// ─── PhaseAssigner ──────────────────────────────────────────────

export class PhaseAssigner {
  private agentLookup: Map<string, AgentDefinition>;

  /**
   * Create a PhaseAssigner with access to agent definitions for department/specialty lookup.
   *
   * @param registry - Array of AgentDefinition objects from the AgentRegistry
   */
  constructor(registry: AgentDefinition[]) {
    this.agentLookup = new Map();
    for (const agent of registry) {
      this.agentLookup.set(agent.id, agent);
    }
  }

  /**
   * Assign agents to phases based on specialty and deliverable type.
   *
   * Phase 0: architecture/planning agents
   * Phase 1: code-generation agents (parallel within phase)
   * Phase 2: integration agents
   * Phase 3: review/testing agents
   *
   * @param agents - Filtered agents from CapabilityRouter
   * @param _deliverableType - The deliverable type for context (reserved for future use)
   * @returns A PhasedExecutionPlan with agents grouped by phase
   */
  assign(
    agents: CapabilityMatch[],
    _deliverableType: DeliverableType,
  ): PhasedExecutionPlan {
    // Edge case: empty agent list → return empty plan with 0 phases
    if (!agents || agents.length === 0) {
      return {
        phases: new Map(),
        totalPhases: 0,
      };
    }

    const phases = new Map<PhaseNumber, PhaseAssignment[]>();

    for (const match of agents) {
      const agentDef = this.agentLookup.get(match.agentId);

      let phase: PhaseNumber;
      if (agentDef) {
        phase = this.classifyPhase(agentDef);
      } else {
        // Agent not found in registry — default to Phase 1 (building)
        phase = 1;
        console.warn(
          `[PhaseAssigner] Agent "${match.agentId}" not found in registry. Defaulting to Phase 1 (building).`,
        );
      }

      const assignment: PhaseAssignment = {
        phase,
        agentId: match.agentId,
        role: PHASE_ROLE_MAP[phase],
      };

      const existing = phases.get(phase);
      if (existing) {
        existing.push(assignment);
      } else {
        phases.set(phase, [assignment]);
      }
    }

    // totalPhases is the count of distinct phases that have at least one agent
    const totalPhases = phases.size;

    return { phases, totalPhases };
  }

  /**
   * Determine the phase for an agent based on department and specialty.
   *
   * Classification priority:
   * 1. Specialty keyword match (most specific)
   * 2. Department-level fallback
   * 3. Default to Phase 1 (building) for unclassified agents
   *
   * Constraint: Review/testing agents (Phase 3) are never placed with
   * code-generation agents (Phase 1).
   */
  private classifyPhase(agent: AgentDefinition): PhaseNumber {
    const specialty = agent.specialty.toLowerCase();
    const department = agent.department;

    // Check Phase 3 first — review/testing agents must be separated from code-gen
    if (this.matchesSpecialty(specialty, PHASE_3_SPECIALTIES)) {
      return 3;
    }

    // Check Phase 0 — architecture/planning
    if (this.matchesSpecialty(specialty, PHASE_0_SPECIALTIES)) {
      return 0;
    }

    // Check Phase 2 — integration/infrastructure
    if (this.matchesSpecialty(specialty, PHASE_2_SPECIALTIES)) {
      return 2;
    }

    // Check Phase 1 — code-generation/building
    if (this.matchesSpecialty(specialty, PHASE_1_SPECIALTIES)) {
      return 1;
    }

    // Fallback: check department-level mapping
    if (department in DEPARTMENT_PHASE_MAP) {
      return DEPARTMENT_PHASE_MAP[department];
    }

    // Default: unclassified agents go to Phase 1 (building)
    console.warn(
      `[PhaseAssigner] Agent "${agent.id}" (specialty: "${agent.specialty}", department: "${department}") ` +
      `doesn't match any phase rule. Defaulting to Phase 1 (building).`,
    );
    return 1;
  }

  /**
   * Check if a specialty string matches any of the given keyword patterns.
   */
  private matchesSpecialty(specialty: string, keywords: string[]): boolean {
    return keywords.some((keyword) => specialty.includes(keyword));
  }
}
