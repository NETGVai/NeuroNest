/**
 * LanguageServiceGateway — Capability-driven LSP synchronization.
 *
 * Manages language service lifecycle per workspace/language pair with states:
 * starting, ready, degraded, reconnecting, failed, stopped.
 *
 * Replaces the empty-result client boundary with real JSON-RPC clients
 * managed by the existing language-server process manager.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.7, 3.9, 3.10
 */

import { EventEmitter } from 'node:events';
import { DocumentSyncSequencer } from './document-sync-sequencer.js';
import { CapabilityRegistry, type ServerCapabilities } from './capability-registry.js';
import { LanguageServiceStatus, type LanguageServiceStatusSnapshot } from './language-service-status.js';

// ─── Types ──────────────────────────────────────────────────────

/** Lifecycle states for a language service per workspace/language pair */
export type ServiceLifecycleState =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'failed'
  | 'stopped';

/** Supported language identifiers for the initial baseline */
export type BaselineLanguage = 'typescript' | 'javascript' | 'python';

/** Unique key for a workspace/language pair */
export interface ServiceKey {
  workspaceId: string;
  language: BaselineLanguage;
}

/** Request envelope for all LSP requests */
export interface LspRequestEnvelope {
  workspaceId: string;
  canonicalUri: string;
  documentVersion: number;
  requestId: string;
}

/** Events emitted by the LanguageServiceGateway */
export interface GatewayEvents {
  'service:stateChange': {
    key: ServiceKey;
    previousState: ServiceLifecycleState;
    newState: ServiceLifecycleState;
  };
  'service:capabilitiesRegistered': {
    key: ServiceKey;
    capabilities: ServerCapabilities;
  };
  'service:error': {
    key: ServiceKey;
    error: Error;
  };
}

/** Configuration for gateway behavior */
export interface GatewayConfig {
  /** Maximum reconnection attempts before failing */
  maxReconnectAttempts: number;
  /** Base delay for exponential backoff in ms */
  reconnectBaseDelayMs: number;
  /** Maximum delay cap for reconnection in ms */
  reconnectMaxDelayMs: number;
  /** Request timeout in ms */
  requestTimeoutMs: number;
}

/** Represents one managed language service instance */
export interface ManagedService {
  key: ServiceKey;
  state: ServiceLifecycleState;
  sequencer: DocumentSyncSequencer;
  capabilities: CapabilityRegistry;
  status: LanguageServiceStatus;
  reconnectAttempts: number;
  startedAt: number | null;
  lastStateChange: number;
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  maxReconnectAttempts: 5,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  requestTimeoutMs: 10000,
};

/** Valid state transitions */
const VALID_TRANSITIONS: Record<ServiceLifecycleState, ServiceLifecycleState[]> = {
  starting: ['ready', 'failed', 'stopped'],
  ready: ['degraded', 'reconnecting', 'failed', 'stopped'],
  degraded: ['ready', 'reconnecting', 'failed', 'stopped'],
  reconnecting: ['ready', 'degraded', 'failed', 'stopped'],
  failed: ['starting', 'stopped'],
  stopped: ['starting'],
};

// ─── LanguageServiceGateway ─────────────────────────────────────

/**
 * LanguageServiceGateway — Central LSP lifecycle coordinator.
 *
 * Manages one service instance per workspace/language pair.
 * Coordinates document synchronization, capability registration,
 * and status reporting while keeping protocol work off the renderer thread.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.7, 3.9, 3.10
 */
export class LanguageServiceGateway extends EventEmitter {
  private services: Map<string, ManagedService> = new Map();
  private config: GatewayConfig;

  constructor(config?: Partial<GatewayConfig>) {
    super();
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
  }

  // ─── Service Key ────────────────────────────────────────────────

  /** Generate a unique map key from a ServiceKey */
  private toMapKey(key: ServiceKey): string {
    return `${key.workspaceId}::${key.language}`;
  }

