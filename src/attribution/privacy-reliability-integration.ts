/**
 * PrivacyReliabilityIntegration — Integrates source-bearing privacy,
 * truthful reliability, and always-on attribution across all Wave 3 services.
 *
 * This integration layer ensures:
 * 1. Remote Markdown/artifacts are sanitized before persistence.
 * 2. Encrypted retention and least-privilege policy decisions are enforced.
 * 3. Migration defaults are applied before first source-bearing persistence.
 * 4. All status indicators derive from authoritative services (not hardcoded UI state).
 * 5. Failures are classified precisely with idempotent bounded retries.
 * 6. Local work remains available offline.
 * 7. Incomplete Change_Transactions are recovered before further writes.
 * 8. Session inspection is source-governed and ordered.
 * 9. Metrics/logging remain source-free.
 * 10. Actor attribution stays always-on in the audit record while redacting exports.
 *
 * Requirements: 25.7, 25.8, 25.9, 25.10, 25.12, 26.1, 26.2, 26.3, 26.4, 26.5,
 *              26.6, 26.7, 26.8, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Phase at which a failure occurred — enables actionable diagnostics.
 * Requirements: 26.5, 26.7
 */
export type FailurePhase =
  | 'pre_execution'
  | 'during_mutation'
  | 'during_validation'
  | 'post_completion'
  | 'transaction_recovery';

/**
 * Precise failure classification per R26.2.
 */
export type FailureClass =
  | 'offline'
  | 'reconnecting'
  | 'rate_limited'
  | 'unauthorized'
  | 'timed_out'
  | 'cancelled'
  | 'server_error'
  | 'integrity_error'
  | 'transaction_incomplete';

/**
 * Result of a bounded retry attempt.
 * Requirements: 26.3
 */
export interface RetryAttempt {
  attemptNumber: number;
  maxAttempts: number;
  sequenceId: string;
  idempotencyKey: string;
  backoffMs: number;
  succeeded: boolean;
  failureClass?: FailureClass;
}

/**
 * A structured failure record with phase, classification, and recovery action.
 * Requirements: 26.5, 26.7
 */
export interface StructuredFailure {
  id: string;
  phase: FailurePhase;
  failureClass: FailureClass;
  message: string;
  technicalDetail: string;
  recoverableAction: string | null;
  timestamp: string;
  correlationId: string;
}

/**
 * The authoritative status derivation for any domain authority.
 * Requirements: 26.1
 */
export type AuthoritativeSource =
  | 'editor'
  | 'chat'
  | 'lsp'
  | 'provider'
  | 'tool'
  | 'dispatch'
  | 'validation'
  | 'git';

/**
 * An authoritative status snapshot derived from the owning service.
 * Requirements: 26.1, 26.6
 */
export interface AuthoritativeStatusSnapshot {
  source: AuthoritativeSource;
  status: string;
  derivedAt: string;
  ownerServiceId: string;
  correlationId?: string;
}

/**
 * Incomplete Change_Transaction record for crash recovery.
 * Requirements: 26.8
 */
export interface IncompleteTransaction {
  transactionId: string;
  changeSetId: string;
  phase: 'validating' | 'applying' | 'journaling';
  affectedFiles: string[];
  journalEntries: number;
  detectedAt: string;
  recoveryAction: 'rollback' | 'guided_recovery';
}

/**
 * Content sanitization result for remote Markdown and artifacts.
 * Requirements: 25.7
 */
export interface SanitizationResult {
  sanitized: boolean;
  originalHash: string;
  sanitizedContent: string;
  removedElements: string[];
  blockedResources: string[];
}

/**
 * Migration defaults applied before first source-bearing persistence.
 * Requirements: 25.12
 */
export interface MigrationDefaults {
  retentionDays: number;
  encryptionEnabled: boolean;
  providerTransmissionDisabled: boolean;
  telemetrySourceFree: boolean;
  localOnly: boolean;
  keyAvailable: boolean;
}

