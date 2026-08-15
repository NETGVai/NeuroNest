/**
 * CodeActionService — Source-aware code actions for code blocks in chat responses.
 *
 * Provides: Copy, Insert at Cursor, Open as File, Apply to File, and
 * Create Change_Set actions. All actions require explicit target URIs;
 * they never infer the currently active file when the target is ambiguous.
 *
 * Requirements: 17.2, 17.3, 17.8
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Supported code action kinds.
 */
export type CodeActionKind =
  | 'copy'
  | 'insert_at_cursor'
  | 'open_as_file'
  | 'apply_to_file'
  | 'create_change_set';

/**
 * A source-aware code action associated with a code block.
 */
export interface CodeAction {
  readonly id: string;
  readonly kind: CodeActionKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly targetUri?: string | undefined;
  readonly sourceBlockId: string;
  readonly disabledReason?: string | undefined;
}

/**
 * Context for a code block that determines which actions are available.
 */
export interface CodeBlockContext {
  readonly blockId: string;
  readonly language: string;
  readonly content: string;
  readonly sourceUri?: string | undefined;
  readonly sourceVersion?: string | undefined;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
}

/**
 * Target resolution result for Apply and Change_Set actions.
 */
export interface TargetResolution {
  readonly resolved: boolean;
  readonly targetUri?: string | undefined;
  readonly ambiguous: boolean;
  readonly candidates?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

/**
 * The result of executing a code action.
 */
export interface CodeActionResult {
  readonly success: boolean;
  readonly actionId: string;
  readonly kind: CodeActionKind;
  readonly targetUri?: string | undefined;
  readonly error?: CodeActionError | undefined;
}

/**
 * Error info when a code action fails.
 */
export interface CodeActionError {
  readonly code: 'no_target' | 'ambiguous_target' | 'stale_version' | 'missing_file' | 'permission_denied' | 'execution_failed';
  readonly message: string;
  readonly recoveryOptions?: readonly RecoveryOption[] | undefined;
}

/**
 * A recovery option offered when a code action fails.
 */
export interface RecoveryOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'rebase' | 'retarget' | 'regenerate';
  readonly description: string;
}

/**
 * Delegate for performing actual editor/workspace operations.
 * Allows the service to remain testable without depending on Monaco or IPC.
 */
export interface CodeActionDelegate {
  copyToClipboard(content: string): Promise<boolean>;
  insertAtCursor(targetUri: string, content: string): Promise<boolean>;
  openFile(uri: string, options?: { line?: number; column?: number }): Promise<boolean>;
  applyToFile(targetUri: string, content: string, baseVersion?: string): Promise<boolean>;
  createChangeSet(targetUri: string, content: string, metadata?: { taskId?: string; runId?: string }): Promise<string | null>;
  checkFileExists(uri: string): Promise<boolean>;
  checkFileVersion(uri: string): Promise<string | null>;
}

// ─── Service ────────────────────────────────────────────────────

