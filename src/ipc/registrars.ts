/**
 * Dedicated IPC Registrars
 *
 * Provides category-specific registrars for typed IPC contracts:
 * - RequestResponseRegistrar: schema-validated invoke channels
 * - CancellationRegistrar: in-flight request cancellation
 * - SnapshotRegistrar: authoritative state synchronization (main → renderer)
 * - OrderedEventRegistrar: domain events with sequence ordering (main → renderer)
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

import type {
  IPCContractDefinition,
  IPCContractRegistry,
  IPCRequest,
  IPCResponse,
  IPCSnapshot,
  IPCOrderedEvent,
  IPCCancellationRequest,
  IPCError,
  CancellationToken,
  IPCPrivilegeTier,
} from './contracts';
import {
  IPC_CONTRACT_VERSION,
  isValidRequest,
  isValidCancellation,
} from './contracts';

// ─── ID Generation ──────────────────────────────────────────────────────────

let messageCounter = 0;

/**
 * Generate a unique message ID combining timestamp and counter.
 */
export function generateMessageId(): string {
  return `ipc_${Date.now()}_${++messageCounter}`;
}

// ─── Cancellation Manager ───────────────────────────────────────────────────

/**
 * Manages active cancellation tokens for in-flight IPC requests.
 */
export class CancellationManager {
  private readonly tokens = new Map<string, CancellationToken>();

  create(reason?: string): CancellationToken {
    const token: CancellationToken = {
      tokenId: generateMessageId(),
      createdAt: Date.now(),
      reason,
      cancelled: false,
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  cancel(tokenId: string, reason?: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.cancelled) return false;
    token.cancelled = true;
    if (reason) {
      (token as { reason?: string }).reason = reason;
    }
    return true;
  }

  isCancelled(tokenId: string): boolean {
    return this.tokens.get(tokenId)?.cancelled ?? false;
  }

  remove(tokenId: string): void {
    this.tokens.delete(tokenId);
  }

  get activeCount(): number {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (!token.cancelled) count++;
    }
    return count;
  }

  clear(): void {
    this.tokens.clear();
  }
}

// ─── Request/Response Registrar ─────────────────────────────────────────────

/**
 * Handles registration and dispatch of request/response IPC contracts.
 * Validates schemas, enforces privilege tiers, and manages timeouts.
 */
export class RequestResponseRegistrar {
  private readonly contracts = new Map<string, IPCContractDefinition>();
  private readonly cancellationManager = new CancellationManager();

  /**
   * Register a typed request/response contract.
   */
  register<TReq, TRes>(definition: IPCContractDefinition<TReq, TRes>): void {
    if (this.contracts.has(definition.channel)) {
      throw new Error(`Contract already registered for channel: ${definition.channel}`);
    }
    if (definition.category !== 'request-response') {
      throw new Error(`Invalid category for RequestResponseRegistrar: ${definition.category}`);
    }
    this.contracts.set(definition.channel, definition as IPCContractDefinition);
  }

  /**
   * Validate and dispatch a request, returning a typed response.
   */
  validateRequest(request: unknown): { valid: true; parsed: IPCRequest } | { valid: false; error: IPCError } {
    if (!isValidRequest(request)) {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_REQUEST',
          message: 'Request does not conform to IPCRequest schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const contract = this.contracts.get(request.channel);
    if (!contract) {
      return {
        valid: false,
        error: {
          code: 'UNKNOWN_CHANNEL',
          message: `No contract registered for channel: ${request.channel}`,
          category: 'validation',
          retryable: false,
        },
      };
    }

    if (!contract.validateRequest(request.payload)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_PAYLOAD',
          message: `Request payload does not match schema for channel: ${request.channel}`,
          category: 'validation',
          retryable: false,
        },
      };
    }

    return { valid: true, parsed: request };
  }

  /**
   * Create a cancellation token for a cancellable request.
   */
  createCancellationToken(channel: string): CancellationToken | null {
    const contract = this.contracts.get(channel);
    if (!contract?.cancellable) return null;
    return this.cancellationManager.create();
  }

  /**
   * Cancel an in-flight request by token ID.
   */
  cancelRequest(tokenId: string, reason?: string): boolean {
    return this.cancellationManager.cancel(tokenId, reason);
  }

  /**
   * Check if a contract exists for the given channel.
   */
  hasContract(channel: string): boolean {
    return this.contracts.has(channel);
  }

  /**
   * Get the contract definition for a channel.
   */
  getContract(channel: string): IPCContractDefinition | undefined {
    return this.contracts.get(channel);
  }

  /**
   * Get all registered contracts.
   */
  getRegistry(): IPCContractRegistry {
    return {
      version: IPC_CONTRACT_VERSION,
      contracts: new Map(this.contracts),
    };
  }

  get registeredCount(): number {
    return this.contracts.size;
  }
}

