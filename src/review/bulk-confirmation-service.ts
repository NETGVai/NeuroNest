/**
 * BulkConfirmationService — Requires confirmation before every bulk acceptance
 * and adds risk context when applicable (delete, binary, manifest, sensitive,
 * out-of-scope).
 *
 * Every bulk acceptance triggers a confirmation prompt. The confirmation includes
 * risk context when the Change_Set contains:
 * - Deletions
 * - Binary file changes
 * - Dependency manifests
 * - Security-sensitive files
 * - Out-of-scope files
 *
 * Requirements: 8.8
 */

import type { ChangeSet, FileOperation, FileOperationSummary } from '../change-set/types';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Risk categories that trigger additional context in confirmation.
 */
export type RiskCategory =
  | 'delete'
  | 'binary'
  | 'manifest'
  | 'sensitive'
  | 'out-of-scope';

/**
 * A risk item identified in the Change_Set.
 */
export interface RiskItem {
  /** The risk category. */
  readonly category: RiskCategory;
  /** The affected file URI. */
  readonly fileUri: string;
  /** Human-readable description of the risk. */
  readonly description: string;
  /** Severity level of this risk item. */
  readonly severity: 'info' | 'warning' | 'critical';
}

/**
 * Risk context collected for a bulk acceptance confirmation.
 */
export interface BulkRiskContext {
  /** Whether any risk items were identified. */
  readonly hasRisks: boolean;
  /** Categorized risk items. */
  readonly items: readonly RiskItem[];
  /** Summary counts per risk category. */
  readonly categoryCounts: Readonly<Record<RiskCategory, number>>;
  /** Overall risk severity (highest of all items). */
  readonly overallSeverity: 'none' | 'info' | 'warning' | 'critical';
}

/**
 * A bulk confirmation request presented to the user.
 */
export interface BulkConfirmationRequest {
  /** Unique confirmation ID (acts as a token). */
  readonly confirmationId: string;
  /** The Change_Set being accepted in bulk. */
  readonly changeSetId: string;
  /** Total files in the bulk acceptance. */
  readonly totalFiles: number;
  /** Total operations in the bulk acceptance. */
  readonly totalOperations: number;
  /** Risk context with any applicable risk items. */
  readonly riskContext: BulkRiskContext;
  /** Human-readable confirmation message. */
  readonly message: string;
  /** Whether confirmation is required (always true). */
  readonly required: true;
  /** Timestamp when the confirmation was created. */
  readonly createdAt: string;
}

/**
 * A user's response to a bulk confirmation request.
 */
export interface BulkConfirmationResponse {
  /** The confirmation ID being responded to. */
  readonly confirmationId: string;
  /** Whether the user confirmed acceptance. */
  readonly confirmed: boolean;
  /** User ID who responded. */
  readonly userId: string;
  /** Timestamp of the response. */
  readonly respondedAt: string;
}

/**
 * Result of attempting a bulk acceptance.
 */
export interface BulkAcceptanceResult {
  /** Whether bulk acceptance was allowed to proceed. */
  readonly allowed: boolean;
  /** The confirmation request (always created). */
  readonly confirmationRequest: BulkConfirmationRequest;
  /** The user response (present after confirmation). */
  readonly response?: BulkConfirmationResponse;
  /** Error message if blocked. */
  readonly error?: string;
}

/**
 * Configuration for what constitutes an out-of-scope file.
 */
export interface ScopeConfiguration {
  /** Allowed workspace root paths. */
  readonly allowedRoots: readonly string[];
  /** Allowed file patterns (glob-like). */
  readonly allowedPatterns?: readonly string[];
  /** Excluded paths that are always out-of-scope. */
  readonly excludedPaths?: readonly string[];
}

// ─── Patterns ───────────────────────────────────────────────────

/** Patterns indicating security-sensitive files. */
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /secret/i,
  /credential/i,
  /\bauth\b/i,
  /\.pem$/i,
  /\.key$/i,
  /password/i,
  /token/i,
  /\.pfx$/i,
  /\.p12$/i,
];

/** Patterns indicating dependency manifests. */
const MANIFEST_PATTERNS = [
  /package\.json$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /Gemfile\.lock$/i,
  /Cargo\.lock$/i,
  /go\.sum$/i,
  /go\.mod$/i,
  /requirements\.txt$/i,
  /poetry\.lock$/i,
  /pyproject\.toml$/i,
  /Pipfile$/i,
  /Pipfile\.lock$/i,
];

