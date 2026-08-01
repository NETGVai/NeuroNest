// ─── Connector Framework Orchestrator ───────────────────────────
// Central coordinator for the KB connector subsystem. Manages:
// - Adapter registration with ImportValidator validation
// - Source lifecycle: addSource → connect → list → fetch → disconnect
// - Error handling: catch unhandled fetch errors, emit events, mark failed
// - Credential masking: no raw secrets in logs, events, or error output
//
// Requirements: 1.3, 1.6, 42.2, 42.3, 42.4

import type { EventLog, EventKind } from '../../pipeline/event-log';
import type { CredentialVault } from '../../security/credential-vault';
import { KB_EVENT_KINDS } from '../events/kb-event-schemas';
import type {
  ConnectorConfig,
  ConnectorType,
  KBConnector,
  RawDocument,
  SourceEntry,
} from './types';

// ─── Credential Masking ─────────────────────────────────────────

/**
 * Patterns that match common credential formats in strings.
 * Used to mask raw credential values before they appear in logs,
 * events, or error messages.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // GitHub tokens (classic and fine-grained)
  /ghp_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{82,}/g,
  // GitLab tokens
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  // Generic Bearer/API keys (long alphanumeric sequences)
  /(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g,
  // AWS-style keys
  /AKIA[A-Z0-9]{16}/g,
  // SSH private key content
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // Generic long tokens (hex or base64, 32+ chars — common in API keys)
  /(?:token|key|secret|password|credential|auth)[=:\s]["']?([A-Za-z0-9\-._~+/]{20,})/gi,
];

/**
 * Masks credential-like values in a string.
 * Replaces matched patterns with a masked version showing only the
 * first 4 and last 3 characters (e.g., "ghp_****abc").
 *
 * @param input - The string to mask
 * @returns The string with credential values masked
 */
export function maskCredentials(input: string): string {
  let masked = input;
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (match) => {
      if (match.length <= 8) {
        return '****';
      }
      const prefix = match.slice(0, 4);
      const suffix = match.slice(-3);
      return `${prefix}****${suffix}`;
    });
  }
  return masked;
}

// ─── Types ──────────────────────────────────────────────────────

/**
 * Source status tracked by the connector framework.
 */
export type SourceStatus = 'idle' | 'indexing' | 'error' | 'auth-failed';

/**
 * Tracked source entry within the connector framework.
 */
export interface ManagedSource {
  id: string;
  config: ConnectorConfig;
  status: SourceStatus;
  lastError?: string;
  lastSyncedAt?: number;
}

/**
 * Result of an addSource operation.
 */
export interface AddSourceResult {
  id: string;
  status: SourceStatus;
}

/**
 * Factory function type for creating connector instances.
 * Used by the adapter registry to instantiate connectors on demand.
 */
export type ConnectorFactory = (projectRoot: string) => KBConnector;

/**
 * ImportValidator interface — validates that a module/adapter is permitted
 * before dynamic loading.
 */
export interface ImportValidator {
  /**
   * Validates whether a connector adapter module is permitted.
   * @param adapterType - The connector type identifier to validate
   * @returns true if the adapter is allowed, false otherwise
   */
  validate(adapterType: string): boolean;
}

/**
 * Configuration for the ConnectorFramework.
 */
export interface ConnectorFrameworkConfig {
  /** Project root path used for PathGuard validation. */
  projectRoot: string;
  /** Project identifier for scoping data. */
  projectId: string;
  /** Session ID used for EventLog emissions. */
  sessionId: string;
}

// ─── Errors ─────────────────────────────────────────────────────

export class ConnectorFrameworkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ConnectorFrameworkError';
  }
}

export class AdapterRegistrationError extends ConnectorFrameworkError {
  constructor(adapterType: string, reason: string) {
    super(
      `Failed to register adapter "${adapterType}": ${reason}`,
      'ADAPTER_REGISTRATION_FAILED',
    );
    this.name = 'AdapterRegistrationError';
  }
}

export class SourceNotFoundError extends ConnectorFrameworkError {
  constructor(sourceId: string) {
    super(`Source "${sourceId}" not found`, 'SOURCE_NOT_FOUND');
    this.name = 'SourceNotFoundError';
  }
}

// ─── Connector Framework ────────────────────────────────────────

/**
 * ConnectorFramework — the central orchestrator for connector adapters.
 *
 * Responsibilities:
 * 1. Register connector adapters by type (registry pattern)
 * 2. Validate adapters against ImportValidator before registration
 * 3. Orchestrate the connect → list → fetch lifecycle
 * 4. Catch unhandled errors, emit structured error events, mark source as failed
 * 5. Mask credentials in all log output and event payloads
 * 6. Provide high-level API: addSource, removeSource, reindexSource
 */
