/**
 * OrchestrationTopologyService — Six typed orchestration topologies,
 * execution mode selection, and artifact contracts.
 *
 * Supports:
 * - Pipeline, fan-out/fan-in, expert pool, producer-reviewer, supervisor,
 *   and hierarchical delegation patterns through existing execution backends.
 * - Explicit single-agent, subagent, team, or hybrid selection with
 *   rationale, roles, capabilities, dependencies, and merge semantics.
 * - Blocking unavailable topology primitives rather than silently
 *   changing semantics.
 * - Typed artifact contracts for every producer-consumer handoff.
 *
 * Requirements: 45.1, 45.2, 45.3, 45.4
 */

// ─── Topology Types (Discriminated Union) ───────────────────────────────────

/**
 * Pipeline topology — sequential stages where each stage consumes the
 * previous stage's output.
 */
export interface PipelineTopology {
  readonly type: 'pipeline';
  /** Ordered stage identifiers. At least 2 stages required. */
  readonly stages: readonly PipelineStage[];
}

export interface PipelineStage {
  readonly stageId: string;
  readonly agentId: string;
  readonly inputArtifactIds: readonly string[];
  readonly outputArtifactId: string;
}

/**
 * Fan-out/fan-in topology — parallel execution of independent branches
 * with a merge step.
 */
export interface FanOutFanInTopology {
  readonly type: 'fan-out-fan-in';
  /** Source stage that produces shared input */
  readonly sourceStageId: string;
  /** Parallel branches that execute concurrently */
  readonly branches: readonly FanOutBranch[];
  /** Merge configuration for combining branch outputs */
  readonly merge: MergeConfig;
}

export interface FanOutBranch {
  readonly branchId: string;
  readonly agentId: string;
  readonly outputArtifactId: string;
}

export interface MergeConfig {
  readonly mergeAgentId: string;
  readonly strategy: 'concatenate' | 'select-best' | 'synthesize' | 'custom';
  readonly outputArtifactId: string;
}

/**
 * Expert pool topology — a router distributes tasks to specialized
 * agents based on capabilities.
 */
export interface ExpertPoolTopology {
  readonly type: 'expert-pool';
  /** Agent that routes incoming requests to experts */
  readonly routerAgentId: string;
  /** Pool of specialized agents with declared capabilities */
  readonly experts: readonly ExpertAgent[];
  /** How results from multiple experts are aggregated */
  readonly aggregation: 'first-response' | 'consensus' | 'weighted-merge';
}

export interface ExpertAgent {
  readonly agentId: string;
  readonly capabilities: readonly string[];
  readonly priority: number;
}

/**
 * Producer-reviewer topology — iterative refinement loop between
 * a producer and one or more reviewers.
 */
export interface ProducerReviewerTopology {
  readonly type: 'producer-reviewer';
  /** Agent that produces artifacts */
  readonly producerAgentId: string;
  /** Agents that review produced artifacts */
  readonly reviewerAgentIds: readonly string[];
  /** Maximum number of review-revise rounds */
  readonly maxRounds: number;
  /** Acceptance threshold (proportion of reviewers that must approve) */
  readonly acceptanceThreshold: number;
}

/**
 * Supervisor topology — a supervisor coordinates workers and makes
 * high-level decisions.
 */
export interface SupervisorTopology {
  readonly type: 'supervisor';
  /** The coordinating supervisor agent */
  readonly supervisorAgentId: string;
  /** Worker agents managed by the supervisor */
  readonly workerAgentIds: readonly string[];
  /** Whether the supervisor can dynamically reassign work */
  readonly dynamicReassignment: boolean;
  /** Escalation policy when workers fail or stall */
  readonly escalationPolicy: 'retry' | 'reassign' | 'escalate-to-user';
}

/**
 * Hierarchical delegation topology — multi-level tree of delegation
 * with each level having authority over its subtree.
 */