// ─── Cancellation Registrar ─────────────────────────────────────────────────

/**
 * Handles cancellation-specific IPC messages.
 * Validates cancellation requests and coordinates with the CancellationManager.
 */
export class CancellationRegistrar {
  private readonly manager: CancellationManager;
  private readonly listeners = new Map<string, Set<(tokenId: string, reason?: string) => void>>();

  constructor(manager?: CancellationManager) {
    this.manager = manager ?? new CancellationManager();
  }

  /**
   * Validate a cancellation request.
   */
  validateCancellation(request: unknown): { valid: true; tokenId: string; reason?: string } | { valid: false; error: IPCError } {
    if (!isValidCancellation(request)) {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_CANCELLATION',
          message: 'Cancellation request does not conform to schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const { tokenId, reason } = request.payload;
    return { valid: true, tokenId, reason };
  }

  /**
   * Process a validated cancellation.
   */
  processCancellation(tokenId: string, reason?: string): boolean {
    const cancelled = this.manager.cancel(tokenId, reason);
    if (cancelled) {
      const listeners = this.listeners.get(tokenId);
      if (listeners) {
        for (const listener of listeners) {
          listener(tokenId, reason);
        }
        this.listeners.delete(tokenId);
      }
    }
    return cancelled;
  }

  /**
   * Subscribe to cancellation of a specific token.
   */
  onCancelled(tokenId: string, callback: (tokenId: string, reason?: string) => void): void {
    let set = this.listeners.get(tokenId);
    if (!set) {
      set = new Set();
      this.listeners.set(tokenId, set);
    }
    set.add(callback);
  }

  /**
   * Create a new cancellation token.
   */
  createToken(reason?: string): CancellationToken {
    return this.manager.create(reason);
  }

  /**
   * Check if a token is cancelled.
   */
  isCancelled(tokenId: string): boolean {
    return this.manager.isCancelled(tokenId);
  }

  get activeTokenCount(): number {
    return this.manager.activeCount;
  }
}

// ─── Snapshot Registrar ─────────────────────────────────────────────────────

/**
 * Manages state snapshot contracts for main → renderer synchronization.
 * Tracks domain versions and validates snapshot ordering.
 */
export class SnapshotRegistrar {
  private readonly domainVersions = new Map<string, number>();
  private readonly domainFingerprints = new Map<string, string>();

