/**
 * AgentRouter — Explainable agent routing with non-overridable capability blocks.
 *
 * Responsibilities:
 * 1. Support explicit agent choice (user-selected) or Auto Route (system-selected).
 * 2. For Auto Route: evaluate available agents across skills, task type, availability,
 *    model access, permissions, quality score, and execution history.
 * 3. Generate a human-readable explanation of why each agent was selected or rejected.
 * 4. Block dispatch (non-overridable) when ANY required capability is missing:
 *    skill, permission, provider, runtime, or tool.
 * 5. Offer only "explicit safe substitution" as a remedy — the user must pick an
 *    alternative that covers the gap.
 * 6. Bind routing to validated fingerprints (task, catalog, bundle, provider, repository).
 * 7. Return a RouteDecision with selected agent, explanation, deficiency list, and
 *    fingerprint binding.
 *
 * Requirements: 13.2, 13.8
 */

import { createHash } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Categories of capabilities evaluated during routing.
 */
export type CapabilityCategory =
  | 'skill'
  | 'permission'
  | 'provider'
  | 'runtime'
  | 'tool';

/**
 * Routing mode — explicit agent choice or system auto-route.
 */
export type RoutingMode = 'explicit' | 'auto';

/**
 * A single deficiency blocking dispatch.
 */
export interface RoutingDeficiency {
  /** Category of the missing capability */
  readonly category: CapabilityCategory;
  /** Human-readable name of what is missing */
  readonly requirement: string;
  /** Suggested substitution(s) if any are available */
  readonly suggestedSubstitutions: readonly string[];
}

/**
 * Explanation of why an agent was selected or rejected.
 */
export interface AgentEvaluation {
  /** Agent identifier */
  readonly agentId: string;
  /** Whether this agent was selected */
  readonly selected: boolean;
  /** Individual scores per routing factor */
  readonly scores: RoutingScores;
  /** Human-readable explanation of the routing decision */
  readonly explanation: string;
  /** Deficiencies that block this agent (empty if eligible) */
  readonly deficiencies: readonly RoutingDeficiency[];
}

/**
 * Scores across routing factors (0–100 scale per factor).
 */
export interface RoutingScores {
  readonly skills: number;
  readonly taskType: number;
  readonly availability: number;
  readonly modelAccess: number;
  readonly permissions: number;
  readonly quality: number;
  readonly history: number;
}

/**
 * Fingerprints binding a routing decision to validated state.
 */
export interface RoutingFingerprints {
  readonly taskFingerprint: string;
  readonly catalogFingerprint: string;
  readonly bundleFingerprint: string;
  readonly providerFingerprint: string;
  readonly repositoryFingerprint: string;
}

/**
 * The final routing decision.
 */
export interface RouteDecision {
  /** Whether routing was blocked due to deficiencies */
  readonly blocked: boolean;
  /** The selected agent (null if blocked) */
  readonly selectedAgentId: string | null;
  /** Routing mode used */
  readonly mode: RoutingMode;
  /** Human-readable summary of the routing decision */
  readonly explanation: string;
  /** Detailed evaluations for all considered agents */
  readonly evaluations: readonly AgentEvaluation[];
  /** Combined deficiency list (only from selected or best-candidate agent) */
  readonly deficiencies: readonly RoutingDeficiency[];
  /** Fingerprints binding this decision to validated state */
  readonly fingerprints: RoutingFingerprints;
  /** Timestamp of the routing decision */
  readonly decidedAt: string;
}

/**
 * Task requirements for routing.
 */
export interface TaskRoutingRequirements {
  /** Task identifier */
  readonly taskId: string;
  /** Required skills for the task */
  readonly requiredSkills: readonly string[];
  /** Required permissions */
  readonly requiredPermissions: readonly string[];
  /** Required providers (model access) */
  readonly requiredProviders: readonly string[];
  /** Required runtime capabilities */
  readonly requiredRuntime: readonly string[];
  /** Required tools */
  readonly requiredTools: readonly string[];
  /** Task type classification */
  readonly taskType: string;
  /** Fingerprints for binding */
  readonly fingerprints: RoutingFingerprints;
}

/**
 * Agent descriptor used for routing evaluation.
 */