export interface HierarchicalDelegationTopology {
  readonly type: 'hierarchical-delegation';
  /** Root of the delegation hierarchy */
  readonly root: DelegationNode;
}

export interface DelegationNode {
  readonly agentId: string;
  readonly role: string;
  readonly children: readonly DelegationNode[];
  /** Artifacts this node is responsible for */
  readonly ownedArtifactIds: readonly string[];
}

/**
 * Union of all supported topology types.
 */
export type OrchestrationTopology =
  | PipelineTopology
  | FanOutFanInTopology
  | ExpertPoolTopology
  | ProducerReviewerTopology
  | SupervisorTopology
  | HierarchicalDelegationTopology;

/**
 * String literal union of topology type names.
 */
export type TopologyType = OrchestrationTopology['type'];

// ─── Execution Mode ─────────────────────────────────────────────────────────

/**
 * Execution mode — how agents are organized for the workload.
 */
export type ExecutionModeType = 'single' | 'subagent' | 'team' | 'hybrid';

/**
 * An agent role within an execution plan.
 */
export interface AgentRole {
  readonly agentId: string;
  readonly role: string;
  readonly capabilities: readonly string[];
}

/**
 * Merge semantics for combining outputs from multiple agents.
 */
export interface MergeSemantics {
  readonly strategy: 'sequential-apply' | 'conflict-resolution' | 'supervisor-decides' | 'user-decides';
  readonly conflictPolicy: 'fail' | 'last-writer-wins' | 'manual-merge';
}

/**
 * Dependency between agent roles in an execution plan.
 */
export interface RoleDependency {
  readonly fromRole: string;
  readonly toRole: string;
  readonly artifactId: string;
}

/**
 * The selected execution mode with full rationale and configuration.
 */
export interface ExecutionMode {
  readonly mode: ExecutionModeType;
  /** Human-readable rationale for the mode selection */
  readonly rationale: string;
  /** Agent roles assigned in this execution */
  readonly roles: readonly AgentRole[];
  /** Declared capabilities required for this workload */
  readonly requiredCapabilities: readonly string[];
  /** Dependencies between roles */
  readonly dependencies: readonly RoleDependency[];
  /** How outputs from multiple roles are merged */
  readonly mergeSemantics: MergeSemantics;
}

// ─── Artifact Contracts ─────────────────────────────────────────────────────

/**
 * Failure handling behavior for an artifact.
 */
export type ArtifactFailureHandling =
  | 'block-downstream'
  | 'retry-producer'
  | 'use-fallback'
  | 'escalate-to-user';

/**
 * A typed contract for a producer-consumer artifact handoff.
 */
export interface ArtifactContract {
  /** Unique identifier for this artifact */
  readonly artifactId: string;
  /** Agent that produces this artifact */
  readonly owner: string;
  /** JSON Schema or type reference describing the artifact shape */
  readonly schema: string;
  /** Artifact version (semver or integer) */
  readonly version: string;
  /** Acceptance checks that must pass before downstream consumption */
  readonly checks: readonly ArtifactCheck[];
  /** Where the artifact is delivered */
  readonly destination: ArtifactDestination;
  /** What happens when the artifact fails checks or production */
  readonly failureHandling: ArtifactFailureHandling;
}

/**
 * An acceptance check for an artifact.
 */
export interface ArtifactCheck {
  readonly checkId: string;
  readonly description: string;
  readonly type: 'schema-validation' | 'content-assertion' | 'quality-gate' | 'custom';
}

/**
 * Destination for an artifact.
 */
export interface ArtifactDestination {
  readonly type: 'next-stage' | 'named-consumer' | 'evidence-store' | 'workspace';
  readonly target: string;
}

// ─── Orchestration Plan ─────────────────────────────────────────────────────

/**
 * A complete executable orchestration plan combining topology,
 * execution mode, and artifact contracts.
 */
