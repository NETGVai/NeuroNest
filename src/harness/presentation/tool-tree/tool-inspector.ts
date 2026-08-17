/**
 * Tool Inspector — Bounded redacted inspection with authority-routed actions.
 *
 * Responsibilities:
 * - Expose bounded redacted arguments/output within configured byte/line limits
 * - Track attempt history with typed failures and retry eligibility
 * - Expose spill ranges for oversized output
 * - Provide authorized source/citation actions routed through owning authorities
 * - Preserve selection and focus when actions become unavailable
 * - Omit secrets, protected content, private paths, and unauthorized locators
 *
 * Requirements: 37.3, 37.4, 37.7–37.13, 37.16, 37.17
 */

import type {
  ToolInspectionV1,
  ToolInspectionQuery,
  AuthorizedAction,
  SpillRangeRef,
  TypedFailure,
  InspectorSelection,
} from './tool-tree-schemas';

// ─── Content Redaction ──────────────────────────────────────────

/**
 * Patterns that must be redacted from inspector output.
 * Matches secrets, private paths, and unauthorized locators.
 *
 * Requirements: 37.9, 37.17
 */
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string; reason: string }> = [
  {
    pattern: /(?:password|secret|token|api[_-]?key|private[_-]?key|credential)"?\s*[:=]\s*"?[^\s",}]+/gi,
    replacement: '[REDACTED:secret]',
    reason: 'Secret value detected',
  },
  {
    pattern: /(?:\/etc\/(?:shadow|passwd|sudoers)|~\/\.[^\s]+|\/home\/[^/]+\/\.[^\s]+|\\Users\\[^\\]+\\AppData[^\s]*)/g,
    replacement: '[REDACTED:private-path]',
    reason: 'Private path detected',
  },
  {
    pattern: /(?:file:\/\/\/[^\s]+|\\\\[^\\]+\\[^\s]+|\/proc\/[^\s]+|\/dev\/[^\s]+)/g,
    replacement: '[REDACTED:locator]',
    reason: 'Unauthorized locator detected',
  },
];

/**
 * Redact sensitive content from a string.
 * Returns the redacted string and whether any redaction was applied.
 */
function redactContent(content: string): { redacted: string; wasRedacted: boolean; reason: string | undefined } {
  let result = content;
  let wasRedacted = false;
  let reason: string | undefined;

  for (const { pattern, replacement, reason: patternReason } of REDACTION_PATTERNS) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) {
      wasRedacted = true;
      reason = reason ?? patternReason;
    }
  }

  return { redacted: result, wasRedacted, reason };
}

/**
 * Truncate content to byte and line bounds.
 * Returns the truncated content and whether truncation occurred.
 */
function boundContent(
  content: string,
  maxBytes?: number,
  maxLines?: number,
): { bounded: string; truncated: boolean; byteSize: number } {
  let result = content;
  let truncated = false;

  // Apply line bound
  if (maxLines !== undefined && maxLines > 0) {
    const lines = result.split('\n');
    if (lines.length > maxLines) {
      result = lines.slice(0, maxLines).join('\n');
      truncated = true;
    }
  }

  // Apply byte bound
  const encoder = new TextEncoder();
  if (maxBytes !== undefined && maxBytes > 0) {
    const encoded = encoder.encode(result);
    if (encoded.length > maxBytes) {
      // Truncate to maxBytes, respecting UTF-8 boundaries
      const decoder = new TextDecoder('utf-8', { fatal: false });
      result = decoder.decode(encoded.slice(0, maxBytes));
      truncated = true;
    }
  }

  const byteSize = encoder.encode(result).length;
  return { bounded: result, truncated, byteSize };
}

// ─── Authority Port ─────────────────────────────────────────────

/**
 * Port for checking action availability with the owning authority.
 * The inspector routes all actions through this interface.
 */
export interface AuthorityActionPort {
  /**
   * Check if a file-open action is available for the given reference.
   * Returns the authorized action or null if unavailable.
   */
  checkFileAction(params: {
    callId: string;
    filePath: string;
    owner: string;
  }): Promise<AuthorizedAction | null>;

  /**
   * Check if a citation action is available.
   * Routes through Web_Retrieval_Service.
   */
  checkCitationAction(params: {
    callId: string;
    url: string;
    owner: string;
  }): Promise<AuthorizedAction | null>;

  /**
   * Check if spill retrieval is authorized.
   * Routes through Tool_Spill_Service.
   */
  checkSpillAction(params: {
    callId: string;
    spillId: string;
    owner: string;
  }): Promise<AuthorizedAction | null>;

