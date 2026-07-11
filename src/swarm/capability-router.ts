/**
 * CapabilityRouter — Filter and rank agents by capability match for a deliverable type.
 *
 * Reads AgentDefinition.specialty and .department from the registry (never modifies it)
 * and applies capability mapping rules to select relevant agents for a given request.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import type { DeliverableType } from '../optimizer/deliverable-guard.js';
import type { AgentDefinition } from '../agents/agent-registry.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CapabilityMatch {
  agentId: string;
  relevanceScore: number; // 0-1, higher = more relevant
  matchedCapabilities: string[];
}

export interface RoutingConstraints {
  deliverableType: DeliverableType;
  complexity: 'simple' | 'multi-service';
  maxAgents: number; // 2-4 for simple, up to 8 for multi-service
}

// ─── Error Classes ──────────────────────────────────────────────

export class RegistryUnavailableError extends Error {
  constructor(message = 'Agent registry is unavailable or empty') {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

export class NoCapableAgentsError extends Error {
  public readonly deliverableType: DeliverableType;

  constructor(deliverableType: DeliverableType) {
    super(`No capable agents found for deliverable type: ${deliverableType}`);
    this.name = 'NoCapableAgentsError';
    this.deliverableType = deliverableType;
  }
}

// ─── Capability Mapping Rules ───────────────────────────────────

/**
 * Departments that are included for each deliverable type.
 */
const DEPARTMENT_INCLUSIONS: Record<DeliverableType, string[]> = {
  code: ['Engineering', 'Infrastructure', 'Software Delivery'],
  research: ['Research', 'Specialized'],
  analysis: ['Research', 'Testing', 'Optimization'],
  documentation: ['Product', 'Support', 'Marketing'],
};

/**
 * Departments explicitly excluded for each deliverable type.
 * Agents in these departments will never match for the given type.
 */
const DEPARTMENT_EXCLUSIONS: Record<DeliverableType, string[]> = {
  code: ['Research', 'Design', 'Marketing'],
  research: [],
  analysis: [],
  documentation: [],
};

/**
 * Specialty keywords that strongly indicate relevance for a deliverable type.
 */
const SPECIALTY_KEYWORDS: Record<DeliverableType, string[]> = {
  code: [
    'develop', 'engineer', 'code', 'programming', 'software',
    'build', 'implement', 'architect', 'frontend', 'backend',
    'full-stack', 'fullstack', 'api', 'deploy', 'devops',
    'infrastructure', 'database', 'microservice', 'prototype',
    'scaffold', 'refactor', 'debug',
  ],
  research: [
    'research', 'hypothesis', 'experiment', 'investigate',
    'literature', 'discovery', 'exploration', 'study',
    'methodology', 'academic',
  ],
  analysis: [
    'analyze', 'analysis', 'evaluate', 'assessment',
    'benchmark', 'metrics', 'performance', 'audit',
    'testing', 'quality', 'optimization', 'profiling',
    'review', 'inspect',
  ],
  documentation: [
    'document', 'documentation', 'writing', 'content',
    'guide', 'tutorial', 'manual', 'readme',
    'communication', 'support', 'explain', 'onboarding',
  ],
};

/**
 * Specialty keywords that indicate an agent should be excluded from a deliverable type.
 * This catches agents in included departments whose actual specialty doesn't match.
 */
const SPECIALTY_EXCLUSIONS: Record<DeliverableType, string[]> = {
  code: [
    'hypothesis', 'ux research', 'user research', 'prompt enhancement',
    'prompt optimization', 'market research', 'brand',
  ],
  research: [],
  analysis: [],
  documentation: [],
};

// ─── CapabilityRouter ───────────────────────────────────────────

export class CapabilityRouter {
  constructor(private registry: AgentDefinition[]) {
    if (!registry || registry.length === 0) {
      throw new RegistryUnavailableError();
    }
  }

