/**
 * Subsystem Error Envelope — Structured error format for all Cloudflare OS subsystems.
 *
 * Provides a consistent error envelope used across Gadget Engine, Gatekeeper Layer,
 * Observation Tracker, Context Library, Workflow Engine, Code Mode Agent,
 * RPC Generator, Blueprint Registry, and Cost Router.
 *
 * Requirements: All
 */

// ─── Subsystem Identifiers ──────────────────────────────────────

/** All subsystems that produce structured errors */
export type SubsystemId =
  | 'gadget_engine'
  | 'blueprint_registry'
  | 'gatekeeper'
  | 'simulated_approval'
  | 'observation_tracker'
  | 'context_library'
  | 'workflow_engine'
  | 'code_mode'
  | 'rpc_generator'
  | 'cost_router';

// ─── Error Codes ────────────────────────────────────────────────

/** Well-known error codes by subsystem */
export type GadgetErrorCode =
  | 'GADGET_ISOLATION_FAILED'
  | 'GADGET_PROCESS_CRASHED'
  | 'GADGET_NOT_FOUND'
  | 'GADGET_ALREADY_RUNNING'
  | 'GADGET_NETWORK_POLICY_FAILED'
  | 'GADGET_STATE_CORRUPTED';

export type BlueprintErrorCode =
  | 'BLUEPRINT_NOT_FOUND'
  | 'BLUEPRINT_IMPORT_FAILED'
  | 'BLUEPRINT_CHECKSUM_MISMATCH'
  | 'BLUEPRINT_INVALID_ARCHIVE'
  | 'BLUEPRINT_VERSION_LIMIT_EXCEEDED';

export type GatekeeperErrorCode =
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_REVOKED'
  | 'CAPABILITY_NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'RESOURCE_NOT_INTRODUCED'
  | 'CREDENTIAL_NOT_FOUND';

export type SimulatedApprovalErrorCode =
  | 'ACTION_NOT_FOUND'
  | 'ACTION_ALREADY_RESOLVED'
  | 'SIMULATION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'DEPENDENCY_REJECTED';

export type ObservationErrorCode =
  | 'OBSERVATION_ACCESS_DENIED'
  | 'DATA_FLOW_VIOLATION'
  | 'PERMISSION_CHECK_FAILED';

export type ContextLibraryErrorCode =
  | 'CONTEXT_ENTRY_NOT_FOUND'
  | 'CONTEXT_TOKEN_BUDGET_EXCEEDED'
  | 'CONTEXT_SCOPE_INVALID';

export type WorkflowErrorCode =
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_VALIDATION_FAILED'
  | 'WORKFLOW_STEP_FAILED'
  | 'WORKFLOW_STEP_TIMEOUT'
  | 'WORKFLOW_ALREADY_RUNNING';

export type CodeModeErrorCode =
  | 'CODE_EXECUTION_TIMEOUT'
  | 'CODE_MEMORY_EXCEEDED'
  | 'CODE_RUNTIME_ERROR'
  | 'CODE_SNIPPET_LIMIT';

export type RPCGeneratorErrorCode =
  | 'RPC_GENERATION_FAILED'
  | 'RPC_VALIDATION_FAILED'
  | 'RPC_SOURCE_PARSE_ERROR';

export type CostRouterErrorCode =
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_NOT_FOUND'
  | 'NO_MODELS_AVAILABLE'
  | 'CLASSIFICATION_FAILED';

/** Union of all subsystem error codes */
export type SubsystemErrorCode =
  | GadgetErrorCode
  | BlueprintErrorCode
  | GatekeeperErrorCode
  | SimulatedApprovalErrorCode
  | ObservationErrorCode
  | ContextLibraryErrorCode
  | WorkflowErrorCode
  | CodeModeErrorCode
  | RPCGeneratorErrorCode
  | CostRouterErrorCode;

// ─── Error Envelope ─────────────────────────────────────────────

/** Structured error envelope used by all Cloudflare OS subsystems */
export interface SubsystemError {
  /** Error code identifying the specific failure */
  code: SubsystemErrorCode;
  /** Subsystem that produced the error */
  subsystem: SubsystemId;
  /** Human-readable description of the error */
  message: string;
  /** Subsystem-specific context and metadata */
  details?: Record<string, unknown>;
  /** Whether the error is recoverable without user intervention */
  recoverable: boolean;
  /** Suggested next action for the agent or user */
  suggestedAction?: string;
  /** ISO 8601 timestamp of when the error occurred */
  timestamp: string;
}

// ─── Error Factory ──────────────────────────────────────────────

/** Creates a SubsystemError with the current timestamp */
export function createSubsystemError(
  subsystem: SubsystemId,
  code: SubsystemErrorCode,
  message: string,
  options?: {
    details?: Record<string, unknown>;
    recoverable?: boolean;
    suggestedAction?: string;
  }
): SubsystemError {
  return {
    subsystem,
    code,
    message,
    details: options?.details,
    recoverable: options?.recoverable ?? false,
    suggestedAction: options?.suggestedAction,
    timestamp: new Date().toISOString(),
  };
}

/** Type guard to check if an unknown error is a SubsystemError */
export function isSubsystemError(error: unknown): error is SubsystemError {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.subsystem === 'string' &&
    typeof e.message === 'string' &&
    typeof e.timestamp === 'string' &&
    typeof e.recoverable === 'boolean'
  );
}