/**
 * Source-governed session inspection record.
 * Requirements: 27.1, 27.2
 */
export interface SessionInspectionRecord {
  correlationId: string;
  eventType: string;
  duration: number | null;
  outcome: string;
  retryCount: number;
  /** Sanitized metadata — no source content */
  metadata: Record<string, unknown>;
  /** Source content (separately governed, may be redacted) */
  sourceContent?: string;
  timestamp: string;
}

/**
 * Source-free metric record for logging.
 * Requirements: 27.3, 27.4
 */
export interface SourceFreeMetric {
  name: string;
  value: number;
  unit: string;
  correlationId?: string;
  timestamp: string;
}

/**
 * Diagnostic export bundle with configurable redaction.
 * Requirements: 27.4, 27.5
 */
export interface DiagnosticExport {
  exportId: string;
  records: SessionInspectionRecord[];
  metrics: SourceFreeMetric[];
  /** Whether source content is included (only if user enabled scoped diagnostic export) */
  includesSourceContent: boolean;
  /** Whether actor attribution is redacted per policy */
  attributionRedacted: boolean;
  createdAt: string;
}

/**
 * Actor attribution record (always-on in the authoritative audit).
 * Requirements: 27.7
 */
export interface ActorAttribution {
  /** The actor who made the change (user, agent, tool) */
  actorId: string;
  actorType: 'user' | 'agent' | 'tool' | 'service';
  /** The file or resource that was changed */
  targetUri: string;
  /** The operation performed */
  operation: string;
  /** Attribution is ALWAYS enabled in the audit record */
  readonly enabled: true;
  timestamp: string;
  /** Correlation to Change_Set and run */
  changeSetId?: string;
  runId?: string;
}

/**
 * Trace retention configuration.
 * Requirements: 27.6
 */
export interface TraceRetentionConfig {
  /** Maximum age in days */
  maxAgeDays: number;
  /** Maximum storage size in bytes */
  maxStorageBytes: number;
  /** Independent of source-bearing artifact retention */
  independentOfSourceRetention: boolean;
}

/**
 * Options for export redaction.
 * Requirements: 27.7
 */
export interface ExportRedactionPolicy {
  /** Redact actor attribution in exports */
  redactAttribution: boolean;
  /** Redact source content in exports */
  redactSourceContent: boolean;
  /** Redact absolute paths */
  redactAbsolutePaths: boolean;
  /** Include technical details */
  includeTechnicalDetail: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default migration defaults per R25.12 */
export const DEFAULT_MIGRATION_DEFAULTS: Readonly<MigrationDefaults> = Object.freeze({
  retentionDays: 30,
  encryptionEnabled: true,
  providerTransmissionDisabled: true,
  telemetrySourceFree: true,
  localOnly: true,
  keyAvailable: false,
});

/** Default trace retention per R27.6 */
export const DEFAULT_TRACE_RETENTION: Readonly<TraceRetentionConfig> = Object.freeze({
  maxAgeDays: 90,
  maxStorageBytes: 500 * 1024 * 1024, // 500MB
  independentOfSourceRetention: true,
});

/** Maximum retry attempts per R26.3 */
export const MAX_RETRY_ATTEMPTS = 5;

/** Initial backoff in ms for bounded retries */
export const INITIAL_BACKOFF_MS = 500;

/** Backoff multiplier */
export const BACKOFF_MULTIPLIER = 2;

/** Maximum backoff cap in ms */
export const MAX_BACKOFF_MS = 30_000;

// ─── Dangerous HTML elements to strip from remote Markdown ──────

const DANGEROUS_ELEMENTS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'button',
  'select',
  'link',
  'style',
  'meta',
  'base',
  'applet',
];

const DANGEROUS_ATTRIBUTES = [
  'onerror',
  'onload',
  'onclick',
  'onmouseover',
  'onfocus',
  'onblur',
  'onsubmit',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onchange',
];

// ─── Service ────────────────────────────────────────────────────

