/**
 * StaleTargetHandler — Handles stale versions, missing files, and offers
 * rebase, retarget, or regenerate recovery when code actions cannot apply.
 *
 * Requirements: 17.8
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Reasons why a target is considered stale or invalid.
 */
export type StaleReason =
  | 'version_mismatch'
  | 'file_deleted'
  | 'file_renamed'
  | 'file_moved'
  | 'content_diverged'
  | 'workspace_changed';

/**
 * A stale target detection result.
 */
export interface StaleTargetResult {
  readonly targetUri: string;
  readonly isStale: boolean;
  readonly reason?: StaleReason | undefined;
  readonly expectedVersion?: string | undefined;
  readonly actualVersion?: string | undefined;
  readonly detectedAt: string;
  readonly recoveryActions: readonly RecoveryAction[];
}

/**
 * A recovery action offered when a target is stale.
 */
export interface RecoveryAction {
  readonly id: string;
  readonly kind: 'rebase' | 'retarget' | 'regenerate';
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabledReason?: string | undefined;
}

/**
 * Result of executing a recovery action.
 */
export interface RecoveryResult {
  readonly success: boolean;
  readonly actionId: string;
  readonly kind: 'rebase' | 'retarget' | 'regenerate';
  readonly newTargetUri?: string | undefined;
  readonly newContent?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * Delegate for interacting with workspace to check file state.
 */
export interface StaleTargetDelegate {
  getFileVersion(uri: string): Promise<string | null>;
  fileExists(uri: string): Promise<boolean>;
  findRenamedFile(originalUri: string): Promise<string | null>;
  getFileContent(uri: string): Promise<string | null>;
}

/**
 * Input context for a code block target.
 */
export interface TargetCheckInput {
  readonly targetUri: string;
  readonly expectedVersion?: string | undefined;
  readonly expectedContentHash?: string | undefined;
  readonly generatedAt?: string | undefined;
}

// ─── Service ────────────────────────────────────────────────────

function generateRecoveryId(): string {
  return `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class StaleTargetHandler {
  private readonly delegate: StaleTargetDelegate;
  private readonly staleResults: Map<string, StaleTargetResult> = new Map();

  constructor(delegate: StaleTargetDelegate) {
    this.delegate = delegate;
  }

  /**
   * Check if a target file is stale or missing.
   */
  async checkTarget(input: TargetCheckInput): Promise<StaleTargetResult> {
    const { targetUri, expectedVersion } = input;

    // Check if file exists
    const exists = await this.delegate.fileExists(targetUri);
    if (!exists) {
      // Check if the file was renamed
      const renamedUri = await this.delegate.findRenamedFile(targetUri);
      const reason: StaleReason = renamedUri ? 'file_renamed' : 'file_deleted';

      const result: StaleTargetResult = {
        targetUri,
        isStale: true,
        reason,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        detectedAt: new Date().toISOString(),
        recoveryActions: this.buildRecoveryActions(reason, renamedUri),
      };
      this.staleResults.set(targetUri, result);
      return result;
    }

    // Check version if expected version is provided
    if (expectedVersion) {
      const actualVersion = await this.delegate.getFileVersion(targetUri);
      if (actualVersion !== null && actualVersion !== expectedVersion) {
        const result: StaleTargetResult = {
          targetUri,
          isStale: true,
          reason: 'version_mismatch',
          expectedVersion,
          actualVersion,
          detectedAt: new Date().toISOString(),
          recoveryActions: this.buildRecoveryActions('version_mismatch'),
        };
        this.staleResults.set(targetUri, result);
        return result;
      }
    }

    // Not stale
    const result: StaleTargetResult = {
      targetUri,
      isStale: false,
      detectedAt: new Date().toISOString(),
      recoveryActions: [],
    };
    this.staleResults.set(targetUri, result);
    return result;
  }

  /**
   * Get recovery actions for a stale target.
   */
  getRecoveryActions(targetUri: string): readonly RecoveryAction[] {
    const result = this.staleResults.get(targetUri);
    return result?.recoveryActions ?? [];
  }

  /**
   * Get the last stale result for a target.
   */
  getStaleResult(targetUri: string): StaleTargetResult | undefined {
    return this.staleResults.get(targetUri);
  }

  /**
   * Get all stale targets.
   */
  getAllStaleTargets(): readonly StaleTargetResult[] {
    return [...this.staleResults.values()].filter(r => r.isStale);
  }

  /**
   * Build an explanation message for the UI.
   */
  buildExplanation(result: StaleTargetResult): string {
    if (!result.isStale) return '';

    switch (result.reason) {
      case 'version_mismatch':
        return `The file "${result.targetUri}" has been modified since this code was generated. ` +
          `Expected version: ${result.expectedVersion}, current version: ${result.actualVersion}. ` +
          `Use Rebase to update the proposal, Retarget to choose a different file, or Regenerate to create new content.`;

      case 'file_deleted':
        return `The file "${result.targetUri}" no longer exists. ` +
          `Use Retarget to choose a different file or Regenerate to create content for a new target.`;

      case 'file_renamed':
        return `The file "${result.targetUri}" appears to have been renamed or moved. ` +
          `Use Retarget to select the new location or Regenerate to create updated content.`;

      case 'file_moved':
        return `The file "${result.targetUri}" has been moved. ` +
          `Use Retarget to select the new location or Regenerate.`;

      case 'content_diverged':
        return `The content of "${result.targetUri}" has diverged from what was expected. ` +
          `Use Rebase to reconcile changes, Retarget, or Regenerate.`;

      case 'workspace_changed':
        return `The workspace has changed since this code was generated. ` +
          `Use Rebase to update or Regenerate for the current workspace state.`;

      default:
        return `The target "${result.targetUri}" is stale. Recovery options are available.`;
    }
  }

  /**
   * Clear stale results.
   */
  clear(): void {
    this.staleResults.clear();
  }

  // ─── Private ──────────────────────────────────────────────────

  private buildRecoveryActions(
    reason: StaleReason,
    renamedUri?: string | null
  ): RecoveryAction[] {
    const actions: RecoveryAction[] = [];

    // Rebase — available for version mismatch and content divergence
    const rebaseEnabled = reason === 'version_mismatch' || reason === 'content_diverged';
    actions.push({
      id: generateRecoveryId(),
      kind: 'rebase',
      label: 'Rebase',
      description: rebaseEnabled
        ? 'Rebase the proposal against the current file version.'
        : 'Rebase is not available because the file does not exist.',
      enabled: rebaseEnabled,
      ...(rebaseEnabled ? {} : { disabledReason: 'File must exist for rebase.' }),
    });

    // Retarget — always available
    const retargetDescription = renamedUri
      ? `Retarget to the renamed file: ${renamedUri}`
      : 'Select a different target file for this code.';
    actions.push({
      id: generateRecoveryId(),
      kind: 'retarget',
      label: 'Retarget',
      description: retargetDescription,
      enabled: true,
    });

    // Regenerate — always available
    actions.push({
      id: generateRecoveryId(),
      kind: 'regenerate',
      label: 'Regenerate',
      description: 'Regenerate the code against the current workspace state.',
      enabled: true,
    });

    return actions;
  }
}