export interface AgentDescriptor {
  /** Unique agent identifier */
  readonly id: string;
  /** Skills this agent possesses */
  readonly skills: readonly string[];
  /** Permissions granted to this agent */
  readonly permissions: readonly string[];
  /** Providers this agent can access */
  readonly providers: readonly string[];
  /** Runtime capabilities available */
  readonly runtimeCapabilities: readonly string[];
  /** Tools available to this agent */
  readonly tools: readonly string[];
  /** Task types this agent handles */
  readonly taskTypes: readonly string[];
  /** Whether the agent is currently available */
  readonly available: boolean;
  /** Quality score (0–100) */
  readonly qualityScore: number;
  /** Historical success rate (0–1) */
  readonly successRate: number;
  /** Number of completed tasks */
  readonly completedTasks: number;
}

/**
 * Routing request combining task requirements and routing mode.
 */
export interface RoutingRequest {
  /** Task routing requirements */
  readonly requirements: TaskRoutingRequirements;
  /** Routing mode */
  readonly mode: RoutingMode;
  /** Explicitly selected agent ID (required when mode is 'explicit') */
  readonly explicitAgentId?: string;
  /** Available agents to consider */
  readonly availableAgents: readonly AgentDescriptor[];
}

// ─── AgentRouter ────────────────────────────────────────────────────────────

/**
 * AgentRouter — Performs explainable agent routing with non-overridable
 * capability blocks.
 */
export class AgentRouter {
  /**
   * Route a task to an agent based on the routing request.
   *
   * For explicit mode: validates the user-selected agent's capabilities.
   * For auto mode: evaluates all available agents and selects the best fit.
   *
   * Dispatch is BLOCKED (non-overridable) when any required capability is missing.
   * The only remedy is explicit safe substitution — the user picks an alternative.
   */
  route(request: RoutingRequest): RouteDecision {
    const { requirements, mode, explicitAgentId, availableAgents } = request;

    if (mode === 'explicit') {
      return this.routeExplicit(requirements, explicitAgentId, availableAgents);
    }

    return this.routeAuto(requirements, availableAgents);
  }

  // ─── Private: Explicit Routing ──────────────────────────────────────────

  private routeExplicit(
    requirements: TaskRoutingRequirements,
    explicitAgentId: string | undefined,
    availableAgents: readonly AgentDescriptor[],
  ): RouteDecision {
    if (!explicitAgentId) {
      return this.createBlockedDecision(
        'explicit',
        [],
        [{ category: 'skill', requirement: 'No agent specified for explicit routing', suggestedSubstitutions: availableAgents.map((a) => a.id) }],
        requirements.fingerprints,
      );
    }

    const agent = availableAgents.find((a) => a.id === explicitAgentId);
    if (!agent) {
      return this.createBlockedDecision(
        'explicit',
        [],
        [{ category: 'skill', requirement: `Agent '${explicitAgentId}' not found in available agents`, suggestedSubstitutions: availableAgents.map((a) => a.id) }],
        requirements.fingerprints,
      );
    }

    const evaluation = this.evaluateAgent(agent, requirements);

    if (evaluation.deficiencies.length > 0) {
      return this.createBlockedDecision(
        'explicit',
        [evaluation],
        evaluation.deficiencies,
        requirements.fingerprints,
      );
    }

    return {
      blocked: false,
      selectedAgentId: agent.id,
      mode: 'explicit',
      explanation: `User selected agent '${agent.id}'. ${evaluation.explanation}`,
      evaluations: [evaluation],
      deficiencies: [],
      fingerprints: requirements.fingerprints,
      decidedAt: new Date().toISOString(),
    };
  }

  // ─── Private: Auto Routing ──────────────────────────────────────────────

  private routeAuto(
    requirements: TaskRoutingRequirements,
    availableAgents: readonly AgentDescriptor[],
  ): RouteDecision {
    if (availableAgents.length === 0) {
      return this.createBlockedDecision(
        'auto',
        [],
        [{ category: 'skill', requirement: 'No agents available for routing', suggestedSubstitutions: [] }],
        requirements.fingerprints,
      );
    }

    const evaluations = availableAgents.map((agent) =>
      this.evaluateAgent(agent, requirements),
    );

    // Find eligible agents (no deficiencies)
    const eligible = evaluations.filter((e) => e.deficiencies.length === 0);

    if (eligible.length === 0) {
      // All agents have deficiencies — select the one with fewest for substitution suggestions
      const bestCandidate = this.selectBestCandidate(evaluations);
      return this.createBlockedDecision(
        'auto',
        evaluations,
        bestCandidate.deficiencies,
        requirements.fingerprints,
      );
    }

    // Select best eligible agent by composite score
    const selected = this.selectBestEligible(eligible);
    const selectedEvaluation = evaluations.find((e) => e.agentId === selected.agentId)!;

    // Mark selected in evaluations
    const finalEvaluations = evaluations.map((e) => ({
      ...e,
      selected: e.agentId === selected.agentId,
    }));

    return {
      blocked: false,
      selectedAgentId: selected.agentId,
      mode: 'auto',
      explanation: this.buildAutoRouteExplanation(selected, requirements),
      evaluations: finalEvaluations,
      deficiencies: [],
      fingerprints: requirements.fingerprints,
      decidedAt: new Date().toISOString(),
    };
  }