export interface ExecutableOrchestrationPlan {
  readonly planId: string;
  readonly taskId: string;
  readonly topology: OrchestrationTopology;
  readonly executionMode: ExecutionMode;
  readonly artifactContracts: readonly ArtifactContract[];
  readonly createdAt: string;
}

// ─── Available Primitives ───────────────────────────────────────────────────

/**
 * Primitives that the runtime currently supports.
 * Used to validate topology requirements before dispatch.
 */
export interface AvailablePrimitives {
  /** Whether parallel execution is supported */
  readonly parallelExecution: boolean;
  /** Whether iterative review loops are supported */
  readonly reviewLoops: boolean;
  /** Whether hierarchical delegation is supported */
  readonly hierarchicalDelegation: boolean;
  /** Whether dynamic agent routing is supported */
  readonly dynamicRouting: boolean;
  /** Whether supervisor-managed workers are supported */
  readonly supervisorPattern: boolean;
  /** Maximum concurrent agents */
  readonly maxConcurrentAgents: number;
}

// ─── Validation Errors ──────────────────────────────────────────────────────

/**
 * Error raised when a topology requires primitives not available
 * in the current runtime.
 */
export class TopologyPrimitiveUnavailableError extends Error {
  constructor(
    public readonly topologyType: TopologyType,
    public readonly missingPrimitive: string,
    public readonly reason: string,
  ) {
    super(
      `Topology '${topologyType}' requires '${missingPrimitive}' which is unavailable: ${reason}`,
    );
    this.name = 'TopologyPrimitiveUnavailableError';
  }
}

/**
 * Error raised when a topology's specific structural requirements
 * are not met.
 */
export class TopologyValidationError extends Error {
  constructor(
    public readonly topologyType: TopologyType,
    public readonly violations: readonly string[],
  ) {
    super(
      `Topology '${topologyType}' validation failed: ${violations.join('; ')}`,
    );
    this.name = 'TopologyValidationError';
  }
}

/**
 * Error raised when artifact contracts are invalid.
 */
export class ArtifactContractError extends Error {
  constructor(
    public readonly artifactId: string,
    public readonly reason: string,
  ) {
    super(`Artifact contract '${artifactId}' invalid: ${reason}`);
    this.name = 'ArtifactContractError';
  }
}

// ─── OrchestrationTopologyService ───────────────────────────────────────────

/**
 * OrchestrationTopologyService validates and assembles executable
 * orchestration plans from topology selection, execution mode,
 * and artifact contracts.
 */
export class OrchestrationTopologyService {
  constructor(private readonly availablePrimitives: AvailablePrimitives) {}

  /**
   * Validate that a topology's required primitives are available.
   * Throws TopologyPrimitiveUnavailableError if any are missing.
   */
  validatePrimitiveAvailability(topology: OrchestrationTopology): void {
    switch (topology.type) {
      case 'pipeline':
        // Pipeline needs sequential execution — always available
        break;

      case 'fan-out-fan-in':
        if (!this.availablePrimitives.parallelExecution) {
          throw new TopologyPrimitiveUnavailableError(
            'fan-out-fan-in',
            'parallelExecution',
            'Runtime does not support parallel agent execution',
          );
        }
        if (topology.branches.length > this.availablePrimitives.maxConcurrentAgents) {
          throw new TopologyPrimitiveUnavailableError(
            'fan-out-fan-in',
            'maxConcurrentAgents',
            `Requires ${topology.branches.length} concurrent agents but only ${this.availablePrimitives.maxConcurrentAgents} are supported`,
          );
        }
        break;

      case 'expert-pool':
        if (!this.availablePrimitives.dynamicRouting) {
          throw new TopologyPrimitiveUnavailableError(
            'expert-pool',
            'dynamicRouting',
            'Runtime does not support dynamic agent routing',
          );
        }
        break;

      case 'producer-reviewer':
        if (!this.availablePrimitives.reviewLoops) {
          throw new TopologyPrimitiveUnavailableError(
            'producer-reviewer',
            'reviewLoops',
            'Runtime does not support iterative review loops',
          );
        }
        break;

      case 'supervisor':
        if (!this.availablePrimitives.supervisorPattern) {
          throw new TopologyPrimitiveUnavailableError(
            'supervisor',
            'supervisorPattern',
            'Runtime does not support supervisor-managed worker pattern',
          );
        }
        break;

      case 'hierarchical-delegation':
        if (!this.availablePrimitives.hierarchicalDelegation) {
          throw new TopologyPrimitiveUnavailableError(
            'hierarchical-delegation',
            'hierarchicalDelegation',
            'Runtime does not support hierarchical delegation',
          );
        }
        break;
    }
  }