export class ConnectorFramework {
  /** Registry of connector factories keyed by connector type. */
  private readonly adapterRegistry: Map<ConnectorType, ConnectorFactory> = new Map();

  /** Tracked sources keyed by source ID. */
  private readonly sources: Map<string, ManagedSource> = new Map();

  /** Active connector instances keyed by source ID. */
  private readonly activeConnectors: Map<string, KBConnector> = new Map();

  constructor(
    private readonly config: ConnectorFrameworkConfig,
    private readonly eventLog: EventLog,
    private readonly importValidator: ImportValidator,
    private readonly credentialVault?: CredentialVault,
  ) {}

  // ─── Adapter Registration ───────────────────────────────────

  /**
   * Register a connector adapter factory for a given connector type.
   * Validates the adapter against the ImportValidator before registration.
   *
   * @param type - The connector type to register
   * @param factory - Factory function that creates connector instances
   * @throws AdapterRegistrationError if ImportValidator rejects the adapter
   */
  registerAdapter(type: ConnectorType, factory: ConnectorFactory): void {
    // Validate adapter with ImportValidator before registration
    if (!this.importValidator.validate(type)) {
      throw new AdapterRegistrationError(
        type,
        'Import validation failed — adapter module is not in the allowlist',
      );
    }

    this.adapterRegistry.set(type, factory);
  }

  /**
   * Check if an adapter is registered for a given connector type.
   */
  hasAdapter(type: ConnectorType): boolean {
    return this.adapterRegistry.has(type);
  }

  /**
   * Get all registered adapter types.
   */
  getRegisteredTypes(): ConnectorType[] {
    return Array.from(this.adapterRegistry.keys());
  }

  // ─── Source Management ──────────────────────────────────────

  /**
   * Add a new knowledge source. Creates a connector, connects to the source,
   * and begins the list → fetch lifecycle.
   *
   * On success, returns the source ID and status.
   * On failure, catches the error, emits an error event, and marks the source as failed.
   *
   * @param sourceId - Unique identifier for the source
   * @param config - Connector configuration
   * @returns AddSourceResult with the source ID and current status
   */
  async addSource(sourceId: string, config: ConnectorConfig): Promise<AddSourceResult> {
    // Check adapter is registered
    if (!this.adapterRegistry.has(config.type)) {
      const error = `No adapter registered for connector type "${config.type}"`;
      await this.emitErrorEvent(sourceId, config.uri, error, 'validate');
      return { id: sourceId, status: 'error' };
    }

    // Create and track the source
    const source: ManagedSource = {
      id: sourceId,
      config,
      status: 'idle',
    };
    this.sources.set(sourceId, source);

    // Create connector instance from factory
    const factory = this.adapterRegistry.get(config.type)!;
    const connector = factory(this.config.projectRoot);

    try {
      // Connect to the source
      source.status = 'indexing';
      await connector.connect(config);
      this.activeConnectors.set(sourceId, connector);
      source.lastSyncedAt = Date.now();
      source.status = 'idle';

      return { id: sourceId, status: 'idle' };
    } catch (error) {
      return this.handleSourceError(sourceId, config.uri, error);
    }
  }