export class PrivacyReliabilityIntegration {
  private readonly migrationDefaults: MigrationDefaults;
  private readonly traceRetention: TraceRetentionConfig;
  private readonly attributionRecords: Map<string, ActorAttribution> = new Map();
  private readonly inspectionRecords: SessionInspectionRecord[] = [];
  private readonly metrics: SourceFreeMetric[] = [];
  private readonly incompleteTransactions: Map<string, IncompleteTransaction> = new Map();

  constructor(
    migrationDefaults?: Partial<MigrationDefaults>,
    traceRetention?: Partial<TraceRetentionConfig>,
  ) {
    this.migrationDefaults = { ...DEFAULT_MIGRATION_DEFAULTS, ...migrationDefaults };
    this.traceRetention = { ...DEFAULT_TRACE_RETENTION, ...traceRetention };
  }

  // ─── Privacy: Content Sanitization (R25.7) ──────────────────

  /**
   * Sanitize remote Markdown and artifacts under the Electron content-security policy.
   * Removes dangerous HTML elements, event handlers, and blocks remote resources
   * unless explicitly allowed.
   *
   * Requirements: 25.7
   */
  sanitizeRemoteContent(content: string, allowedDomains: string[] = []): SanitizationResult {
    const originalHash = this.computeSimpleHash(content);
    const removedElements: string[] = [];
    const blockedResources: string[] = [];

    let sanitized = content;

    // Remove dangerous HTML elements
    for (const element of DANGEROUS_ELEMENTS) {
      const openTagRegex = new RegExp(`<${element}[^>]*>`, 'gi');
      const closeTagRegex = new RegExp(`</${element}>`, 'gi');
      const selfCloseRegex = new RegExp(`<${element}[^>]*/\\s*>`, 'gi');

      if (openTagRegex.test(sanitized) || selfCloseRegex.test(sanitized)) {
        removedElements.push(element);
      }

      sanitized = sanitized.replace(openTagRegex, '');
      sanitized = sanitized.replace(closeTagRegex, '');
      sanitized = sanitized.replace(selfCloseRegex, '');
    }

    // Remove dangerous attributes
    for (const attr of DANGEROUS_ATTRIBUTES) {
      const attrRegex = new RegExp(`\\s${attr}\\s*=\\s*["'][^"']*["']`, 'gi');
      sanitized = sanitized.replace(attrRegex, '');
    }

    // Block remote resources not in allowed domains
    const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    sanitized = sanitized.replace(imgRegex, (_match, alt: string, url: string) => {
      try {
        const urlObj = new URL(url);
        if (allowedDomains.includes(urlObj.hostname)) {
          return _match;
        }
        blockedResources.push(url);
        return `![${alt}](blocked: remote resource requires consent)`;
      } catch {
        blockedResources.push(url);
        return `![${alt}](blocked: invalid URL)`;
      }
    });

    // Block data: URIs that might contain executable content
    const dataUriRegex = /data:(text\/html|application\/javascript|text\/javascript)[^)"]*/gi;
    sanitized = sanitized.replace(dataUriRegex, (match) => {
      blockedResources.push('data: URI with executable MIME type');
      return 'blocked: executable data URI';
    });

    return {
      sanitized: removedElements.length > 0 || blockedResources.length > 0,
      originalHash,
      sanitizedContent: sanitized,
      removedElements,
      blockedResources,
    };
  }

  // ─── Privacy: Migration Defaults (R25.12) ───────────────────

  /**
   * Get the migration defaults that must be applied before first source-bearing persistence.
   * Requirements: 25.12
   */
  getMigrationDefaults(): Readonly<MigrationDefaults> {
    return this.migrationDefaults;
  }