  /**
   * Check if retry is available for the call.
   */
  checkRetryAction(params: {
    callId: string;
    owner: string;
  }): Promise<AuthorizedAction | null>;
}

// ─── Call Data Source ────────────────────────────────────────────

/**
 * Data source for tool call inspection data.
 */
export interface ToolCallDataSource {
  /** Get the raw arguments for a call (before redaction). */
  getArguments(callId: string): Promise<string | null>;
  /** Get the raw output for a call (before redaction). */
  getOutput(callId: string, resultId?: string): Promise<string | null>;
  /** Get the output retained status. */
  getOutputStatus(callId: string): Promise<'retained' | 'spilled' | 'discarded' | 'pending'>;
  /** Get spill reference if output was spilled. */
  getSpillRange(callId: string): Promise<SpillRangeRef | null>;
  /** Get attempt history for a call. */
  getAttemptHistory(callId: string): Promise<Array<{
    attempt: number;
    status: 'planned' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'retrying';
    durationMs: number | null;
    failure?: TypedFailure;
    timestamp: string;
  }>>;
  /** Get call metadata. */
  getCallMetadata(callId: string): Promise<{
    toolDisplayName: string;
    riskClass: 'read-only' | 'idempotent-write' | 'write' | 'execute' | 'destructive';
    owner: string;
    durationMs: number | null;
    attempt: number;
    failure?: TypedFailure;
    renderIntent?: unknown;
    fileRefs?: string[];
    citationUrls?: string[];
  } | null>;
}

// ─── Inspector Configuration ────────────────────────────────────

export interface ToolInspectorConfig {
  /** Default maximum bytes for argument preview. */
  defaultMaxArgumentBytes: number;
  /** Default maximum lines for argument preview. */
  defaultMaxArgumentLines: number;
  /** Default maximum bytes for output preview. */
  defaultMaxOutputBytes: number;
  /** Default maximum lines for output preview. */
  defaultMaxOutputLines: number;
}

const DEFAULT_INSPECTOR_CONFIG: ToolInspectorConfig = {
  defaultMaxArgumentBytes: 8192,
  defaultMaxArgumentLines: 100,
  defaultMaxOutputBytes: 16384,
  defaultMaxOutputLines: 200,
};

// ─── Tool Inspector ─────────────────────────────────────────────

/**
 * Produces bounded redacted inspection data for a selected tool call.
 * All actions are routed through the owning authority.
 */
export class ToolInspector {
  private readonly config: ToolInspectorConfig;
  private readonly dataSource: ToolCallDataSource;
  private readonly authorityPort: AuthorityActionPort;

  constructor(
    dataSource: ToolCallDataSource,
    authorityPort: AuthorityActionPort,
    config: Partial<ToolInspectorConfig> = {},
  ) {
    this.config = { ...DEFAULT_INSPECTOR_CONFIG, ...config };
    this.dataSource = dataSource;
    this.authorityPort = authorityPort;
  }

