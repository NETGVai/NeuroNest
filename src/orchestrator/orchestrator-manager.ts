/**
 * OrchestratorManager — Hierarchical task decomposition, multi-pattern coordination.
 *
 * Stub implementation with in-memory state. Manages orchestrator creation,
 * task graph decomposition, three orchestration patterns, parallel/sequential
 * execution, subtask failure handling, and predefined workflow templates.
 *
 * Requirements: 6.1–6.10
 *
 * 12-factor-agent-improvements task 26: every iteration of the topological
 * execution loop in `execute()` is a "tick" and is timed with
 * `performance.now()`; the duration is recorded under
 * `orchestrator.tick_latency_ms` to Metrics_Sink. Telemetry is unconditional —
 * not gated by feature flags — because it is the baseline measurement that
 * Phase 1's rollout-gate script (Requirement 6.7) compares against the
 * flag-on benchmark. Recording is fail-soft so a metrics-sink hiccup never
 * breaks orchestrator execution.
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type {
  TaskGraph,
  TaskNode,
  TaskEdge,
  OrchestrationPattern,
  TaskNodeStatus,
} from '../shared/types.js';

/**
 * Structural type for the Metrics_Sink — kept minimal and local so the
 * orchestrator does not import `SessionTelemetryService` directly. Any
 * object exposing `recordMetric(sessionId, key, value)` satisfies it
 * (notably `SessionTelemetryService` from `src/session/session-telemetry.ts`,
 * but tests can pass a plain stub).
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/** Metrics_Sink key under which per-tick orchestrator latency is recorded. */
export const ORCHESTRATOR_TICK_LATENCY_METRIC_KEY = 'orchestrator.tick_latency_ms';

// ─── Types ──────────────────────────────────────────────────────

export type OrchestratorStatus =
  | 'decomposing'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type FailureAction = 'retry' | 'skip' | 'reassign' | 'abort';

export interface TaskGraphEdit {
  type: 'add_node' | 'remove_node' | 'add_edge' | 'remove_edge' | 'update_node' | 'update_edge';
  payload: Record<string, unknown>;
}

export interface TaskProgress {
  nodeId: string;
  status: TaskNodeStatus;
  output?: string;
  error?: string;
}

export interface OrchestratorResult {
  orchestratorId: string;
  status: OrchestratorStatus;
  taskGraph: TaskGraph;
  nodeResults: Map<string, string>;
  failures: Array<{ nodeId: string; error: string; action: FailureAction }>;
  durationMs: number;
}

export interface Orchestrator {
  id: string;
  task: string;
  taskGraph: TaskGraph;
  status: OrchestratorStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  taskGraph: TaskGraph;
}