  /**
   * Validate topology-specific structural requirements.
   * Throws TopologyValidationError if the structure is invalid.
   */
  validateTopologyStructure(topology: OrchestrationTopology): void {
    const violations: string[] = [];

    switch (topology.type) {
      case 'pipeline':
        if (topology.stages.length < 2) {
          violations.push('Pipeline requires at least 2 sequential stages');
        }
        // Check for duplicate stage IDs
        const stageIds = new Set<string>();
        for (const stage of topology.stages) {
          if (stageIds.has(stage.stageId)) {
            violations.push(`Duplicate stage ID: '${stage.stageId}'`);
          }
          stageIds.add(stage.stageId);
        }
        break;

      case 'fan-out-fan-in':
        if (topology.branches.length < 2) {
          violations.push('Fan-out/fan-in requires at least 2 branches');
        }
        if (!topology.sourceStageId) {
          violations.push('Fan-out/fan-in requires a source stage');
        }
        if (!topology.merge.mergeAgentId) {
          violations.push('Fan-out/fan-in requires a merge agent');
        }
        break;

      case 'expert-pool':
        if (topology.experts.length < 2) {
          violations.push('Expert pool requires at least 2 experts');
        }
        if (!topology.routerAgentId) {
          violations.push('Expert pool requires a router agent');
        }
        break;

      case 'producer-reviewer':
        if (!topology.producerAgentId) {
          violations.push('Producer-reviewer requires a producer agent');
        }
        if (topology.reviewerAgentIds.length < 1) {
          violations.push('Producer-reviewer requires at least 1 reviewer');
        }
        // Total agents must be at least 2 (producer + at least 1 reviewer)
        if (topology.reviewerAgentIds.includes(topology.producerAgentId)) {
          violations.push('Producer cannot also be a reviewer');
        }
        if (topology.maxRounds < 1) {
          violations.push('Producer-reviewer requires at least 1 round');
        }
        if (topology.acceptanceThreshold <= 0 || topology.acceptanceThreshold > 1) {
          violations.push('Acceptance threshold must be between 0 (exclusive) and 1 (inclusive)');
        }
        break;

      case 'supervisor':
        if (!topology.supervisorAgentId) {
          violations.push('Supervisor topology requires a supervisor agent');
        }
        if (topology.workerAgentIds.length < 1) {
          violations.push('Supervisor topology requires at least 1 worker');
        }
        if (topology.workerAgentIds.includes(topology.supervisorAgentId)) {
          violations.push('Supervisor cannot also be a worker');
        }
        break;

      case 'hierarchical-delegation':
        if (!topology.root.agentId) {
          violations.push('Hierarchical delegation requires a root agent');
        }
        if (topology.root.children.length < 1) {
          violations.push('Hierarchical delegation requires at least 1 child node');
        }
        // Check for agent duplication in the tree
        const agentsSeen = new Set<string>();
        const duplicates = this.findDuplicateAgentsInTree(topology.root, agentsSeen);
        if (duplicates.length > 0) {
          violations.push(`Duplicate agents in hierarchy: ${duplicates.join(', ')}`);
        }
        break;
    }

    if (violations.length > 0) {
      throw new TopologyValidationError(topology.type, violations);
    }
  }