/** Patterns indicating binary files. */
const BINARY_PATTERNS = [
  /\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff?)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(pdf|doc|docx|xls|xlsx)$/i,
  /\.(zip|tar|gz|bz2|7z|rar)$/i,
  /\.(exe|dll|so|dylib|o|a)$/i,
  /\.(wasm|onnx|bin|dat)$/i,
];

// ─── Service ────────────────────────────────────────────────────

/**
 * BulkConfirmationService manages confirmation requirements for bulk acceptance.
 * It always requires confirmation, and adds risk context when applicable risks
 * are present in the Change_Set.
 */
export class BulkConfirmationService {
  /** Pending confirmation requests awaiting user response. */
  private readonly pendingConfirmations = new Map<string, BulkConfirmationRequest>();

  /** Completed confirmation responses. */
  private readonly completedConfirmations = new Map<string, BulkConfirmationResponse>();

  /** Scope configuration for out-of-scope detection. */
  private scopeConfig: ScopeConfiguration | null = null;

  /**
   * Set workspace scope configuration for out-of-scope detection.
   */
  setScopeConfiguration(config: ScopeConfiguration): void {
    this.scopeConfig = config;
  }

  /**
   * Creates a bulk confirmation request for a Change_Set acceptance.
   * Confirmation is ALWAYS required, regardless of Change_Set contents.
   * Risk context is added when applicable risks are detected.
   */
  requestConfirmation(changeSet: ChangeSet): BulkConfirmationRequest {
    const riskContext = this.analyzeRisks(changeSet);
    const confirmationId = this.generateConfirmationId();

    const message = this.buildConfirmationMessage(changeSet, riskContext);

    const request: BulkConfirmationRequest = {
      confirmationId,
      changeSetId: changeSet.id,
      totalFiles: changeSet.operations.length,
      totalOperations: changeSet.operations.length,
      riskContext,
      message,
      required: true,
      createdAt: new Date().toISOString(),
    };

    this.pendingConfirmations.set(confirmationId, request);
    return request;
  }

  /**
   * Responds to a bulk confirmation request.
   * Returns the result indicating whether bulk acceptance can proceed.
   */
  respond(
    confirmationId: string,
    confirmed: boolean,
    userId: string
  ): BulkAcceptanceResult {
    const request = this.pendingConfirmations.get(confirmationId);
    if (!request) {
      return {
        allowed: false,
        confirmationRequest: this.createExpiredRequest(confirmationId),
        error: `Confirmation request '${confirmationId}' not found or expired.`,
      };
    }

    const response: BulkConfirmationResponse = {
      confirmationId,
      confirmed,
      userId,
      respondedAt: new Date().toISOString(),
    };

    this.pendingConfirmations.delete(confirmationId);
    this.completedConfirmations.set(confirmationId, response);

    return {
      allowed: confirmed,
      confirmationRequest: request,
      response,
    };
  }

  /**
   * Checks if a bulk acceptance has been confirmed.
   * Returns false if no confirmation exists or it was rejected.
   */
  isConfirmed(confirmationId: string): boolean {
    const response = this.completedConfirmations.get(confirmationId);
    return response?.confirmed === true;
  }

  /**
   * Checks if a confirmation is pending (not yet responded to).
   */
  isPending(confirmationId: string): boolean {
    return this.pendingConfirmations.has(confirmationId);
  }

  /**
   * Cancels a pending confirmation request.
   */
  cancel(confirmationId: string): boolean {
    return this.pendingConfirmations.delete(confirmationId);
  }

  /**
   * Analyzes a Change_Set for risk items that need to be presented
   * during bulk confirmation.
   */
  analyzeRisks(changeSet: ChangeSet): BulkRiskContext {
    const items: RiskItem[] = [];

    for (const op of changeSet.operations) {
      const fileUri = op.targetUri;

      // Check for delete operations
      if (op.kind === 'delete') {
        items.push({
          category: 'delete',
          fileUri,
          description: `File '${this.getFileName(fileUri)}' will be permanently deleted.`,
          severity: 'warning',
        });
      }

      // Check for binary files
      if (this.isBinaryFile(fileUri)) {
        items.push({
          category: 'binary',
          fileUri,
          description: `Binary file '${this.getFileName(fileUri)}' — cannot be diffed textually.`,
          severity: 'info',
        });
      }

      // Check for dependency manifests
      if (this.isManifestFile(fileUri)) {
        items.push({
          category: 'manifest',
          fileUri,
          description: `Dependency manifest '${this.getFileName(fileUri)}' — may affect project dependencies.`,
          severity: 'warning',
        });
      }

      // Check for security-sensitive files
      if (this.isSensitiveFile(fileUri)) {
        items.push({
          category: 'sensitive',
          fileUri,
          description: `Security-sensitive file '${this.getFileName(fileUri)}' — review credentials and secrets.`,
          severity: 'critical',
        });
      }

      // Check for out-of-scope files
      if (this.isOutOfScope(fileUri)) {
        items.push({
          category: 'out-of-scope',
          fileUri,
          description: `File '${this.getFileName(fileUri)}' is outside the expected workspace scope.`,
          severity: 'warning',
        });
      }
    }

    const categoryCounts: Record<RiskCategory, number> = {
      delete: 0,
      binary: 0,
      manifest: 0,
      sensitive: 0,
      'out-of-scope': 0,
    };

    for (const item of items) {
      categoryCounts[item.category]++;
    }

    const overallSeverity = this.computeOverallSeverity(items);

    return {
      hasRisks: items.length > 0,
      items: Object.freeze(items),
      categoryCounts: Object.freeze(categoryCounts),
      overallSeverity,
    };
  }