  /**
   * Remove a source from the framework. Disconnects any active connector
   * and removes all tracking state.
   *
   * @param sourceId - The source to remove
   * @throws SourceNotFoundError if the source does not exist
   */
  async removeSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new SourceNotFoundError(sourceId);
    }

    // Disconnect active connector if present
    const connector = this.activeConnectors.get(sourceId);
    if (connector) {
      try {
        await connector.disconnect();
      } catch {
        // Best-effort disconnect — don't fail the removal
      }
      this.activeConnectors.delete(sourceId);
    }

    this.sources.delete(sourceId);
  }

  /**
   * Re-index a source by running the full connect → list → fetch lifecycle.
   * Catches any unhandled errors, emits events, and marks source as failed.
   *
   * @param sourceId - The source to re-index
   * @returns AsyncIterable of RawDocuments fetched from the source
   * @throws SourceNotFoundError if the source does not exist
   */
  async *reindexSource(sourceId: string): AsyncIterable<RawDocument> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new SourceNotFoundError(sourceId);
    }

    const config = source.config;

    // Check adapter is still registered
    if (!this.adapterRegistry.has(config.type)) {
      await this.emitErrorEvent(sourceId, config.uri, `No adapter for type "${config.type}"`, 'validate');
      source.status = 'error';
      source.lastError = `No adapter for type "${config.type}"`;
      return;
    }

    const factory = this.adapterRegistry.get(config.type)!;
    const connector = factory(this.config.projectRoot);

    try {
      // Connect
      source.status = 'indexing';
      await connector.connect(config);
      this.activeConnectors.set(sourceId, connector);

      // List entries
      let entries: SourceEntry[];
      try {
        entries = await connector.list();
      } catch (listError) {
        await this.handleSourceError(sourceId, config.uri, listError);
        return;
      }

      // Fetch documents — catch unhandled errors from the adapter's fetch()
      try {
        for await (const doc of connector.fetch(entries)) {
          yield doc;
        }
      } catch (fetchError) {
        // Requirement 1.6: Catch unhandled fetch errors, emit event, mark as failed
        await this.handleSourceError(sourceId, config.uri, fetchError);
        return;
      }

      // Success: mark idle
      source.status = 'idle';
      source.lastError = undefined;
      source.lastSyncedAt = Date.now();
    } catch (error) {
      // Catch any other unhandled errors in the lifecycle
      await this.handleSourceError(sourceId, config.uri, error);
    } finally {
      // Disconnect the connector
      try {
        await connector.disconnect();
      } catch {
        // Best-effort disconnect
      }
      this.activeConnectors.delete(sourceId);
    }
  }

  /**
   * Fetch documents from a source. Orchestrates connect → list → fetch → disconnect.
   * Catches unhandled fetch errors, emits structured events, marks source as failed.
   *
   * @param sourceId - The source to fetch from
   * @returns AsyncIterable of RawDocuments
   */
  async *fetchSource(sourceId: string): AsyncIterable<RawDocument> {
    yield* this.reindexSource(sourceId);
  }

  // ─── Query ──────────────────────────────────────────────────

  /**
   * Get the current status of a managed source.
   */
  getSourceStatus(sourceId: string): ManagedSource | undefined {
    return this.sources.get(sourceId);
  }

  /**
   * List all managed sources.
   */
  listSources(): ManagedSource[] {
    return Array.from(this.sources.values());
  }

  // ─── Error Handling (Private) ───────────────────────────────

  /**
   * Handle an error from a source operation.
   * - Masks credentials from the error message
   * - Emits a structured error event to the EventLog
   * - Marks the source as failed (error or auth-failed)
   */
  private async handleSourceError(
    sourceId: string,
    sourceUri: string,
    error: unknown,
  ): Promise<AddSourceResult> {
    const source = this.sources.get(sourceId);
    const rawMessage = error instanceof Error ? error.message : String(error);

    // Mask any credential values from the error message
    const maskedMessage = maskCredentials(rawMessage);

    // Determine if this is an authentication failure
    const isAuthError = this.isAuthenticationError(error);
    const status: SourceStatus = isAuthError ? 'auth-failed' : 'error';

    if (source) {
      source.status = status;
      source.lastError = maskedMessage;
    }

    // Emit structured error event with masked message
    await this.emitErrorEvent(sourceId, sourceUri, maskedMessage, 'fetch');

    return { id: sourceId, status };
  }

  /**
   * Determines if an error is authentication-related.
   * Used to differentiate 'error' vs 'auth-failed' source status.
   */
  private isAuthenticationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
      msg.includes('authentication') ||
      msg.includes('auth') ||
      msg.includes('unauthorized') ||
      msg.includes('403') ||
      msg.includes('401') ||
      msg.includes('credential') ||
      msg.includes('permission denied') ||
      error.name === 'GitAuthenticationError'
    );
  }

  /**
   * Emit a structured KB ingest error event to the EventLog.
   * All event payloads pass through credential masking.
   */
  private async emitErrorEvent(
    sourceId: string,
    sourceUri: string,
    errorMessage: string,
    phase: 'fetch' | 'chunk' | 'embed' | 'index' | 'validate',
  ): Promise<void> {
    // Mask credentials in the source URI as well
    const maskedUri = maskCredentials(sourceUri);
    const maskedError = maskCredentials(errorMessage);

    await this.eventLog.emit({
      sessionId: this.config.sessionId,
      kind: KB_EVENT_KINDS.INGEST_ERROR as EventKind,
      payload: {
        sourceUri: maskedUri,
        sourceId,
        projectId: this.config.projectId,
        error: maskedError,
        phase,
      },
    });
  }
}
