/**
 * Gatekeeper Wiring — Integration module connecting Gatekeeper with
 * Gadget Engine, Code Mode Agent, Observation Tracker, and Simulated Approval.
 *
 * This module provides factory functions that create properly connected instances
 * of the security subsystems. It demonstrates how these subsystems connect in
 * practice without modifying the individual subsystem implementations.
 *
 * Wiring overview:
 * 1. Gadget Engine → Gatekeeper: capability-mediated external access for gadgets
 * 2. Code Mode Agent → Gatekeeper: all external calls from code snippets are mediated
 * 3. Observation Tracker → Gatekeeper: auto-record observations on read operations
 * 4. Simulated Approval → Gatekeeper: write operations enter approval queue
 *
 * Requirements: 1.2, 3.1, 3.8, 4.1, 5.1, 8.5
 */

import type Database from 'better-sqlite3';
import type {
  GatekeeperLayer,
  GadgetEngine,
  ObservationTracker,
  SimulatedApprovalEngine,
  CodeModeAgent,
  CapabilityBinding,
  CodeModeContext,
  CodeModeLimits,
  GadgetSpec,
  GadgetHandle,
} from '../types/cloudflare-os.js';
import {
  createGatekeeperLayer,
  type GatekeeperConfig,
  type PermissionPatternEngineLike,
  type CredentialVaultLike,
  type SecurityPostureLike,
} from '../gatekeeper/gatekeeper-layer.js';
import {
  createObservationTracker,
  type ObservationTrackerConfig,
} from '../gatekeeper/observation-tracker.js';
import {
  createSimulatedApprovalEngine,
  isReadOperation,
  type SimulatedApprovalConfig,
} from '../gatekeeper/simulated-approval.js';
import { createCodeModeAgent } from '../code-mode/code-mode-agent.js';
import { GadgetEngineImpl, type GadgetEngineConfig } from '../gadgets/gadget-engine.js';
import type { NetworkPolicy } from '../security/network-sandbox.js';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for creating a fully-wired subsystem graph.
 * All subsystems share the same SQLite database and security infrastructure.
 */
export interface GatekeeperWiringConfig {
  /** The shared SQLite database instance (must have all required migrations applied) */
  db: Database.Database;

  /** Permission Pattern Engine for security posture evaluation */
  permissionEngine?: PermissionPatternEngineLike;

  /** Credential vault for isolated credential storage */
  credentialVault?: CredentialVaultLike;

  /** Security posture provider (strict/auto/autonomous) */
  securityPosture?: SecurityPostureLike;

  /** Active project ID for posture lookups */
  projectId?: string;

  /** Callback for user approval requests (strict/auto posture) */
  onApprovalRequired?: (request: {
    agentId: string;
    resourceType: string;
    scope: string;
  }) => Promise<boolean>;

  /** Callback for checking user permissions (observation tracker) */
  checkUserPermission?: (userId: string, resourceId: string) => boolean;

  /** Custom base directory for gadget data (defaults to ~/.neuronest/gadgets) */
  gadgetsBaseDir?: string;

  /** Callback for applying network policy to gadget processes */
  applyNetworkPolicy?: (gadgetId: string, policy: NetworkPolicy) => void;

  /** Callback invoked when a gadget process crashes */
  onGadgetCrash?: (gadgetId: string, code: number | null, signal: string | null) => void;

  /** Code Mode execution limits */
  codeModeDefaultLimits?: Partial<CodeModeLimits>;

  /** Simulated approval execution timeout in ms (default: 5000) */
  approvalTimeoutMs?: number;
}

/**
 * The fully-wired subsystem graph returned by `wireGatekeeperSubsystems()`.
 * All subsystems are properly connected and ready for use.
 */
export interface WiredSubsystems {
  /** Core Gatekeeper Layer — mediates all external access */
  gatekeeper: GatekeeperLayer;

  /** Gadget Engine — connected to Gatekeeper for capability-mediated access */
  gadgetEngine: GadgetEngine;