  /**
   * Validate and process an incoming snapshot.
   * Rejects out-of-order or stale snapshots.
   */
  validateSnapshot(snapshot: unknown): { valid: true; snapshot: IPCSnapshot } | { valid: false; error: IPCError } {
    if (snapshot === null || typeof snapshot !== 'object') {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_SNAPSHOT',
          message: 'Snapshot does not conform to IPCSnapshot schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const obj = snapshot as Record<string, unknown>;
    if (
      obj.kind !== 'snapshot' ||
      typeof obj.domain !== 'string' ||
      !obj.domain ||
      typeof obj.version !== 'number' ||
      typeof obj.fingerprint !== 'string' ||
      typeof obj.mode !== 'string' ||
      !['full', 'delta'].includes(obj.mode as string)
    ) {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_SNAPSHOT',
          message: 'Snapshot does not conform to IPCSnapshot schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const domain = obj.domain as string;
    const version = obj.version as number;
    const currentVersion = this.domainVersions.get(domain) ?? -1;

    if (version <= currentVersion) {
      return {
        valid: false,
        error: {
          code: 'STALE_SNAPSHOT',
          message: `Snapshot version ${version} is not newer than current ${currentVersion} for domain ${domain}`,
          category: 'validation',
          retryable: false,
        },
      };
    }

    if (obj.mode === 'delta' && typeof obj.baseVersion === 'number') {
      if (obj.baseVersion !== currentVersion) {
        return {
          valid: false,
          error: {
            code: 'DELTA_BASE_MISMATCH',
            message: `Delta baseVersion ${obj.baseVersion} does not match current version ${currentVersion}`,
            category: 'validation',
            retryable: true,
          },
        };
      }
    }

    // Accept the snapshot
    this.domainVersions.set(domain, version);
    this.domainFingerprints.set(domain, obj.fingerprint as string);

    return { valid: true, snapshot: snapshot as IPCSnapshot };
  }

  /**
   * Get the current version for a domain.
   */
  getDomainVersion(domain: string): number {
    return this.domainVersions.get(domain) ?? -1;
  }

  /**
   * Get the current fingerprint for a domain.
   */
  getDomainFingerprint(domain: string): string | undefined {
    return this.domainFingerprints.get(domain);
  }

  /**
   * Reset state for a domain (e.g., after reconnection).
   */
  resetDomain(domain: string): void {
    this.domainVersions.delete(domain);
    this.domainFingerprints.delete(domain);
  }

  /**
   * Reset all domains.
   */
  resetAll(): void {
    this.domainVersions.clear();
    this.domainFingerprints.clear();
  }

  get trackedDomainCount(): number {
    return this.domainVersions.size;
  }
}

// ─── Ordered Event Registrar ────────────────────────────────────────────────

/**
 * Manages ordered domain event contracts.
 * Guarantees events are processed in sequence order within a session,
 * with deduplication of already-processed events.
 */
export class OrderedEventRegistrar {
  /** Maps sessionId → last processed sequence number */
  private readonly sessionSequences = new Map<string, number>();
  /** Set of already-processed event IDs for deduplication */
  private readonly processedIds = new Set<string>();
  /** Maximum number of processed IDs to retain (prevents unbounded growth) */
  private readonly maxProcessedIds: number;

  constructor(maxProcessedIds = 10_000) {
    this.maxProcessedIds = maxProcessedIds;
  }

  /**
   * Validate and accept an ordered event.
   * Rejects duplicates and out-of-order events.
   */
  validateEvent(event: unknown): { valid: true; event: IPCOrderedEvent } | { valid: false; error: IPCError } {
    if (event === null || typeof event !== 'object') {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_EVENT',
          message: 'Event does not conform to IPCOrderedEvent schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const obj = event as Record<string, unknown>;
    if (
      obj.kind !== 'ordered-event' ||
      typeof obj.eventType !== 'string' ||
      !obj.eventType ||
      typeof obj.sequence !== 'number' ||
      typeof obj.sessionId !== 'string' ||
      !obj.sessionId ||
      typeof obj.sourceDomain !== 'string' ||
      !obj.sourceDomain ||
      typeof obj.messageId !== 'string' ||
      !obj.messageId
    ) {
      return {
        valid: false,
        error: {
          code: 'MALFORMED_EVENT',
          message: 'Event does not conform to IPCOrderedEvent schema',
          category: 'validation',
          retryable: false,
        },
      };
    }

    const messageId = obj.messageId as string;
    const sessionId = obj.sessionId as string;
    const sequence = obj.sequence as number;

    // Deduplication check
    if (this.processedIds.has(messageId)) {
      return {
        valid: false,
        error: {
          code: 'DUPLICATE_EVENT',
          message: `Event ${messageId} has already been processed`,
          category: 'validation',
          retryable: false,
        },
      };
    }

    // Sequence ordering check
    const lastSequence = this.sessionSequences.get(sessionId) ?? -1;
    if (sequence <= lastSequence) {
      return {
        valid: false,
        error: {
          code: 'OUT_OF_ORDER_EVENT',
          message: `Event sequence ${sequence} is not newer than last processed ${lastSequence} for session ${sessionId}`,
          category: 'validation',
          retryable: false,
        },
      };
    }

    // Accept the event
    this.sessionSequences.set(sessionId, sequence);
    this.processedIds.add(messageId);

    // Prevent unbounded growth
    if (this.processedIds.size > this.maxProcessedIds) {
      const iterator = this.processedIds.values();
      const first = iterator.next().value;
      if (first) this.processedIds.delete(first);
    }

    return { valid: true, event: event as IPCOrderedEvent };
  }

  /**
   * Get last processed sequence for a session.
   */
  getLastSequence(sessionId: string): number {
    return this.sessionSequences.get(sessionId) ?? -1;
  }

  /**
   * Reset a session's sequence tracking (e.g., after reconnection).
   */
  resetSession(sessionId: string): void {
    this.sessionSequences.delete(sessionId);
  }

  /**
   * Reset all state.
   */
  resetAll(): void {
    this.sessionSequences.clear();
    this.processedIds.clear();
  }

  get trackedSessionCount(): number {
    return this.sessionSequences.size;
  }
}

// ─── Compatibility Bridge ───────────────────────────────────────────────────

/**
 * Maps existing preload.ts channel names to typed contract metadata.
 * Enables incremental migration: old callers still work, new callers get types.
 */
export interface CompatibilityMapping {
  readonly legacyChannel: string;
  readonly contractChannel: string;
  readonly tier: IPCPrivilegeTier;
  readonly deprecated: boolean;
  readonly deprecatedSince?: number;
}

/**
 * Builds compatibility mappings from the existing preload.ts channel lists.
 * This ensures new typed contracts coexist with existing untyped channels
 * during staged migration (Requirement 28.2).
 */
export function buildCompatibilityMappings(
  existingInvokeChannels: readonly string[],
  existingTierFn: (channel: string) => IPCPrivilegeTier,
): CompatibilityMapping[] {
  return existingInvokeChannels.map((channel) => ({
    legacyChannel: channel,
    contractChannel: channel,
    tier: existingTierFn(channel),
    deprecated: false,
  }));
}