  /**
   * Filter and rank agents by capability match for the given deliverable type.
   * Reads AgentDefinition.specialty and .department — never modifies registry.
   *
   * @throws NoCapableAgentsError if no agents match the deliverable type
   */
  route(constraints: RoutingConstraints): CapabilityMatch[] {
    const { deliverableType, maxAgents } = constraints;

    // Filter agents that match the deliverable type
    const matches: CapabilityMatch[] = [];

    for (const agent of this.registry) {
      if (this.matchesDeliverable(agent, deliverableType)) {
        const { score, capabilities } = this.scoreAgent(agent, deliverableType);
        matches.push({
          agentId: agent.id,
          relevanceScore: score,
          matchedCapabilities: capabilities,
        });
      }
    }

    // Edge case: no matching agents
    if (matches.length === 0) {
      throw new NoCapableAgentsError(deliverableType);
    }

    // Edge case: fewer than 2 agents available — return all, log warning
    if (matches.length < 2) {
      console.warn(
        `[CapabilityRouter] Only ${matches.length} agent(s) available for deliverable type "${deliverableType}". ` +
        `Minimum recommended is 2.`
      );
      return this.rankByRelevance(matches, constraints);
    }

    // Rank by relevance and cap at maxAgents
    const ranked = this.rankByRelevance(matches, constraints);
    return ranked.slice(0, maxAgents);
  }

  /**
   * Determine if an agent's specialty and department match a deliverable type.
   * Uses department inclusion/exclusion lists and keyword matching against specialty text.
   */
  private matchesDeliverable(agent: AgentDefinition, type: DeliverableType): boolean {
    const department = agent.department;
    const specialty = agent.specialty.toLowerCase();

    // Check department exclusions first — if excluded, agent cannot match
    const exclusions = DEPARTMENT_EXCLUSIONS[type];
    if (exclusions.some((excluded) => department === excluded)) {
      return false;
    }

    // Check for specialty-based exclusions (catches mismatched agents in included departments)
    const specialtyExclusions = SPECIALTY_EXCLUSIONS[type];
    if (specialtyExclusions.some((keyword) => specialty.includes(keyword))) {
      return false;
    }

    // Check department inclusions — if department matches, agent is eligible
    const inclusions = DEPARTMENT_INCLUSIONS[type];
    if (inclusions.some((included) => department === included)) {
      return true;
    }

    // If department doesn't match inclusion list, check specialty keywords as fallback
    const keywords = SPECIALTY_KEYWORDS[type];
    return keywords.some((keyword) => specialty.includes(keyword));
  }

  /**
   * Score an agent's relevance for a deliverable type.
   * Returns a score (0-1) and a list of matched capabilities.
   */
  private scoreAgent(
    agent: AgentDefinition,
    type: DeliverableType,
  ): { score: number; capabilities: string[] } {
    const specialty = agent.specialty.toLowerCase();
    const department = agent.department;
    const capabilities: string[] = [];
    let score = 0;

    // Department match gives base score
    const inclusions = DEPARTMENT_INCLUSIONS[type];
    if (inclusions.some((included) => department === included)) {
      score += 0.4;
      capabilities.push(`department:${department}`);
    }

    // Specialty keyword matches add to score
    const keywords = SPECIALTY_KEYWORDS[type];
    let keywordMatches = 0;
    for (const keyword of keywords) {
      if (specialty.includes(keyword)) {
        keywordMatches++;
        capabilities.push(`specialty:${keyword}`);
      }
    }

    // Score based on how many keywords match (diminishing returns)
    if (keywordMatches > 0) {
      score += Math.min(0.6, keywordMatches * 0.15);
    }

    // Normalize to 0-1 range
    return {
      score: Math.min(1, Math.round(score * 100) / 100),
      capabilities,
    };
  }

  /**
   * Rank matched agents by relevance to the specific task.
   * Higher relevanceScore = more relevant = ranked first.
   */
  private rankByRelevance(
    matches: CapabilityMatch[],
    _constraints: RoutingConstraints,
  ): CapabilityMatch[] {
    return [...matches].sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}