  // ─── Private Methods ───────────────────────────────────────────

  private isBinaryFile(uri: string): boolean {
    return BINARY_PATTERNS.some((p) => p.test(uri));
  }

  private isManifestFile(uri: string): boolean {
    return MANIFEST_PATTERNS.some((p) => p.test(uri));
  }

  private isSensitiveFile(uri: string): boolean {
    return SENSITIVE_PATTERNS.some((p) => p.test(uri));
  }

  private isOutOfScope(uri: string): boolean {
    if (!this.scopeConfig) return false;

    const { allowedRoots, excludedPaths } = this.scopeConfig;

    // Check if explicitly excluded
    if (excludedPaths?.some((excluded) => uri.startsWith(excluded))) {
      return true;
    }

    // Check if within allowed roots
    const withinAllowedRoot = allowedRoots.some((root) => uri.startsWith(root));
    return !withinAllowedRoot;
  }

  private getFileName(uri: string): string {
    return uri.split('/').pop() ?? uri;
  }

  private computeOverallSeverity(
    items: RiskItem[]
  ): 'none' | 'info' | 'warning' | 'critical' {
    if (items.length === 0) return 'none';
    if (items.some((i) => i.severity === 'critical')) return 'critical';
    if (items.some((i) => i.severity === 'warning')) return 'warning';
    return 'info';
  }

  private buildConfirmationMessage(
    changeSet: ChangeSet,
    riskContext: BulkRiskContext
  ): string {
    const fileCount = changeSet.operations.length;
    let message = `Accept all ${fileCount} file${fileCount !== 1 ? 's' : ''} in this Change_Set?`;

    if (riskContext.hasRisks) {
      const riskParts: string[] = [];
      if (riskContext.categoryCounts.delete > 0) {
        riskParts.push(
          `${riskContext.categoryCounts.delete} deletion${riskContext.categoryCounts.delete !== 1 ? 's' : ''}`
        );
      }
      if (riskContext.categoryCounts.binary > 0) {
        riskParts.push(
          `${riskContext.categoryCounts.binary} binary file${riskContext.categoryCounts.binary !== 1 ? 's' : ''}`
        );
      }
      if (riskContext.categoryCounts.manifest > 0) {
        riskParts.push(
          `${riskContext.categoryCounts.manifest} dependency manifest${riskContext.categoryCounts.manifest !== 1 ? 's' : ''}`
        );
      }
      if (riskContext.categoryCounts.sensitive > 0) {
        riskParts.push(
          `${riskContext.categoryCounts.sensitive} security-sensitive file${riskContext.categoryCounts.sensitive !== 1 ? 's' : ''}`
        );
      }
      if (riskContext.categoryCounts['out-of-scope'] > 0) {
        riskParts.push(
          `${riskContext.categoryCounts['out-of-scope']} out-of-scope file${riskContext.categoryCounts['out-of-scope'] !== 1 ? 's' : ''}`
        );
      }

      message += ` This includes: ${riskParts.join(', ')}.`;
    }

    return message;
  }

  private generateConfirmationId(): string {
    return `bulk-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private createExpiredRequest(confirmationId: string): BulkConfirmationRequest {
    return {
      confirmationId,
      changeSetId: '',
      totalFiles: 0,
      totalOperations: 0,
      riskContext: {
        hasRisks: false,
        items: [],
        categoryCounts: { delete: 0, binary: 0, manifest: 0, sensitive: 0, 'out-of-scope': 0 },
        overallSeverity: 'none',
      },
      message: 'Confirmation expired or not found.',
      required: true,
      createdAt: '',
    };
  }
}
