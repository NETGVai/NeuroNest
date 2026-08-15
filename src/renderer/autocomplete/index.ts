/**
 * Renderer autocomplete module — barrel export.
 *
 * Provides the complete renderer-side autocomplete integration:
 * - InlineCompletionsProvider: Monaco provider with ghost-text
 * - GhostTextDecorator: Visual ghost-text rendering
 * - StatusBarIndicator: Status bar UI component
 * - AutocompleteIpcClient: IPC communication with main process
 *
 * Requirements: 1.2, 1.3, 1.7
 */

export {
  InlineCompletionsProvider,
  createInlineCompletionsProvider,
  type InlineCompletionItem,
  type InlineCompletions,
  type InlineCompletionContext,
  type CancellationToken,
  type InlineCompletionsProviderConfig,
} from './inline-completions-provider';

export {
  GhostTextDecorator,
  GHOST_TEXT_CLASS,
  GHOST_TEXT_STYLES,
  type MonacoEditor,
  type MonacoKeyCodes,
  type MonacoPosition,
  type MonacoRange,
  type MonacoDecoration,
  type GhostTextState,
} from './ghost-text-decorator';

export {
  StatusBarIndicator,
  STATUS_BAR_STYLES,
  type StatusBarClickHandler,
} from './status-bar-indicator';

export {
  AutocompleteIpcClient,
  getAutocompleteIpcClient,
  resetAutocompleteIpcClient,
  type CompletionRequestPayload,
  type CompletionResponse,
  type AutocompleteStatus,
  type AutocompleteConfig,
} from './autocomplete-ipc-client';

export {
  CompletionController,
  ContentIdentityCache,
  type ModelRole,
  type ModelRoleConfig,
  type WorkspaceCompletionConfig,
  type CompletionRequestEnvelope,
  type CompletionResult,
  type CancellationReason,
} from './completion-controller';

export {
  CompletionRenderer,
  type RenderMode,
  type RenderedCompletion,
  type InlineDiffMarker,
} from './completion-renderer';

export {
  CompletionControlsService,
  type CompletionAction,
  type ControlActionResult,
  type KeyBindingConfig,
  type RegenerationRequest,
  type PendingCompletion,
} from './completion-controls-service';

export {
  ContextAuthorizationGuard,
  type ContextItem,
  type AuthorizationPolicy,
  type AuthorizationResult,
  type StructuralContext,
  type AuthorizedPayload,
} from './context-authorization-guard';

export {
  CompletionMetrics,
  type CompletionOutcome,
  type CompletionMetricRecord,
  type MetricsSummary,
  type MetricsConfig,
} from './completion-metrics';