  // ─── Lifecycle Management ───────────────────────────────────────

  /**
   * Start a language service for a workspace/language pair.
   * Transitions from stopped -> starting -> ready (or failed).
   *
   * Requirements: 3.1
   */
  startService(key: ServiceKey): ManagedService {
    const mapKey = this.toMapKey(key);
    const existing = this.services.get(mapKey);

    if (existing && existing.state !== 'stopped' && existing.state !== 'failed') {
      return existing;
    }

    const service: ManagedService = {
      key,
      state: 'starting',
      sequencer: new DocumentSyncSequencer(key.workspaceId),
      capabilities: new CapabilityRegistry(),
      status: new LanguageServiceStatus(key),
      reconnectAttempts: 0,
      startedAt: Date.now(),
      lastStateChange: Date.now(),
    };

    this.services.set(mapKey, service);

    this.emit('service:stateChange', {
      key,
      previousState: existing?.state ?? 'stopped',
      newState: 'starting',
    });

    return service;
  }

  /**
   * Transition a service to the ready state.
   * Called when the language server has completed initialization.
   *
   * Requirements: 3.1
   */
  markReady(key: ServiceKey, capabilities?: ServerCapabilities): boolean {
    const service = this.getService(key);
    if (!service) return false;

    if (!this.isValidTransition(service.state, 'ready')) return false;

    const previousState = service.state;
    service.state = 'ready';
    service.lastStateChange = Date.now();
    service.reconnectAttempts = 0;

    if (capabilities) {
      service.capabilities.registerCapabilities(capabilities);
      this.emit('service:capabilitiesRegistered', { key, capabilities });
    }

    service.status.recordStateChange('ready');

    this.emit('service:stateChange', { key, previousState, newState: 'ready' });
    return true;
  }

  /**
   * Transition a service to the degraded state.
   * Called when the service is partially functioning.
   *
   * Requirements: 3.1
   */
  markDegraded(key: ServiceKey, reason?: string): boolean {
    const service = this.getService(key);
    if (!service) return false;

    if (!this.isValidTransition(service.state, 'degraded')) return false;

    const previousState = service.state;
    service.state = 'degraded';
    service.lastStateChange = Date.now();

    if (reason) {
      service.status.recordError(new Error(reason));
    }
    service.status.recordStateChange('degraded');

    this.emit('service:stateChange', { key, previousState, newState: 'degraded' });
    return true;
  }

  /**
   * Transition a service to reconnecting state.
   * Called when the connection to the language server is lost.
   *
   * Requirements: 3.1, 3.8
   */
  markReconnecting(key: ServiceKey): boolean {
    const service = this.getService(key);
    if (!service) return false;

    if (!this.isValidTransition(service.state, 'reconnecting')) return false;

    const previousState = service.state;
    service.state = 'reconnecting';
    service.lastStateChange = Date.now();
    service.reconnectAttempts++;

    service.status.recordStateChange('reconnecting');

    this.emit('service:stateChange', { key, previousState, newState: 'reconnecting' });

    // Check if max attempts exceeded
    if (service.reconnectAttempts > this.config.maxReconnectAttempts) {
      this.markFailed(key, 'Maximum reconnection attempts exceeded');
      return true;
    }

    return true;
  }

  /**
   * Transition a service to failed state.
   *
   * Requirements: 3.1
   */
  markFailed(key: ServiceKey, reason?: string): boolean {
    const service = this.getService(key);
    if (!service) return false;

    if (!this.isValidTransition(service.state, 'failed')) return false;

    const previousState = service.state;
    service.state = 'failed';
    service.lastStateChange = Date.now();

    if (reason) {
      const error = new Error(reason);
      service.status.recordError(error);
      this.emit('service:error', { key, error });
    }
    service.status.recordStateChange('failed');

    this.emit('service:stateChange', { key, previousState, newState: 'failed' });
    return true;
  }