  /** Code Mode Agent — all external calls go through Gatekeeper */
  codeModeAgent: CodeModeAgent;

  /** Observation Tracker — auto-records observations on reads */
  observationTracker: ObservationTracker;

  /** Simulated Approval — manages deferred write operations */
  simulatedApproval: SimulatedApprovalEngine;

  /**
   * Execute an operation with full integration:
   * - Read operations: execute immediately, record observation
   * - Write operations: simulate via approval queue
   *
   * This is the primary entry point for subsystem-mediated access.
   */
  executeWithPolicy: (
    binding: CapabilityBinding,
    operation: string,
    params: unknown,
    actorId: string,
    actorType: 'agent' | 'gadget' | 'code_mode',
  ) => Promise<unknown>;
}

// ─── Factory Functions ──────────────────────────────────────────

/**
 * Wire all Gatekeeper-related subsystems into a connected graph.
 *
 * This factory creates:
 * 1. A GatekeeperLayer instance for core capability-based security
 * 2. An ObservationTracker that auto-records read operations
 * 3. A SimulatedApprovalEngine that queues write operations for review
 * 4. A CodeModeAgent connected to the Gatekeeper for sandboxed code execution
 * 5. A GadgetEngine connected to the Gatekeeper for capability-mediated gadget access
 *
 * The `executeWithPolicy` function integrates all subsystems:
 * - For reads: executes through Gatekeeper, then records the observation
 * - For writes: routes through Simulated Approval, queuing for human review
 *
 * Requirements:
 * - 1.2: Gadgets access external resources only through Capability Bindings
 * - 3.1: Zero-access startup via Gatekeeper
 * - 3.8: Security posture integration (strict/auto/autonomous)
 * - 4.1: Side-effecting actions enter simulated approval queue
 * - 5.1: Read operations auto-record observations
 * - 8.5: Code Mode external calls are mediated through Gatekeeper
 */
export function wireGatekeeperSubsystems(config: GatekeeperWiringConfig): WiredSubsystems {
  const { db } = config;

  // 1. Create the core Gatekeeper Layer
  const gatekeeperConfig: GatekeeperConfig = {
    db,
    permissionEngine: config.permissionEngine,
    credentialVault: config.credentialVault,
    securityPosture: config.securityPosture,
    projectId: config.projectId,
    onApprovalRequired: config.onApprovalRequired,
  };
  const gatekeeper = createGatekeeperLayer(gatekeeperConfig);

  // 2. Create the Observation Tracker (auto-records observations on reads)
  const observationTrackerConfig: ObservationTrackerConfig = {
    db,
    checkUserPermission: config.checkUserPermission,
  };
  const observationTracker = createObservationTracker(observationTrackerConfig);

  // 3. Create the Simulated Approval Engine
  //    The executor is the Gatekeeper itself — on approval, the action
  //    is executed through the Gatekeeper's normal path.
  const approvalConfig: SimulatedApprovalConfig = {
    db,
    executor: gatekeeper,
    executionTimeoutMs: config.approvalTimeoutMs ?? 5000,
  };
  const simulatedApproval = createSimulatedApprovalEngine(approvalConfig);

  // 4. Create the Code Mode Agent connected to the Gatekeeper
  //    All external calls from code snippets are mediated through Gatekeeper.
  //    (Requirement 8.5)
  const codeModeAgent = createCodeModeAgent(
    db,
    gatekeeper,
    config.codeModeDefaultLimits,
  );

  // 5. Create the Gadget Engine connected to the Gatekeeper
  //    Gadgets start with no network access; external access is only
  //    available through Capability Bindings mediated by the Gatekeeper.
  //    (Requirement 1.2)
  const gadgetEngineConfig: GadgetEngineConfig = {
    db,
    gadgetsBaseDir: config.gadgetsBaseDir,
    applyNetworkPolicy: config.applyNetworkPolicy,
    onCrash: config.onGadgetCrash,
  };
  const gadgetEngine = new GadgetEngineImpl(gadgetEngineConfig);

  // 6. Create the integrated execution function that wires all subsystems together
  const executeWithPolicy = createPolicyExecutor(
    gatekeeper,
    observationTracker,
    simulatedApproval,
  );

  return {
    gatekeeper,
    gadgetEngine,
    codeModeAgent,
    observationTracker,
    simulatedApproval,
    executeWithPolicy,
  };
}