// ─── Predefined workflow templates ──────────────────────────────

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'mvp-build',
    name: 'MVP Build',
    description: 'Plan, implement, test, and deploy a minimum viable product',
    taskGraph: {
      nodes: [
        { id: 'plan', description: 'Create implementation plan', status: 'pending' },
        { id: 'implement', description: 'Implement core features', status: 'pending' },
        { id: 'test', description: 'Write and run tests', status: 'pending' },
        { id: 'review', description: 'Code review', status: 'pending' },
      ],
      edges: [
        { from: 'plan', to: 'implement', pattern: 'handoff' },
        { from: 'implement', to: 'test', pattern: 'handoff' },
        { from: 'test', to: 'review', pattern: 'handoff' },
      ],
    },
  },
  {
    id: 'code-review-pipeline',
    name: 'Code Review Pipeline',
    description: 'Multi-agent code review with security, performance, and style checks',
    taskGraph: {
      nodes: [
        { id: 'security', description: 'Security review', status: 'pending' },
        { id: 'performance', description: 'Performance review', status: 'pending' },
        { id: 'style', description: 'Style and best practices review', status: 'pending' },
        { id: 'aggregate', description: 'Aggregate review findings', status: 'pending' },
      ],
      edges: [
        { from: 'security', to: 'aggregate', pattern: 'assign' },
        { from: 'performance', to: 'aggregate', pattern: 'assign' },
        { from: 'style', to: 'aggregate', pattern: 'assign' },
      ],
    },
  },
  {
    id: 'feature-development',
    name: 'Feature Development',
    description: 'End-to-end feature development workflow',
    taskGraph: {
      nodes: [
        { id: 'design', description: 'Design feature architecture', status: 'pending' },
        { id: 'implement', description: 'Implement feature', status: 'pending' },
        { id: 'test', description: 'Write tests', status: 'pending' },
        { id: 'docs', description: 'Write documentation', status: 'pending' },
      ],
      edges: [
        { from: 'design', to: 'implement', pattern: 'handoff' },
        { from: 'implement', to: 'test', pattern: 'handoff' },
        { from: 'implement', to: 'docs', pattern: 'assign' },
      ],
    },
  },
  {
    id: 'bug-investigation',
    name: 'Bug Investigation',
    description: 'Investigate, reproduce, fix, and verify a bug',
    taskGraph: {
      nodes: [
        { id: 'investigate', description: 'Investigate bug root cause', status: 'pending' },
        { id: 'reproduce', description: 'Create reproduction case', status: 'pending' },
        { id: 'fix', description: 'Implement fix', status: 'pending' },
        { id: 'verify', description: 'Verify fix with tests', status: 'pending' },
      ],
      edges: [
        { from: 'investigate', to: 'reproduce', pattern: 'handoff' },
        { from: 'reproduce', to: 'fix', pattern: 'handoff' },
        { from: 'fix', to: 'verify', pattern: 'handoff' },
      ],
    },
  },
  {
    id: 'performance-audit',
    name: 'Performance Audit',
    description: 'Profile, analyze, and optimize application performance',
    taskGraph: {
      nodes: [
        { id: 'profile', description: 'Profile application', status: 'pending' },
        { id: 'analyze', description: 'Analyze bottlenecks', status: 'pending' },
        { id: 'optimize', description: 'Implement optimizations', status: 'pending' },
        { id: 'benchmark', description: 'Benchmark improvements', status: 'pending' },
      ],
      edges: [
        { from: 'profile', to: 'analyze', pattern: 'handoff' },
        { from: 'analyze', to: 'optimize', pattern: 'handoff' },
        { from: 'optimize', to: 'benchmark', pattern: 'handoff' },
      ],
    },
  },
];

// ─── OrchestratorManager ────────────────────────────────────────

export class OrchestratorManager {
  private orchestrators = new Map<string, Orchestrator>();
  private progressCallbacks = new Map<string, Array<(progress: TaskProgress) => void>>();
  private readonly metricsSink?: MetricsSink;

  /**
   * @param opts.metricsSink Optional Metrics_Sink (e.g. `SessionTelemetryService`).
   *   When provided, every tick of the topological execution loop in
   *   `execute()` records `orchestrator.tick_latency_ms`. When omitted the
   *   orchestrator runs unchanged — preserves backward compatibility for the
   *   handful of legacy call sites that construct it without arguments.
   */
  constructor(opts?: { metricsSink?: MetricsSink }) {
    this.metricsSink = opts?.metricsSink;
  }

  /**
   * Create a new orchestrator for a task.
   * Requirements: 6.1, 6.2
   */
  createOrchestrator(task: string): Orchestrator {
    const id = randomUUID();
    const orchestrator: Orchestrator = {
      id,
      task,
      taskGraph: { nodes: [], edges: [] },
      status: 'decomposing',
      createdAt: new Date(),
    };
    this.orchestrators.set(id, orchestrator);
    return orchestrator;
  }

  /**
   * Get an orchestrator by ID.
   */
  getOrchestrator(orchestratorId: string): Orchestrator | null {
    return this.orchestrators.get(orchestratorId) ?? null;
  }

  /**
   * List all active orchestrators.
   */
  listActiveOrchestrators(): Orchestrator[] {
    return Array.from(this.orchestrators.values()).filter(
      (o) =>
        o.status === 'decomposing' ||
        o.status === 'awaiting_approval' ||
        o.status === 'running' ||
        o.status === 'paused',
    );
  }

  /**
   * Decompose a task into a TaskGraph (stub).
   * Requirements: 6.2
   */
  async decompose(orchestratorId: string, task: string): Promise<TaskGraph> {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);

    // Stub: create a simple linear task graph
    const nodes: TaskNode[] = [
      { id: randomUUID(), description: `Plan: ${task}`, status: 'pending' },
      { id: randomUUID(), description: `Execute: ${task}`, status: 'pending' },
      { id: randomUUID(), description: `Verify: ${task}`, status: 'pending' },
    ];

    const edges: TaskEdge[] = [
      { from: nodes[0].id, to: nodes[1].id, pattern: 'handoff' },
      { from: nodes[1].id, to: nodes[2].id, pattern: 'handoff' },
    ];