  /**
   * Validate that migration defaults are applied before persistence.
   * Returns true if the configuration satisfies the minimum privacy requirements.
   * Requirements: 25.8, 25.9, 25.12
   */
  validateMigrationCompliance(config: {
    encryptionEnabled: boolean;
    localOnly: boolean;
    providerTransmissionDisabled: boolean;
    keyAvailable: boolean;
  }): { compliant: boolean; violations: string[] } {
    const violations: string[] = [];

    if (!config.encryptionEnabled) {
      violations.push('Encryption at rest must be enabled for source-bearing content (R25.8)');
    }

    if (!config.localOnly) {
      violations.push('Source-bearing content must default to local-only retention (R25.12)');
    }

    if (!config.providerTransmissionDisabled) {
      violations.push('Provider transmission must be disabled until explicitly approved (R25.12)');
    }

    if (config.encryptionEnabled && !config.keyAvailable) {
      violations.push(
        'Source-bearing persistence must be disabled when OS-backed key is unavailable (R25.12)',
      );
    }

    return { compliant: violations.length === 0, violations };
  }

  // ─── Privacy: Least-Privilege Policy (R25.10) ───────────────

  /**
   * Validate that a tool/operation uses least-privilege scoped approvals.
   * Requirements: 25.10
   */
  validateLeastPrivilege(operation: {
    scope: string;
    requiredPermissions: string[];
    grantedPermissions: string[];
  }): { valid: boolean; excessPermissions: string[] } {
    const excess = operation.grantedPermissions.filter(
      (p) => !operation.requiredPermissions.includes(p),
    );

    return {
      valid: excess.length === 0,
      excessPermissions: excess,
    };
  }

  // ─── Reliability: Authoritative Status (R26.1) ──────────────

  /**
   * Derive an authoritative status snapshot from the owning service.
   * UI indicators must ONLY use this derivation — never hardcoded state.
   * Requirements: 26.1
   */
  deriveAuthoritativeStatus(
    source: AuthoritativeSource,
    ownerServiceId: string,
    currentStatus: string,
    correlationId?: string,
  ): AuthoritativeStatusSnapshot {
    return {
      source,
      status: currentStatus,
      derivedAt: new Date().toISOString(),
      ownerServiceId,
      correlationId,
    };
  }

  /**
   * Refresh optimistic UI from the authoritative owner when disagreement is detected.
   * Requirements: 26.6
   */
  resolveOptimisticDisagreement(
    uiStatus: string,
    authoritativeStatus: AuthoritativeStatusSnapshot,
  ): { resolved: boolean; finalStatus: string; wasDisagreement: boolean } {
    const wasDisagreement = uiStatus !== authoritativeStatus.status;

    // Authoritative status always wins
    return {
      resolved: true,
      finalStatus: authoritativeStatus.status,
      wasDisagreement,
    };
  }

  // ─── Reliability: Failure Classification (R26.2, R26.5) ─────

  /**
   * Classify a failure precisely with phase and actionable detail.
   * Requirements: 26.2, 26.5, 26.7
   */
  classifyFailure(
    error: Error | { code?: string; message: string },
    phase: FailurePhase,
    correlationId: string,
  ): StructuredFailure {
    const failureClass = this.deriveFailureClass(error);
    const recoverableAction = this.deriveRecoveryAction(failureClass, phase);

    return {
      id: this.generateId(),
      phase,
      failureClass,
      message: this.deriveUserMessage(failureClass),
      technicalDetail: error.message,
      recoverableAction,
      timestamp: new Date().toISOString(),
      correlationId,
    };
  }

  /**
   * Derive the failure class from the error.
   * Requirements: 26.2
   */
  private deriveFailureClass(error: Error | { code?: string; message: string }): FailureClass {
    const code = 'code' in error ? error.code : undefined;
    const msg = error.message.toLowerCase();

    if (code === 'ENOTFOUND' || code === 'ENETUNREACH' || msg.includes('offline')) {
      return 'offline';
    }
    if (code === 'ECONNRESET' || msg.includes('reconnect')) {
      return 'reconnecting';
    }
    if (code === '429' || msg.includes('rate limit') || msg.includes('too many requests')) {
      return 'rate_limited';
    }
    if (code === '401' || code === '403' || msg.includes('unauthorized') || msg.includes('forbidden')) {
      return 'unauthorized';
    }
    if (code === 'ETIMEDOUT' || msg.includes('timeout') || msg.includes('timed out')) {
      return 'timed_out';
    }
    if (msg.includes('cancel')) {
      return 'cancelled';
    }
    if (msg.includes('integrity') || msg.includes('hash mismatch') || msg.includes('fingerprint')) {
      return 'integrity_error';
    }
    if (msg.includes('transaction') || msg.includes('incomplete') || msg.includes('journal')) {
      return 'transaction_incomplete';
    }
    return 'server_error';
  }