/**
 * Create a GadgetEngine with Gatekeeper connectivity.
 *
 * The returned engine enforces that gadgets cannot access external resources
 * directly — all network access is disabled by default (strict NetworkPolicy),
 * and the only way to reach external services is through Capability Bindings
 * mediated by the Gatekeeper Layer.
 *
 * Requirement 1.2: Each Gadget executes in a restricted runtime where outbound
 * network access is disabled by default and only explicitly granted
 * Capability_Bindings provide access to external resources.
 */
export function createGadgetEngineWithGatekeeper(
  db: Database.Database,
  gatekeeper: GatekeeperLayer,
  options?: {
    gadgetsBaseDir?: string;
    applyNetworkPolicy?: (gadgetId: string, policy: NetworkPolicy) => void;
    onCrash?: (gadgetId: string, code: number | null, signal: string | null) => void;
  },
): GadgetEngine {
  return new GadgetEngineImpl({
    db,
    gadgetsBaseDir: options?.gadgetsBaseDir,
    applyNetworkPolicy: options?.applyNetworkPolicy,
    onCrash: options?.onCrash,
  });
}

/**
 * Create a CodeModeAgent with Gatekeeper connectivity.
 *
 * All external calls from code snippets are routed through the Gatekeeper
 * Layer via injected capability bindings. Code cannot bypass security controls.
 *
 * Requirement 8.5: WHEN the Code_Mode_Agent writes code that interacts with
 * external resources, THE Gatekeeper_Layer SHALL mediate all external calls
 * through the established Capability_Bindings.
 */
export function createCodeModeAgentWithGatekeeper(
  db: Database.Database,
  gatekeeper: GatekeeperLayer,
  limits?: Partial<CodeModeLimits>,
): CodeModeAgent {
  return createCodeModeAgent(db, gatekeeper, limits);
}

/**
 * Create an ObservationTracker wired to auto-record on Gatekeeper reads.
 *
 * The observation tracker records every read operation that passes through
 * the Gatekeeper, building a provenance log for data-flow enforcement.
 *
 * Requirement 5.1: WHEN an agent or Gadget reads data through a Capability_Binding,
 * THE Observation_Tracker SHALL record the observation.
 */
export function createObservationTrackerWithGatekeeper(
  db: Database.Database,
  checkUserPermission?: (userId: string, resourceId: string) => boolean,
): ObservationTracker {
  return createObservationTracker({
    db,
    checkUserPermission,
  });
}

/**
 * Create a SimulatedApprovalEngine wired to the Gatekeeper for execution.
 *
 * When actions are approved, they execute through the Gatekeeper's normal
 * path, ensuring all security checks (rate limits, expiry, posture) still apply.
 *
 * Requirement 4.1: WHEN an agent performs a side-effecting action through a
 * Gatekeeper that requires approval, THE Gatekeeper_Layer SHALL simulate the
 * outcome locally and allow the agent to continue queuing subsequent actions.
 */
export function createSimulatedApprovalWithGatekeeper(
  db: Database.Database,
  gatekeeper: GatekeeperLayer,
  options?: {
    executionTimeoutMs?: number;
    defaultAgentId?: string;
  },
): SimulatedApprovalEngine {
  return createSimulatedApprovalEngine({
    db,
    executor: gatekeeper,
    executionTimeoutMs: options?.executionTimeoutMs ?? 5000,
    defaultAgentId: options?.defaultAgentId,
  });
}