  // ─── Private: Evaluation ────────────────────────────────────────────────

  /**
   * Evaluate an agent against task requirements, producing scores and deficiencies.
   */
  private evaluateAgent(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): AgentEvaluation {
    const deficiencies: RoutingDeficiency[] = [];

    // Check skills
    const missingSkills = requirements.requiredSkills.filter(
      (skill) => !agent.skills.includes(skill),
    );
    for (const skill of missingSkills) {
      deficiencies.push({
        category: 'skill',
        requirement: `Missing skill: ${skill}`,
        suggestedSubstitutions: [],
      });
    }

    // Check permissions
    const missingPermissions = requirements.requiredPermissions.filter(
      (perm) => !agent.permissions.includes(perm),
    );
    for (const perm of missingPermissions) {
      deficiencies.push({
        category: 'permission',
        requirement: `Missing permission: ${perm}`,
        suggestedSubstitutions: [],
      });
    }

    // Check providers
    const missingProviders = requirements.requiredProviders.filter(
      (provider) => !agent.providers.includes(provider),
    );
    for (const provider of missingProviders) {
      deficiencies.push({
        category: 'provider',
        requirement: `Missing provider: ${provider}`,
        suggestedSubstitutions: [],
      });
    }

    // Check runtime
    const missingRuntime = requirements.requiredRuntime.filter(
      (rt) => !agent.runtimeCapabilities.includes(rt),
    );
    for (const rt of missingRuntime) {
      deficiencies.push({
        category: 'runtime',
        requirement: `Missing runtime: ${rt}`,
        suggestedSubstitutions: [],
      });
    }

    // Check tools
    const missingTools = requirements.requiredTools.filter(
      (tool) => !agent.tools.includes(tool),
    );
    for (const tool of missingTools) {
      deficiencies.push({
        category: 'tool',
        requirement: `Missing tool: ${tool}`,
        suggestedSubstitutions: [],
      });
    }

    // Compute scores
    const scores = this.computeScores(agent, requirements);

    // Build explanation
    const explanation = this.buildAgentExplanation(agent, requirements, scores, deficiencies);

    return {
      agentId: agent.id,
      selected: false,
      scores,
      explanation,
      deficiencies,
    };
  }

  /**
   * Compute routing scores for an agent across all factors.
   */
  private computeScores(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): RoutingScores {
    return {
      skills: this.computeSkillScore(agent, requirements),
      taskType: this.computeTaskTypeScore(agent, requirements),
      availability: agent.available ? 100 : 0,
      modelAccess: this.computeModelAccessScore(agent, requirements),
      permissions: this.computePermissionScore(agent, requirements),
      quality: agent.qualityScore,
      history: this.computeHistoryScore(agent),
    };
  }

  private computeSkillScore(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): number {
    if (requirements.requiredSkills.length === 0) return 100;
    const matched = requirements.requiredSkills.filter((s) =>
      agent.skills.includes(s),
    ).length;
    return Math.round((matched / requirements.requiredSkills.length) * 100);
  }

  private computeTaskTypeScore(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): number {
    return agent.taskTypes.includes(requirements.taskType) ? 100 : 0;
  }

  private computeModelAccessScore(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): number {
    if (requirements.requiredProviders.length === 0) return 100;
    const matched = requirements.requiredProviders.filter((p) =>
      agent.providers.includes(p),
    ).length;
    return Math.round((matched / requirements.requiredProviders.length) * 100);
  }

  private computePermissionScore(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
  ): number {
    if (requirements.requiredPermissions.length === 0) return 100;
    const matched = requirements.requiredPermissions.filter((p) =>
      agent.permissions.includes(p),
    ).length;
    return Math.round((matched / requirements.requiredPermissions.length) * 100);
  }

  private computeHistoryScore(agent: AgentDescriptor): number {
    if (agent.completedTasks === 0) return 50; // neutral for new agents
    return Math.round(agent.successRate * 100);
  }

  // ─── Private: Selection ─────────────────────────────────────────────────