function generateActionId(): string {
  return `action-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CodeActionService {
  private readonly delegate: CodeActionDelegate;
  private readonly executedActions: Map<string, CodeActionResult> = new Map();

  constructor(delegate: CodeActionDelegate) {
    this.delegate = delegate;
  }

  /**
   * Get all available code actions for a code block context.
   * Copy is always available. Other actions depend on target availability.
   */
  getAvailableActions(context: CodeBlockContext): readonly CodeAction[] {
    const actions: CodeAction[] = [];
    const hasExplicitTarget = !!context.sourceUri && context.sourceUri.trim() !== '';
    const targetUri = hasExplicitTarget ? context.sourceUri : undefined;

    // Copy is always available
    actions.push({
      id: generateActionId(),
      kind: 'copy',
      label: 'Copy',
      enabled: true,
      sourceBlockId: context.blockId,
    });

    // Insert at Cursor requires a known target URI
    actions.push({
      id: generateActionId(),
      kind: 'insert_at_cursor',
      label: 'Insert at Cursor',
      enabled: hasExplicitTarget,
      ...(targetUri !== undefined ? { targetUri } : {}),
      sourceBlockId: context.blockId,
      ...(hasExplicitTarget ? {} : { disabledReason: 'No explicit target file. Select a target to insert.' }),
    });

    // Open as File — available if sourceUri exists
    actions.push({
      id: generateActionId(),
      kind: 'open_as_file',
      label: 'Open as File',
      enabled: hasExplicitTarget,
      ...(targetUri !== undefined ? { targetUri } : {}),
      sourceBlockId: context.blockId,
      ...(hasExplicitTarget ? {} : { disabledReason: 'No source file specified.' }),
    });

    // Apply to File — requires explicit target URI (R17.3: never infer active file)
    actions.push({
      id: generateActionId(),
      kind: 'apply_to_file',
      label: 'Apply to File',
      enabled: hasExplicitTarget,
      ...(targetUri !== undefined ? { targetUri } : {}),
      sourceBlockId: context.blockId,
      ...(hasExplicitTarget ? {} : { disabledReason: 'Explicit target file required. Cannot infer from active editor.' }),
    });

    // Create Change_Set — requires explicit target URI
    actions.push({
      id: generateActionId(),
      kind: 'create_change_set',
      label: 'Create Change_Set',
      enabled: hasExplicitTarget,
      ...(targetUri !== undefined ? { targetUri } : {}),
      sourceBlockId: context.blockId,
      ...(hasExplicitTarget ? {} : { disabledReason: 'Explicit target file required to create a Change_Set.' }),
    });

    return actions;
  }

  /**
   * Execute a code action.
   * Returns a CodeActionResult with success/failure and recovery options for failures.
   */
  async execute(
    action: CodeAction,
    context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const result = await this.executeInternal(action, context);
    this.executedActions.set(action.id, result);
    return result;
  }

  /**
   * Resolve an explicit target for actions that require one.
   * If sourceUri is present and unambiguous, returns it. Otherwise reports ambiguity.
   */
  resolveTarget(context: CodeBlockContext, userSelectedUri?: string): TargetResolution {
    // User selection takes priority
    if (userSelectedUri && userSelectedUri.trim() !== '') {
      return { resolved: true, targetUri: userSelectedUri, ambiguous: false };
    }

    // Source URI from context
    if (context.sourceUri && context.sourceUri.trim() !== '') {
      return { resolved: true, targetUri: context.sourceUri, ambiguous: false };
    }

    // No target available — ambiguous (R17.3)
    return {
      resolved: false,
      ambiguous: true,
      reason: 'No explicit target URI provided. Select a target file to proceed.',
    };
  }

  /**
   * Get the result of a previously executed action.
   */
  getResult(actionId: string): CodeActionResult | undefined {
    return this.executedActions.get(actionId);
  }

  /**
   * Clear executed action history.
   */
  clear(): void {
    this.executedActions.clear();
  }

  // ─── Private ──────────────────────────────────────────────────

  private async executeInternal(
    action: CodeAction,
    context: CodeBlockContext
  ): Promise<CodeActionResult> {
    if (!action.enabled) {
      return {
        success: false,
        actionId: action.id,
        kind: action.kind,
        error: {
          code: 'no_target',
          message: action.disabledReason ?? 'Action is disabled.',
        },
      };
    }

    switch (action.kind) {
      case 'copy':
        return this.executeCopy(action, context);
      case 'insert_at_cursor':
        return this.executeInsertAtCursor(action, context);
      case 'open_as_file':
        return this.executeOpenAsFile(action, context);
      case 'apply_to_file':
        return this.executeApplyToFile(action, context);
      case 'create_change_set':
        return this.executeCreateChangeSet(action, context);
      default:
        return {
          success: false,
          actionId: action.id,
          kind: action.kind,
          error: { code: 'execution_failed', message: `Unknown action kind: ${action.kind}` },
        };
    }
  }

  private async executeCopy(
    action: CodeAction,
    context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const success = await this.delegate.copyToClipboard(context.content);
    return { success, actionId: action.id, kind: 'copy' };
  }

  private async executeInsertAtCursor(
    action: CodeAction,
    _context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const targetUri = action.targetUri;
    if (!targetUri) {
      return {
        success: false,
        actionId: action.id,
        kind: 'insert_at_cursor',
        error: { code: 'no_target', message: 'No target URI for insertion.' },
      };
    }

    const exists = await this.delegate.checkFileExists(targetUri);
    if (!exists) {
      return {
        success: false,
        actionId: action.id,
        kind: 'insert_at_cursor',
        targetUri,
        error: {
          code: 'missing_file',
          message: `File not found: ${targetUri}`,
          recoveryOptions: this.buildRecoveryOptions(),
        },
      };
    }

    const success = await this.delegate.insertAtCursor(targetUri, _context.content);
    return { success, actionId: action.id, kind: 'insert_at_cursor', targetUri };
  }

  private async executeOpenAsFile(
    action: CodeAction,
    _context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const targetUri = action.targetUri;
    if (!targetUri) {
      return {
        success: false,
        actionId: action.id,
        kind: 'open_as_file',
        error: { code: 'no_target', message: 'No file URI to open.' },
      };
    }

    const exists = await this.delegate.checkFileExists(targetUri);
    if (!exists) {
      return {
        success: false,
        actionId: action.id,
        kind: 'open_as_file',
        targetUri,
        error: {
          code: 'missing_file',
          message: `File not found: ${targetUri}`,
          recoveryOptions: this.buildRecoveryOptions(),
        },
      };
    }

    const success = await this.delegate.openFile(targetUri);
    return { success, actionId: action.id, kind: 'open_as_file', targetUri };
  }

  private async executeApplyToFile(
    action: CodeAction,
    context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const targetUri = action.targetUri;
    if (!targetUri) {
      return {
        success: false,
        actionId: action.id,
        kind: 'apply_to_file',
        error: {
          code: 'no_target',
          message: 'Explicit target file required. Cannot infer from active editor.',
        },
      };
    }

    // Check file exists
    const exists = await this.delegate.checkFileExists(targetUri);
    if (!exists) {
      return {
        success: false,
        actionId: action.id,
        kind: 'apply_to_file',
        targetUri,
        error: {
          code: 'missing_file',
          message: `Target file not found: ${targetUri}`,
          recoveryOptions: this.buildRecoveryOptions(),
        },
      };
    }

    // Check version staleness (R17.8)
    if (context.sourceVersion) {
      const currentVersion = await this.delegate.checkFileVersion(targetUri);
      if (currentVersion !== null && currentVersion !== context.sourceVersion) {
        return {
          success: false,
          actionId: action.id,
          kind: 'apply_to_file',
          targetUri,
          error: {
            code: 'stale_version',
            message: `File version mismatch. Expected: ${context.sourceVersion}, Current: ${currentVersion}`,
            recoveryOptions: this.buildStaleRecoveryOptions(),
          },
        };
      }
    }

    const success = await this.delegate.applyToFile(
      targetUri,
      context.content,
      context.sourceVersion
    );
    return { success, actionId: action.id, kind: 'apply_to_file', targetUri };
  }

  private async executeCreateChangeSet(
    action: CodeAction,
    context: CodeBlockContext
  ): Promise<CodeActionResult> {
    const targetUri = action.targetUri;
    if (!targetUri) {
      return {
        success: false,
        actionId: action.id,
        kind: 'create_change_set',
        error: {
          code: 'no_target',
          message: 'Explicit target file required to create a Change_Set.',
        },
      };
    }

    // Check version staleness
    if (context.sourceVersion) {
      const currentVersion = await this.delegate.checkFileVersion(targetUri);
      if (currentVersion !== null && currentVersion !== context.sourceVersion) {
        return {
          success: false,
          actionId: action.id,
          kind: 'create_change_set',
          targetUri,
          error: {
            code: 'stale_version',
            message: `File version has changed since this code was generated.`,
            recoveryOptions: this.buildStaleRecoveryOptions(),
          },
        };
      }
    }

    const metadata: { taskId?: string; runId?: string } = {};
    if (context.taskId !== undefined) metadata.taskId = context.taskId;
    if (context.runId !== undefined) metadata.runId = context.runId;

    const changeSetId = await this.delegate.createChangeSet(
      targetUri,
      context.content,
      metadata
    );

    if (!changeSetId) {
      return {
        success: false,
        actionId: action.id,
        kind: 'create_change_set',
        targetUri,
        error: { code: 'execution_failed', message: 'Failed to create Change_Set.' },
      };
    }

    return { success: true, actionId: action.id, kind: 'create_change_set', targetUri };
  }

  private buildRecoveryOptions(): RecoveryOption[] {
    return [
      {
        id: `retarget-${Date.now()}`,
        label: 'Retarget',
        kind: 'retarget',
        description: 'Select a different target file.',
      },
      {
        id: `regenerate-${Date.now()}`,
        label: 'Regenerate',
        kind: 'regenerate',
        description: 'Regenerate the code for a valid target.',
      },
    ];
  }

  private buildStaleRecoveryOptions(): RecoveryOption[] {
    return [
      {
        id: `rebase-${Date.now()}`,
        label: 'Rebase',
        kind: 'rebase',
        description: 'Rebase the proposal against the current file version.',
      },
      {
        id: `retarget-${Date.now()}`,
        label: 'Retarget',
        kind: 'retarget',
        description: 'Select a different target file.',
      },
      {
        id: `regenerate-${Date.now()}`,
        label: 'Regenerate',
        kind: 'regenerate',
        description: 'Regenerate the code against the current file content.',
      },
    ];
  }
}
