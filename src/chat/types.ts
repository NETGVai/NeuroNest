/**
 * Types for the Chat Header, Structured Composer, and Context Item services.
 *
 * These types support:
 * - Authoritative chat header (project, session, agent/orchestrator, model,
 *   autonomy, context usage, cost/budget, connection status)
 * - Structured composer (text, command, code, mention modalities with
 *   boundary validation, multiline modes, history, branching)
 * - Context item store (typed versioned references)
 *
 * Requirements: 15.10, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10
 */

// ─── Header Types ──────────────────────────────────────────────

/**
 * Source attribution for a derived read-only field.
 * Indicates where the header value originates so the UI can render it
 * as non-editable with source decoration.
 */
export interface SourceAttribution {
  readonly source:
    | 'provider-registry'
    | 'session'
    | 'run-coordinator'
    | 'model-config'
    | 'context-service'
    | 'cost-service'
    | 'workspace';
  readonly label: string;
}

/**
 * A single header field with its value and read-only source.
 */
export interface HeaderField<T = string> {
  readonly value: T;
  readonly readOnly: boolean;
  readonly attribution: SourceAttribution;
}

/**
 * The complete read-only header view model. All fields are derived
 * from runtime data and are not independently editable.
 *
 * Shows: project, session, agent/orchestrator, model, autonomy,
 * context usage, cost/budget, and connection status.
 */
export interface HeaderViewModel {
  readonly project: HeaderField;
  readonly provider: HeaderField;
  readonly modelRole: HeaderField;
  readonly autonomyMode: HeaderField;
  readonly contextTokenCount: HeaderField<number>;
  readonly contextLimit: HeaderField<number>;
  readonly costUsage: HeaderField<number>;
  readonly costBudget: HeaderField<number> | null;
  readonly connectionStatus: HeaderField;
  readonly sessionLink: HeaderField;
  readonly agentOrOrchestrator: HeaderField | null;
  readonly taskAssociation: HeaderField | null;
  readonly runAssociation: HeaderField | null;
}

/**
 * Runtime data sources used to derive the header view model.
 */
export interface HeaderRuntimeData {
  readonly providerName: string;
  readonly providerId: string;
  readonly modelRole: string;
  readonly contextTokenCount: number;
  readonly contextLimit?: number | undefined;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly projectName?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly autonomyMode?: string | undefined;
  readonly costUsage?: number | undefined;
  readonly costBudget?: number | undefined;
  readonly connectionStatus?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentId?: string | undefined;
  readonly orchestratorId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly taskTitle?: string | undefined;
  readonly runId?: string | undefined;
  readonly runStatus?: string | undefined;
}

// ─── Composer Types ────────────────────────────────────────────

/**
 * Supported input modalities for the structured composer.
 */
export type InputModality = 'text' | 'command' | 'code' | 'mention';

/**
 * Composer mode for explicit behavior selection.
 */
export type ComposerMode = 'ask' | 'plan' | 'edit' | 'agent';

/**
 * A single input segment within the composer.
 */
export interface ComposerInput {
  readonly modality: InputModality;
  readonly content: string;
}

/**
 * Validation severity levels.
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * A single validation issue.
 */
export interface ValidationIssue {
  readonly modality: InputModality;
  readonly severity: ValidationSeverity;
  readonly message: string;
  readonly index: number;
}

/**
 * Result of validating composer inputs at the boundary.
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Context state affecting which modalities are available.
 */
export interface ComposerContext {
  readonly entityStoreLoaded: boolean;
  readonly activeSessionExists: boolean;
  readonly providerConnected: boolean;
}

/**
 * Declares which modalities are available and why.
 */
export interface ModalityDeclaration {
  readonly modality: InputModality;
  readonly available: boolean;
  readonly reason?: string | undefined;
}

// ─── Composer History and Branching Types ───────────────────────

/**
 * An entry in the composer prompt history.
 */
export interface HistoryEntry {
  readonly id: string;
  readonly content: string;
  readonly mode: ComposerMode;
  readonly timestamp: number;
  /** If this was a branch edit, the parent entry it branched from */
  readonly parentId?: string;
}

/**
 * Context resolution progress state for responsive send.
 */
export interface ContextResolutionProgress {
  /** Number of items that have been resolved */
  resolvedCount: number;
  /** Total number of items being resolved */
  totalCount: number;
  /** Whether resolution is currently in progress */
  inProgress: boolean;
  /** Whether a cancellation has been requested */
  cancellationRequested: boolean;
  /** Current item being resolved (for display) */
  currentItemLabel?: string;
}