  /**
   * Stop a language service for a workspace/language pair.
   *
   * Requirements: 3.1
   */
  stopService(key: ServiceKey): boolean {
    const service = this.getService(key);
    if (!service) return false;

    if (!this.isValidTransition(service.state, 'stopped')) return false;

    const previousState = service.state;
    service.state = 'stopped';
    service.lastStateChange = Date.now();
    service.sequencer.reset();

    service.status.recordStateChange('stopped');

    this.emit('service:stateChange', { key, previousState, newState: 'stopped' });
    return true;
  }

  // ─── State Queries ──────────────────────────────────────────────

  /**
   * Get the current state of a service.
   */
  getServiceState(key: ServiceKey): ServiceLifecycleState | null {
    const service = this.getService(key);
    return service?.state ?? null;
  }

  /**
   * Get a managed service instance.
   */
  getService(key: ServiceKey): ManagedService | null {
    return this.services.get(this.toMapKey(key)) ?? null;
  }

  /**
   * Get all managed services.
   */
  getAllServices(): ManagedService[] {
    return Array.from(this.services.values());
  }

  /**
   * Get a service's status snapshot.
   *
   * Requirements: 3.9
   */
  getStatus(key: ServiceKey): LanguageServiceStatusSnapshot | null {
    const service = this.getService(key);
    if (!service) return null;
    return service.status.getSnapshot();
  }

  /**
   * Get the capability registry for a service.
   *
   * Requirements: 3.3, 3.4
   */
  getCapabilities(key: ServiceKey): CapabilityRegistry | null {
    const service = this.getService(key);
    return service?.capabilities ?? null;
  }

  /**
   * Get the document sync sequencer for a service.
   *
   * Requirements: 3.2
   */
  getSequencer(key: ServiceKey): DocumentSyncSequencer | null {
    const service = this.getService(key);
    return service?.sequencer ?? null;
  }

  /**
   * Get the reconnect delay for a service using exponential backoff.
   */
  getReconnectDelay(key: ServiceKey): number {
    const service = this.getService(key);
    if (!service) return this.config.reconnectBaseDelayMs;

    const delay = this.config.reconnectBaseDelayMs * Math.pow(2, service.reconnectAttempts - 1);
    return Math.min(delay, this.config.reconnectMaxDelayMs);
  }

  /**
   * Check if a request should be accepted based on service state.
   * Only ready and degraded services should accept new requests.
   */
  canAcceptRequests(key: ServiceKey): boolean {
    const state = this.getServiceState(key);
    return state === 'ready' || state === 'degraded';
  }

  /**
   * Record a successful request for status tracking.
   *
   * Requirements: 3.9
   */
  recordRequestSuccess(key: ServiceKey, latencyMs: number): void {
    const service = this.getService(key);
    if (!service) return;
    service.status.recordSuccess(latencyMs);
  }

  /**
   * Record a failed request for status tracking.
   *
   * Requirements: 3.9
   */
  recordRequestError(key: ServiceKey, error: Error): void {
    const service = this.getService(key);
    if (!service) return;
    service.status.recordError(error);
  }

  /**
   * Record a pending request.
   *
   * Requirements: 3.9
   */
  recordRequestStart(key: ServiceKey): void {
    const service = this.getService(key);
    if (!service) return;
    service.status.incrementPending();
  }

  /**
   * Record a completed (or cancelled) request.
   *
   * Requirements: 3.9
   */
  recordRequestEnd(key: ServiceKey): void {
    const service = this.getService(key);
    if (!service) return;
    service.status.decrementPending();
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Stop all services and clear internal state.
   */
  dispose(): void {
    for (const service of this.services.values()) {
      if (service.state !== 'stopped') {
        service.state = 'stopped';
        service.sequencer.reset();
      }
    }
    this.services.clear();
    this.removeAllListeners();
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Check if a state transition is valid.
   */
  isValidTransition(from: ServiceLifecycleState, to: ServiceLifecycleState): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }
}