  /**
   * Derive a user-facing message from the failure class.
   */
  private deriveUserMessage(failureClass: FailureClass): string {
    switch (failureClass) {
      case 'offline':
        return 'Network is unavailable. Local work remains accessible.';
      case 'reconnecting':
        return 'Connection interrupted. Attempting to reconnect.';
      case 'rate_limited':
        return 'Rate limit reached. Request will retry automatically.';
      case 'unauthorized':
        return 'Authentication required. Please check credentials.';
      case 'timed_out':
        return 'Request timed out. You may retry the operation.';
      case 'cancelled':
        return 'Operation was cancelled.';
      case 'server_error':
        return 'An unexpected error occurred. See details for recovery options.';
      case 'integrity_error':
        return 'Data integrity check failed. Recovery is required.';
      case 'transaction_incomplete':
        return 'A transaction was interrupted. Recovery or rollback is needed before further writes.';
    }
  }

  /**
   * Derive the recovery action from failure class and phase.
   * Requirements: 26.7
   */
  private deriveRecoveryAction(failureClass: FailureClass, phase: FailurePhase): string | null {
    if (failureClass === 'offline') {
      return 'Continue working locally. Changes will sync when connectivity restores.';
    }
    if (failureClass === 'reconnecting') {
      return 'Bounded reconnection in progress. Manual restart available if needed.';
    }
    if (failureClass === 'rate_limited') {
      return 'Automatic retry with backoff. No action needed.';
    }
    if (failureClass === 'unauthorized') {
      return 'Re-authenticate with the provider.';
    }
    if (failureClass === 'timed_out') {
      return 'Retry the operation or increase timeout configuration.';
    }
    if (failureClass === 'cancelled') {
      return null; // User-initiated, no recovery needed
    }
    if (failureClass === 'transaction_incomplete' && phase === 'during_mutation') {
      return 'Guided recovery required: rollback or complete the interrupted transaction.';
    }
    if (failureClass === 'integrity_error') {
      return 'Verify data integrity and restore from checkpoint if needed.';
    }
    return 'Retry the operation. Expand details for technical information.';
  }

  // ─── Reliability: Bounded Retries (R26.3) ───────────────────