  /**
   * Select the best eligible agent by composite score.
   */
  private selectBestEligible(eligible: readonly AgentEvaluation[]): AgentEvaluation {
    let best = eligible[0];
    let bestComposite = this.computeCompositeScore(best.scores);

    for (let i = 1; i < eligible.length; i++) {
      const composite = this.computeCompositeScore(eligible[i].scores);
      if (composite > bestComposite) {
        best = eligible[i];
        bestComposite = composite;
      }
    }

    return best;
  }

  /**
   * Select the best candidate from all agents (even blocked) for substitution suggestions.
   */
  private selectBestCandidate(evaluations: readonly AgentEvaluation[]): AgentEvaluation {
    let best = evaluations[0];
    let fewestDeficiencies = best.deficiencies.length;

    for (let i = 1; i < evaluations.length; i++) {
      if (evaluations[i].deficiencies.length < fewestDeficiencies) {
        best = evaluations[i];
        fewestDeficiencies = evaluations[i].deficiencies.length;
      }
    }

    return best;
  }

  /**
   * Compute a weighted composite score.
   *
   * Weights reflect routing priority:
   * - skills: 25% (core requirement)
   * - taskType: 15%
   * - availability: 15%
   * - modelAccess: 15%
   * - permissions: 10%
   * - quality: 10%
   * - history: 10%
   */
  private computeCompositeScore(scores: RoutingScores): number {
    return (
      scores.skills * 0.25 +
      scores.taskType * 0.15 +
      scores.availability * 0.15 +
      scores.modelAccess * 0.15 +
      scores.permissions * 0.10 +
      scores.quality * 0.10 +
      scores.history * 0.10
    );
  }

  // ─── Private: Explanations ──────────────────────────────────────────────

  private buildAgentExplanation(
    agent: AgentDescriptor,
    requirements: TaskRoutingRequirements,
    scores: RoutingScores,
    deficiencies: readonly RoutingDeficiency[],
  ): string {
    const parts: string[] = [];

    if (deficiencies.length > 0) {
      parts.push(
        `Agent '${agent.id}' is BLOCKED: ${deficiencies.length} missing capability(ies).`,
      );
      for (const d of deficiencies) {
        parts.push(`  - [${d.category}] ${d.requirement}`);
      }
    } else {
      parts.push(
        `Agent '${agent.id}' is eligible.`,
      );
    }

    parts.push(
      `Scores — skills: ${scores.skills}, taskType: ${scores.taskType}, availability: ${scores.availability}, modelAccess: ${scores.modelAccess}, permissions: ${scores.permissions}, quality: ${scores.quality}, history: ${scores.history}.`,
    );

    return parts.join(' ');
  }

  private buildAutoRouteExplanation(
    selected: AgentEvaluation,
    requirements: TaskRoutingRequirements,
  ): string {
    const composite = this.computeCompositeScore(selected.scores);
    return (
      `Auto Route selected agent '${selected.agentId}' for task '${requirements.taskId}'. ` +
      `Composite score: ${composite.toFixed(1)}/100. ` +
      `Selection based on: skills (${selected.scores.skills}), ` +
      `task type (${selected.scores.taskType}), ` +
      `availability (${selected.scores.availability}), ` +
      `model access (${selected.scores.modelAccess}), ` +
      `permissions (${selected.scores.permissions}), ` +
      `quality (${selected.scores.quality}), ` +
      `history (${selected.scores.history}).`
    );
  }

  // ─── Private: Decision Builders ─────────────────────────────────────────

  private createBlockedDecision(
    mode: RoutingMode,
    evaluations: readonly AgentEvaluation[],
    deficiencies: readonly RoutingDeficiency[],
    fingerprints: RoutingFingerprints,
  ): RouteDecision {
    const deficiencySummary = deficiencies
      .map((d) => `[${d.category}] ${d.requirement}`)
      .join('; ');

    return {
      blocked: true,
      selectedAgentId: null,
      mode,
      explanation:
        `Dispatch BLOCKED — cannot override. Deficiencies: ${deficiencySummary}. ` +
        `Only explicit safe substitution can resolve these gaps.`,
      evaluations,
      deficiencies,
      fingerprints,
      decidedAt: new Date().toISOString(),
    };
  }

  // ─── Static Utility ─────────────────────────────────────────────────────

  /**
   * Compute a fingerprint for a routing decision binding.
   */
  static computeFingerprint(data: Record<string, unknown>): string {
    const payload = JSON.stringify(data, Object.keys(data).sort());
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }
}