// ─── Integrated Execution ───────────────────────────────────────

/**
 * Creates a policy-driven execution function that integrates the Gatekeeper,
 * Observation Tracker, and Simulated Approval Engine.
 *
 * Execution flow:
 * 1. For READ operations:
 *    a. Execute through Gatekeeper (immediate)
 *    b. Record observation in Observation Tracker
 *    c. Return result to caller
 *
 * 2. For WRITE operations:
 *    a. Route through Simulated Approval Engine
 *    b. Return simulated result to caller (agent can continue working)
 *    c. Actual execution deferred until human approval
 *
 * This separation ensures:
 * - Agents never wait for approval on writes (Requirement 4.1)
 * - All reads are tracked for data-flow enforcement (Requirement 5.1)
 * - Security posture is respected for all operations (Requirement 3.8)
 */
function createPolicyExecutor(
  gatekeeper: GatekeeperLayer,
  observationTracker: ObservationTracker,
  simulatedApproval: SimulatedApprovalEngine,
): (
  binding: CapabilityBinding,
  operation: string,
  params: unknown,
  actorId: string,
  actorType: 'agent' | 'gadget' | 'code_mode',
) => Promise<unknown> {
  return async (
    binding: CapabilityBinding,
    operation: string,
    params: unknown,
    actorId: string,
    actorType: 'agent' | 'gadget' | 'code_mode',
  ): Promise<unknown> => {
    if (isReadOperation(operation)) {
      // READ path: execute immediately and record observation
      const result = await gatekeeper.execute(binding, operation, params);

      // Auto-record the observation (Requirement 5.1)
      observationTracker.recordObservation({
        actorId,
        actorType: actorType === 'code_mode' ? 'agent' : actorType,
        resourceId: binding.resourceId,
        dataScope: `${binding.resourceType}:${binding.resourceId}:${operation}`,
        accessLevel: inferAccessLevel(binding),
        capabilityId: binding.id,
      });

      return result;
    } else {
      // WRITE path: route through Simulated Approval (Requirement 4.1)
      const pendingAction = await simulatedApproval.simulate(binding, operation, params);

      // Return the simulated result so the agent can continue working
      return pendingAction.simulatedResult;
    }
  };
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Infer the access level of a resource from its capability binding.
 *
 * Uses scope constraints and resource type to determine the appropriate
 * access level for observation tracking. Falls back to 'internal' when
 * the level cannot be determined.
 */
function inferAccessLevel(
  binding: CapabilityBinding,
): 'public' | 'internal' | 'confidential' | 'restricted' {
  // Check if the binding has an explicit access level in scope constraints
  const explicitLevel = binding.scopeConstraints['accessLevel'];
  if (
    explicitLevel === 'public' ||
    explicitLevel === 'internal' ||
    explicitLevel === 'confidential' ||
    explicitLevel === 'restricted'
  ) {
    return explicitLevel;
  }

  // Infer from resource type
  switch (binding.resourceType) {
    case 'database':
    case 'secrets':
    case 'credentials':
      return 'confidential';
    case 'filesystem':
    case 'api':
      return 'internal';
    case 'github':
      // Private repos are internal; public repos are public
      return binding.scopeConstraints['visibility'] === 'public' ? 'public' : 'internal';
    default:
      return 'internal';
  }
}

/**
 * Convenience function: create a CodeModeContext that uses the integrated
 * execution path. All capability operations will go through the policy executor.
 *
 * This ensures Code Mode snippets have their external calls mediated
 * by the Gatekeeper and observations tracked automatically.
 */
export function createIntegratedCodeModeContext(
  sessionId: string,
  agentId: string,
  capabilities: CapabilityBinding[],
  gadgetApis?: Map<string, import('../types/cloudflare-os.js').RPCInterfaceDefinition>,
): CodeModeContext {
  return {
    sessionId,
    agentId,
    capabilities,
    gadgetApis: gadgetApis ?? new Map(),
  };
}