    orchestrator.taskGraph = { nodes, edges };
    orchestrator.status = 'awaiting_approval';
    return orchestrator.taskGraph;
  }

  /**
   * Execute an orchestrator's task graph.
   * Requirements: 6.6, 6.7, 6.8
   */
  async execute(orchestratorId: string): Promise<OrchestratorResult> {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);

    orchestrator.status = 'running';
    orchestrator.startedAt = new Date();

    const nodeResults = new Map<string, string>();
    const failures: Array<{ nodeId: string; error: string; action: FailureAction }> = [];
    const startTime = Date.now();

    // Topological execution: process nodes respecting dependencies
    const executed = new Set<string>();
    const { nodes, edges } = orchestrator.taskGraph;

    // Build dependency map
    const deps = new Map<string, string[]>();
    for (const node of nodes) {
      deps.set(node.id, []);
    }
    for (const edge of edges) {
      const nodeDeps = deps.get(edge.to) ?? [];
      nodeDeps.push(edge.from);
      deps.set(edge.to, nodeDeps);
    }

    // Execute in topological order. Each iteration of this `while` loop is
    // one orchestrator "tick" — it scans for ready nodes and dispatches a
    // wave of work. Per 12-factor-agent-improvements Requirement 5.3 + 6.7,
    // each tick is timed and recorded to Metrics_Sink (when provided).
    let progress = true;
    while (progress && executed.size < nodes.length) {
      const tickStart = performance.now();
      try {
        progress = false;
        const ready = nodes.filter(
          (n) =>
            !executed.has(n.id) &&
            n.status !== 'failed' &&
            n.status !== 'skipped' &&
            (deps.get(n.id) ?? []).every((d) => executed.has(d)),
        );

        // Identify parallel vs sequential based on patterns
        for (const node of ready) {
          node.status = 'running';
          this.emitProgress(orchestratorId, { nodeId: node.id, status: 'running' });

          // Stub: mark as completed
          node.status = 'completed';
          node.output = `Result for: ${node.description}`;
          nodeResults.set(node.id, node.output);
          executed.add(node.id);
          progress = true;

          this.emitProgress(orchestratorId, {
            nodeId: node.id,
            status: 'completed',
            output: node.output,
          });
        }
      } finally {
        // Fail-soft: a metrics-sink failure (sink absent, DB busy, etc.)
        // must never break the orchestrator. The metric is the baseline
        // measurement Phase 1 of the rollout gate compares against, so we
        // record on every tick regardless of feature flags. `orchestratorId`
        // is the closest stable identifier we have for the unit of work in
        // flight — Metrics_Sink stores it in the `session_id` column so the
        // dashboard / rollout-gate script can group-by execution.
        if (this.metricsSink) {
          const elapsedMs = performance.now() - tickStart;
          try {
            this.metricsSink.recordMetric(
              orchestratorId,
              ORCHESTRATOR_TICK_LATENCY_METRIC_KEY,
              elapsedMs,
            );
          } catch {
            // swallow — telemetry must never break orchestration
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;
    orchestrator.status = failures.length > 0 ? 'failed' : 'completed';
    orchestrator.completedAt = new Date();

    return {
      orchestratorId,
      status: orchestrator.status,
      taskGraph: orchestrator.taskGraph,
      nodeResults,
      failures,
      durationMs,
    };
  }

  /**
   * Pause orchestrator execution.
   */
  pause(orchestratorId: string): void {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);
    orchestrator.status = 'paused';
  }

  /**
   * Resume orchestrator execution.
   */
  resume(orchestratorId: string): void {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);
    orchestrator.status = 'running';
  }

  /**
   * Cancel orchestrator execution.
   */
  cancel(orchestratorId: string): void {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);
    orchestrator.status = 'failed';
    for (const node of orchestrator.taskGraph.nodes) {
      if (node.status === 'pending' || node.status === 'queued' || node.status === 'running') {
        node.status = 'skipped';
      }
    }
  }

  /**
   * Edit the task graph before or during execution.
   * Requirements: 6.9
   */
  editTaskGraph(orchestratorId: string, edits: TaskGraphEdit[]): void {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);

    for (const edit of edits) {
      switch (edit.type) {
        case 'add_node': {
          const node: TaskNode = {
            id: (edit.payload.id as string) ?? randomUUID(),
            description: (edit.payload.description as string) ?? '',
            status: 'pending',
            assignedAgent: edit.payload.assignedAgent as string | undefined,
          };
          orchestrator.taskGraph.nodes.push(node);
          break;
        }
        case 'remove_node': {
          const nodeId = edit.payload.nodeId as string;
          orchestrator.taskGraph.nodes = orchestrator.taskGraph.nodes.filter(
            (n) => n.id !== nodeId,
          );
          orchestrator.taskGraph.edges = orchestrator.taskGraph.edges.filter(
            (e) => e.from !== nodeId && e.to !== nodeId,
          );
          break;
        }
        case 'add_edge': {
          const edge: TaskEdge = {
            from: edit.payload.from as string,
            to: edit.payload.to as string,
            pattern: (edit.payload.pattern as OrchestrationPattern) ?? 'handoff',
            condition: edit.payload.condition as string | undefined,
          };
          orchestrator.taskGraph.edges.push(edge);
          break;
        }
        case 'remove_edge': {
          const from = edit.payload.from as string;
          const to = edit.payload.to as string;
          orchestrator.taskGraph.edges = orchestrator.taskGraph.edges.filter(
            (e) => !(e.from === from && e.to === to),
          );
          break;
        }
        case 'update_node': {
          const id = edit.payload.id as string;
          const node = orchestrator.taskGraph.nodes.find((n) => n.id === id);
          if (node) {
            if (edit.payload.description !== undefined) {
              node.description = edit.payload.description as string;
            }
            if (edit.payload.assignedAgent !== undefined) {
              node.assignedAgent = edit.payload.assignedAgent as string;
            }
            if (edit.payload.status !== undefined) {
              node.status = edit.payload.status as TaskNodeStatus;
            }
          }
          break;
        }
        case 'update_edge': {
          const eFrom = edit.payload.from as string;
          const eTo = edit.payload.to as string;
          const edge = orchestrator.taskGraph.edges.find(
            (e) => e.from === eFrom && e.to === eTo,
          );
          if (edge && edit.payload.pattern !== undefined) {
            edge.pattern = edit.payload.pattern as OrchestrationPattern;
          }
          break;
        }
      }
    }
  }

  /**
   * Handle a subtask failure with a specified action.
   * Requirements: 6.8
   */
  handleFailure(
    orchestratorId: string,
    nodeId: string,
    action: FailureAction,
    reassignAgentId?: string,
  ): void {
    const orchestrator = this.orchestrators.get(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);

    const node = orchestrator.taskGraph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    switch (action) {
      case 'retry':
        node.status = 'pending';
        break;
      case 'skip':
        node.status = 'skipped';
        break;
      case 'reassign':
        node.assignedAgent = reassignAgentId;
        node.status = 'pending';
        break;
      case 'abort':
        orchestrator.status = 'failed';
        break;
    }
  }

  /**
   * Get predefined workflow templates.
   * Requirements: 6.10
   */
  getWorkflowTemplates(): WorkflowTemplate[] {
    return [...WORKFLOW_TEMPLATES];
  }

  /**
   * Create an orchestrator from a workflow template.
   * Requirements: 6.10
   */
  createFromTemplate(templateId: string, task: string): Orchestrator {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    const orchestrator = this.createOrchestrator(task);
    // Deep copy the template's task graph
    orchestrator.taskGraph = {
      nodes: template.taskGraph.nodes.map((n) => ({ ...n, id: randomUUID() })),
      edges: [],
    };

    // Remap edges to new node IDs
    const idMap = new Map<string, string>();
    template.taskGraph.nodes.forEach((origNode, i) => {
      idMap.set(origNode.id, orchestrator.taskGraph.nodes[i].id);
    });

    orchestrator.taskGraph.edges = template.taskGraph.edges.map((e) => ({
      from: idMap.get(e.from) ?? e.from,
      to: idMap.get(e.to) ?? e.to,
      pattern: e.pattern,
      condition: e.condition,
    }));

    orchestrator.status = 'awaiting_approval';
    return orchestrator;
  }

  /**
   * Register a progress callback.
   */
  onProgress(orchestratorId: string, callback: (progress: TaskProgress) => void): void {
    let callbacks = this.progressCallbacks.get(orchestratorId);
    if (!callbacks) {
      callbacks = [];
      this.progressCallbacks.set(orchestratorId, callbacks);
    }
    callbacks.push(callback);
  }

  // ── Private helpers ─────────────────────────────────────────

  private emitProgress(orchestratorId: string, progress: TaskProgress): void {
    const callbacks = this.progressCallbacks.get(orchestratorId) ?? [];
    for (const cb of callbacks) {
      cb(progress);
    }
  }
}
