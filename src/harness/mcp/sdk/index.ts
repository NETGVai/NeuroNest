/**
 * MCP SDK — Public API
 *
 * Exports the typed client SDK and schema definitions for the two
 * MCP server namespaces. Protocol-internal types (JSON-RPC envelopes,
 * transport internals) are NOT re-exported from this barrel.
 *
 * Requirements: 25.1, 30.9–30.10, 32.1–32.5
 */

// ─── Typed Client SDK ───────────────────────────────────────────

export { SessionMcpClient } from './session-client';
export type {
  AppendEventParams,
  AppendEventResult,
  ReadEventsParams,
  ReadEventsResult,
  VerifyEventsParams,
  VerifyEventsResult,
  ForkSessionParams,
  ForkSessionResult,
  ResumeSessionParams,
  ResumeSessionResult,
  TimelineQueryParams,
  TimelineQueryResult,
  HeaderQueryParams,
  HeaderQueryResult,
  InsightsQueryParams,
  InsightsQueryResult,
  WorkbenchQueryParams,
  WorkbenchQueryResult,
  TrajectoryQueryParams,
  TrajectoryQueryResult,
  SearchParams,
  SearchResult,
  ExportParams,
  ExportResult,
  CompactionPlanParams,
  CompactionPlanResult,
  CompactionCommitParams,
  CompactionCommitResult,
  SpillReadRangeParams,
  SpillReadRangeResult,
  AttachmentPrepareParams,
  AttachmentPrepareResult,
  AttachmentCommitParams,
  AttachmentCommitResult,
  AttachmentReadRangeParams,
  AttachmentReadRangeResult,
  GoalCreateParams,
  GoalCreateResult,
  GoalUpdateParams,
  GoalUpdateResult,
  GoalListParams,
  GoalListResult,
  SessionHealthResult,
} from './session-client';

export { RuntimeMcpClient } from './runtime-client';
export type {
  CapabilitiesListParams,
  CapabilityEntry,
  CapabilitiesListResult,
  CapabilityResolveParams,
  CapabilityResolveResult,
  PromptsAssembleParams,
  PromptsAssembleResult,
  PromptsReconstructParams,
  PromptsReconstructResult,
  TurnsSubmitParams,
  TurnsSubmitResult,
  TurnsCancelParams,
  TurnsCancelResult,
  TurnsResumeParams,
  TurnsResumeResult,
  QueueMutateParams,
  QueueMutateResult,
  ToolsDescribeParams,
  ToolDescriptor,
  ToolsDescribeResult,
  ToolsExecuteParams,
  ToolsExecuteResult,
  ToolsInspectParams,
  ToolsInspectResult,
  ProvidersResolveParams,
  ProvidersResolveResult,
  ProvidersStreamParams,
  ProvidersStreamResult,
  CollaborationDecideParams,
  CollaborationDecideResult,
  SubagentsLaunchParams,
  SubagentsLaunchResult,
  SubagentsCancelParams,
  SubagentsCancelResult,
  SubagentsStatusParams,
  SubagentsStatusResult,
  WorkflowsStartParams,
  WorkflowsStartResult,
  WorkflowsStepParams,
  WorkflowsStepResult,
  WorkflowsCancelParams,
  WorkflowsCancelResult,
  WorkflowsStatusParams,
  WorkflowsStatusResult,
  JobsSubmitParams,
  JobsSubmitResult,
  JobsCancelParams,
  JobsCancelResult,
  JobsStatusParams,
  JobsStatusResult,
  ProfilesPreviewParams,
  ProfilesPreviewResult,
  ProfilesActivateParams,
  ProfilesActivateResult,
  ExecutionRunParams,
  ExecutionRunResult,
  RuntimeHealthResult,
} from './runtime-client';

// ─── Protocol Capabilities ──────────────────────────────────────

export {
  SESSION_SERVER_INFO,
  SESSION_SERVER_CAPABILITIES,
  RUNTIME_SERVER_INFO,
  RUNTIME_SERVER_CAPABILITIES,
} from './protocol-capabilities';
export type {
  McpCapability,
  ServerInfo,
  ServerHealth,
  InitializeParams,
  InitializeResult,
} from './protocol-capabilities';

// ─── Protocol Errors ────────────────────────────────────────────

export {
  McpErrorCode,
  createMethodNotFoundError,
  createUnsupportedVersionError,
  createDatabaseUnavailableError,
  createSchemaIncompatibleError,
  createDrainingError,
  createNotReadyError,
} from './protocol-errors';
export type {
  McpAlternative,
  McpStructuredError,
  McpErrorCodeValue,
} from './protocol-errors';

// ─── Schema Registries (for validation) ─────────────────────────

export { SESSION_METHODS, SESSION_NAMESPACE } from './session-schemas';
export type { SessionMethodName } from './session-schemas';

export { RUNTIME_METHODS, RUNTIME_NAMESPACE } from './runtime-schemas';
export type { RuntimeMethodName } from './runtime-schemas';

// ─── Transport (exposed for DI/testing, not protocol types) ─────

export { StdioTransport, McpTransportError } from './stdio-transport';
export type { StdioTransportOptions } from './stdio-transport';