  /**
   * Inspect a tool call. Returns bounded, redacted inspection data
   * with authorized actions routed through owning authorities.
   *
   * Requirements: 37.7–37.13, 37.16, 37.17
   */
  async inspect(query: ToolInspectionQuery): Promise<ToolInspectionV1 | null> {
    const metadata = await this.dataSource.getCallMetadata(query.callId);
    if (!metadata) {
      return null;
    }

    // Build selection
    const selection: InspectorSelection = {
      callId: query.callId,
      resultId: query.resultId,
      sourceSequence: query.sourceSequence,
    };

    // Get and bound arguments (Requirement 37.3)
    const rawArguments = await this.dataSource.getArguments(query.callId);
    let redactedArguments: string | null = null;
    let argumentsTruncated = false;
    let argumentsPreviewBytes = 0;
    let redactionReason: string | undefined;

    if (rawArguments !== null) {
      const { redacted, wasRedacted, reason } = redactContent(rawArguments);
      if (wasRedacted) {
        redactionReason = reason;
      }
      const maxBytes = query.maxArgumentBytes ?? this.config.defaultMaxArgumentBytes;
      const maxLines = query.maxArgumentLines ?? this.config.defaultMaxArgumentLines;
      const { bounded, truncated, byteSize } = boundContent(redacted, maxBytes, maxLines);
      redactedArguments = bounded;
      argumentsTruncated = truncated;
      argumentsPreviewBytes = byteSize;
    }

    // Get and bound output (Requirement 37.4)
    const rawOutput = await this.dataSource.getOutput(query.callId, query.resultId);
    let redactedOutput: string | null = null;
    let outputTruncated = false;
    let outputPreviewBytes = 0;

    if (rawOutput !== null) {
      const { redacted, wasRedacted, reason } = redactContent(rawOutput);
      if (wasRedacted && !redactionReason) {
        redactionReason = reason;
      }
      const maxBytes = query.maxOutputBytes ?? this.config.defaultMaxOutputBytes;
      const maxLines = query.maxOutputLines ?? this.config.defaultMaxOutputLines;
      const { bounded, truncated, byteSize } = boundContent(redacted, maxBytes, maxLines);
      redactedOutput = bounded;
      outputTruncated = truncated;
      outputPreviewBytes = byteSize;
    }

    // Get output status and spill (Requirement 37.8)
    const outputRetainedStatus = await this.dataSource.getOutputStatus(query.callId);
    const spillRange = await this.dataSource.getSpillRange(query.callId);

    // Get attempt history (Requirement 37.13)
    const attemptHistory = await this.dataSource.getAttemptHistory(query.callId);

    // Build authorized actions (Requirements 37.10, 37.11)
    const authorizedActions = await this.buildAuthorizedActions(
      query.callId,
      metadata,
      spillRange,
    );

    return {
      selection,
      toolDisplayName: metadata.toolDisplayName,
      redactedArguments,
      argumentsTruncated,
      argumentsPreviewBytes,
      redactedOutput,
      outputTruncated,
      outputPreviewBytes,
      outputRetainedStatus,
      spillRange: spillRange ?? undefined,
      attempt: metadata.attempt,
      attemptHistory,
      riskClass: metadata.riskClass,
      owner: metadata.owner,
      durationMs: metadata.durationMs,
      redactionReason,
      authorizedActions,
      failure: metadata.failure,
      renderIntent: metadata.renderIntent as ToolInspectionV1['renderIntent'],
      schemaVersion: 1,
    };
  }

  /**
   * Build authorized actions by checking each potential action with the owning authority.
   * Actions that are unavailable are still included with available=false and a redacted reason.
   *
   * Requirements: 37.10, 37.11, 37.16
   */
  private async buildAuthorizedActions(
    callId: string,
    metadata: NonNullable<Awaited<ReturnType<ToolCallDataSource['getCallMetadata']>>>,
    spillRange: SpillRangeRef | null,
  ): Promise<AuthorizedAction[]> {
    const actions: AuthorizedAction[] = [];

    // File actions (Requirement 37.10)
    if (metadata.fileRefs && metadata.fileRefs.length > 0) {
      for (const filePath of metadata.fileRefs) {
        const action = await this.authorityPort.checkFileAction({
          callId,
          filePath,
          owner: metadata.owner,
        });
        if (action) {
          actions.push(action);
        } else {
          actions.push({
            actionId: `file-${callId}-${filePath}`,
            kind: 'open_file',
            label: `Open file`,
            authority: 'filesystem-authority',
            available: false,
            unavailableReason: 'File action unavailable',
          });
        }
      }
    }

    // Citation actions (Requirement 37.11)
    if (metadata.citationUrls && metadata.citationUrls.length > 0) {
      for (const url of metadata.citationUrls) {
        const action = await this.authorityPort.checkCitationAction({
          callId,
          url,
          owner: metadata.owner,
        });
        if (action) {
          actions.push(action);
        } else {
          actions.push({
            actionId: `citation-${callId}-${url}`,
            kind: 'citation',
            label: `View citation`,
            authority: 'web-retrieval-service',
            available: false,
            unavailableReason: 'Citation unavailable',
          });
        }
      }
    }

    // Spill retrieval action (Requirement 37.8)
    if (spillRange && spillRange.available) {
      const action = await this.authorityPort.checkSpillAction({
        callId,
        spillId: spillRange.spillId,
        owner: metadata.owner,
      });
      if (action) {
        actions.push(action);
      } else {
        actions.push({
          actionId: `spill-${callId}`,
          kind: 'spill_retrieve',
          label: 'Retrieve full output',
          authority: 'tool-spill-service',
          available: false,
          unavailableReason: 'Spill retrieval unavailable',
        });
      }
    }

    // Retry action (Requirement 37.13)
    if (metadata.failure && metadata.failure.retryEligible) {
      const action = await this.authorityPort.checkRetryAction({
        callId,
        owner: metadata.owner,
      });
      if (action) {
        actions.push(action);
      } else {
        actions.push({
          actionId: `retry-${callId}`,
          kind: 'retry',
          label: 'Retry',
          authority: 'tool-execution-pipeline',
          available: false,
          unavailableReason: 'Retry unavailable',
        });
      }
    }

    return actions;
  }
}