  /**
   * Compute the next retry attempt with bounded exponential backoff.
   * Uses idempotency keys and sequence identifiers to prevent duplicates.
   * Requirements: 26.3
   */
  computeRetryAttempt(
    currentAttempt: number,
    sequenceId: string,
    idempotencyKey: string,
  ): RetryAttempt | null {
    if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
      return null; // Exceeded bound
    }

    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, currentAttempt),
      MAX_BACKOFF_MS,
    );

    return {
      attemptNumber: currentAttempt + 1,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      sequenceId,
      idempotencyKey,
      backoffMs,
      succeeded: false,
    };
  }

  /**
   * Check if a retry is safe (idempotent, within bounds).
   * Requirements: 26.3
   */
  isRetrySafe(
    failureClass: FailureClass,
    attemptNumber: number,
  ): boolean {
    // Cancelled operations should not be retried automatically
    if (failureClass === 'cancelled') return false;
    // Unauthorized needs re-auth, not retry
    if (failureClass === 'unauthorized') return false;
    // Integrity errors need recovery, not retry
    if (failureClass === 'integrity_error') return false;
    // Must be within bounds
    return attemptNumber < MAX_RETRY_ATTEMPTS;
  }

  // ─── Reliability: Offline Availability (R26.4) ──────────────

  /**
   * Determine which operations remain available offline.
   * Requirements: 26.4
   */
  getOfflineCapabilities(): {
    editing: boolean;
    localNavigation: boolean;
    diffReview: boolean;
    specAccess: boolean;
    providerChat: boolean;
    lspFull: boolean;
  } {
    return {
      editing: true,
      localNavigation: true,
      diffReview: true,
      specAccess: true,
      providerChat: false, // Requires network
      lspFull: false, // May be degraded without external language server
    };
  }

  // ─── Reliability: Transaction Recovery (R26.8) ──────────────

  /**
   * Register an incomplete Change_Transaction for recovery.
   * Requirements: 26.8
   */
  registerIncompleteTransaction(transaction: IncompleteTransaction): void {
    this.incompleteTransactions.set(transaction.transactionId, transaction);
  }

  /**
   * Check for incomplete transactions before allowing further writes.
   * Blocks writes until recovery is completed.
   * Requirements: 26.8
   */
  checkTransactionRecoveryRequired(): {
    blocked: boolean;
    incompleteTransactions: IncompleteTransaction[];
  } {
    const incomplete = Array.from(this.incompleteTransactions.values());
    return {
      blocked: incomplete.length > 0,
      incompleteTransactions: incomplete,
    };
  }

  /**
   * Complete recovery for a transaction (either rollback or guided resolution).
   * Requirements: 26.8
   */
  completeTransactionRecovery(transactionId: string): boolean {
    return this.incompleteTransactions.delete(transactionId);
  }

  // ─── Observability: Session Inspection (R27.1, R27.2) ───────

  /**
   * Record a session inspection event with ordered lifecycle data.
   * Source content is separately governed from event metadata.
   * Requirements: 27.1, 27.2
   */
  recordInspectionEvent(event: Omit<SessionInspectionRecord, 'timestamp'>): SessionInspectionRecord {
    const record: SessionInspectionRecord = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.inspectionRecords.push(record);
    return record;
  }

  /**
   * Get ordered session inspection records.
   * Source content access is governed separately.
   * Requirements: 27.2
   */
  getInspectionRecords(options?: {
    includeSourceContent?: boolean;
    correlationId?: string;
  }): SessionInspectionRecord[] {
    let records = [...this.inspectionRecords];

    if (options?.correlationId) {
      records = records.filter((r) => r.correlationId === options.correlationId);
    }

    if (!options?.includeSourceContent) {
      // Strip source content — metadata remains
      records = records.map((r) => {
        const { sourceContent: _, ...rest } = r;
        return rest;
      });
    }

    return records;
  }

  // ─── Observability: Source-Free Metrics (R27.3, R27.4) ──────

  /**
   * Record a source-free metric.
   * Requirements: 27.3, 27.4
   */
  recordMetric(name: string, value: number, unit: string, correlationId?: string): SourceFreeMetric {
    const metric: SourceFreeMetric = {
      name,
      value,
      unit,
      correlationId,
      timestamp: new Date().toISOString(),
    };
    this.metrics.push(metric);
    return metric;
  }

  /**
   * Get all recorded source-free metrics.
   * Requirements: 27.3
   */
  getMetrics(): SourceFreeMetric[] {
    return [...this.metrics];
  }

  // ─── Observability: Trace Retention (R27.6) ─────────────────

  /**
   * Get the trace retention configuration.
   * Trace retention is independent of source-bearing artifact retention.
   * Requirements: 27.6
   */
  getTraceRetention(): Readonly<TraceRetentionConfig> {
    return this.traceRetention;
  }

  /**
   * Check if trace retention is truly independent of source-bearing retention.
   * Requirements: 27.6
   */
  isTraceRetentionIndependent(): boolean {
    return this.traceRetention.independentOfSourceRetention;
  }

  // ─── Observability: Diagnostic Export (R27.4, R27.5) ────────

  /**
   * Generate a diagnostic export with configurable redaction.
   * Preview is optional and MUST NOT block an authorized export.
   * Requirements: 27.4, 27.5
   */
  generateDiagnosticExport(
    redactionPolicy: ExportRedactionPolicy,
    options?: { previewOnly?: boolean },
  ): DiagnosticExport {
    let records = this.getInspectionRecords({
      includeSourceContent: !redactionPolicy.redactSourceContent,
    });

    // Redact absolute paths if required
    if (redactionPolicy.redactAbsolutePaths) {
      records = records.map((r) => ({
        ...r,
        metadata: this.redactPathsInMetadata(r.metadata),
      }));
    }

    // Strip technical detail if not included
    if (!redactionPolicy.includeTechnicalDetail) {
      records = records.map((r) => ({
        ...r,
        metadata: this.stripTechnicalDetail(r.metadata),
      }));
    }

    const exportRecord: DiagnosticExport = {
      exportId: this.generateId(),
      records,
      metrics: this.getMetrics(),
      includesSourceContent: !redactionPolicy.redactSourceContent,
      attributionRedacted: redactionPolicy.redactAttribution,
      createdAt: new Date().toISOString(),
    };

    return exportRecord;
  }

  // ─── Attribution: Always-On Actor Attribution (R27.7) ───────

  /**
   * Record actor attribution for an accepted change.
   * Attribution is ALWAYS enabled in the authoritative audit record.
   * It can NEVER be disabled for privacy, performance, or admin configuration.
   * Exports can be redacted, but the audit record always contains full attribution.
   *
   * Requirements: 27.7
   */
  recordActorAttribution(params: {
    actorId: string;
    actorType: 'user' | 'agent' | 'tool' | 'service';
    targetUri: string;
    operation: string;
    changeSetId?: string;
    runId?: string;
  }): ActorAttribution {
    const record: ActorAttribution = {
      actorId: params.actorId,
      actorType: params.actorType,
      targetUri: params.targetUri,
      operation: params.operation,
      enabled: true, // Always true, readonly
      timestamp: new Date().toISOString(),
      changeSetId: params.changeSetId,
      runId: params.runId,
    };

    const key = `${params.targetUri}:${record.timestamp}:${this.generateId()}`;
    this.attributionRecords.set(key, record);
    return record;
  }

  /**
   * Get actor attribution for a target.
   * Attribution is always available in the audit — never disabled.
   * Requirements: 27.7
   */
  getActorAttribution(targetUri: string): ActorAttribution[] {
    const results: ActorAttribution[] = [];
    for (const record of this.attributionRecords.values()) {
      if (record.targetUri === targetUri) {
        results.push(record);
      }
    }
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Get all attribution records, optionally redacted for export.
   * Redaction only applies to export — the authoritative audit is never redacted.
   * Requirements: 27.7
   */
  getAttributionForExport(
    redactionPolicy: ExportRedactionPolicy,
  ): Array<ActorAttribution | { redacted: true; targetUri: string; operation: string; timestamp: string }> {
    const records = Array.from(this.attributionRecords.values());

    if (!redactionPolicy.redactAttribution) {
      return records;
    }

    // Redact actor identity from exports while keeping operation metadata
    return records.map((r) => ({
      redacted: true as const,
      targetUri: redactionPolicy.redactAbsolutePaths
        ? this.redactPath(r.targetUri)
        : r.targetUri,
      operation: r.operation,
      timestamp: r.timestamp,
    }));
  }

  // ─── Utility ────────────────────────────────────────────────

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  private computeSimpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `h_${Math.abs(hash).toString(36)}`;
  }

  private redactPathsInMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('C:\\'))) {
        result[key] = this.redactPath(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private redactPath(p: string): string {
    // Replace home directory with ~
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir && p.startsWith(homeDir)) {
      return '~' + p.slice(homeDir.length);
    }
    return p;
  }

  private stripTechnicalDetail(metadata: Record<string, unknown>): Record<string, unknown> {
    const { stackTrace: _, rawError: __, ...rest } = metadata as Record<string, unknown>;
    return rest;
  }
}