  /**
   * Validate artifact contracts for completeness and consistency.
   * Throws ArtifactContractError on the first invalid contract.
   */
  validateArtifactContracts(contracts: readonly ArtifactContract[]): void {
    const ids = new Set<string>();

    for (const contract of contracts) {
      // Check for duplicate artifact IDs
      if (ids.has(contract.artifactId)) {
        throw new ArtifactContractError(
          contract.artifactId,
          'Duplicate artifact ID',
        );
      }
      ids.add(contract.artifactId);

      // Validate required fields
      if (!contract.owner) {
        throw new ArtifactContractError(
          contract.artifactId,
          'Missing owner',
        );
      }
      if (!contract.schema) {
        throw new ArtifactContractError(
          contract.artifactId,
          'Missing schema',
        );
      }
      if (!contract.version) {
        throw new ArtifactContractError(
          contract.artifactId,
          'Missing version',
        );
      }
      if (!contract.destination || !contract.destination.target) {
        throw new ArtifactContractError(
          contract.artifactId,
          'Missing or incomplete destination',
        );
      }
    }
  }

  /**
   * Create a complete executable orchestration plan.
   * Validates primitives, topology structure, and artifact contracts
   * before assembling.
   */
  createPlan(params: {
    planId: string;
    taskId: string;
    topology: OrchestrationTopology;
    executionMode: ExecutionMode;
    artifactContracts: readonly ArtifactContract[];
  }): ExecutableOrchestrationPlan {
    // 1. Validate required primitives are available
    this.validatePrimitiveAvailability(params.topology);

    // 2. Validate topology-specific structural requirements
    this.validateTopologyStructure(params.topology);

    // 3. Validate artifact contracts
    this.validateArtifactContracts(params.artifactContracts);

    // 4. Validate execution mode consistency
    this.validateExecutionMode(params.executionMode, params.topology);

    // 5. Assemble the plan
    return {
      planId: params.planId,
      taskId: params.taskId,
      topology: params.topology,
      executionMode: params.executionMode,
      artifactContracts: params.artifactContracts,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Validate that the execution mode is consistent with the topology.
   */
  private validateExecutionMode(
    mode: ExecutionMode,
    topology: OrchestrationTopology,
  ): void {
    // Single mode can only be used with pipeline (single agent doing sequential steps)
    if (mode.mode === 'single') {
      if (topology.type !== 'pipeline') {
        throw new TopologyValidationError(topology.type, [
          `Single execution mode is only compatible with pipeline topology, got '${topology.type}'`,
        ]);
      }
      // Pipeline with single mode must have all stages assigned to the same agent
      const agents = new Set((topology as PipelineTopology).stages.map(s => s.agentId));
      if (agents.size > 1) {
        throw new TopologyValidationError(topology.type, [
          'Single execution mode requires all pipeline stages to use the same agent',
        ]);
      }
    }

    // Validate rationale is present
    if (!mode.rationale || mode.rationale.trim().length === 0) {
      throw new TopologyValidationError(topology.type, [
        'Execution mode requires a non-empty rationale',
      ]);
    }

    // Team and hybrid modes must have at least 2 roles
    if ((mode.mode === 'team' || mode.mode === 'hybrid') && mode.roles.length < 2) {
      throw new TopologyValidationError(topology.type, [
        `${mode.mode} execution mode requires at least 2 roles`,
      ]);
    }
  }

  /**
   * Recursively find duplicate agents in a delegation tree.
   */
  private findDuplicateAgentsInTree(
    node: DelegationNode,
    seen: Set<string>,
  ): string[] {
    const duplicates: string[] = [];
    if (seen.has(node.agentId)) {
      duplicates.push(node.agentId);
    }
    seen.add(node.agentId);
    for (const child of node.children) {
      duplicates.push(...this.findDuplicateAgentsInTree(child, seen));
    }
    return duplicates;
  }
}
