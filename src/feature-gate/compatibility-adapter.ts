/**
 * Compatibility Adapter Framework
 *
 * Preserves readable legacy projects and live IPC callers through versioned adapters.
 * Adapters provide deprecation telemetry and enforce explicit ownership boundaries
 * that cannot mutate new authorities.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.8
 */

import type { EditorChatGateId } from './editor-chat-gates.js';

// ─── Adapter Types ──────────────────────────────────────────────

/**
 * Direction of compatibility:
 * - 'legacy_to_new': wraps a legacy caller to work with new authority
 * - 'new_to_legacy': wraps new behavior to remain compatible with old callers
 */
export type AdapterDirection = 'legacy_to_new' | 'new_to_legacy';

/**
 * Permission level an adapter has over the new authority.
 * Adapters are read-only by design — they cannot mutate new authorities.
 */
export type AdapterPermission = 'read_only' | 'read_with_projection';

export interface CompatibilityAdapterDescriptor {
  /** Unique identifier for this adapter */
  id: string;
  /** Which gate this adapter bridges */
  gateId: EditorChatGateId;
  /** Version of the adapter protocol */
  version: number;
  /** Direction of compatibility wrapping */
  direction: AdapterDirection;
  /** What the adapter is adapting (e.g. 'ipc:file-open', 'store:task-status') */
  surface: string;
  /** Permission level - adapters cannot mutate new authorities */
  permission: AdapterPermission;
  /** Description of what the adapter does */
  description: string;
  /** Whether the legacy path is deprecated */
  deprecated: boolean;
  /** When the deprecation was announced */
  deprecatedSince: string | null;
}

// ─── Deprecation Telemetry ──────────────────────────────────────

export interface DeprecationEvent {
  /** Adapter that was invoked */
  adapterId: string;
  /** Gate that owns this adapter */
  gateId: EditorChatGateId;
  /** The legacy surface that was called */
  surface: string;
  /** Timestamp of invocation */
  timestamp: string;
  /** Caller identifier (IPC channel name, module, etc.) */
  caller: string;
  /** How many times this path has been used in this session */
  sessionCount: number;
}

// ─── Ownership Boundary ─────────────────────────────────────────

/**
 * Represents an explicit ownership boundary.
 * Adapters and legacy code paths cannot mutate entities owned by new authorities.
 */
export interface OwnershipBoundary {
  /** The entity type that is protected */
  entityType: string;
  /** The new authority that owns this entity */
  authority: string;
  /** Which gate introduced this authority */
  gateId: EditorChatGateId;
  /** Operations that are blocked through the adapter */
  blockedOperations: string[];
  /** Operations that are allowed (read projections) */
  allowedOperations: string[];
}

// ─── Compatibility Adapter Service ──────────────────────────────

export class CompatibilityAdapterRegistry {
  private adapters: Map<string, CompatibilityAdapterDescriptor> = new Map();
  private deprecationCounts: Map<string, number> = new Map();
  private deprecationLog: DeprecationEvent[] = [];
  private ownershipBoundaries: OwnershipBoundary[] = [];

  /**
   * Register a compatibility adapter.
   */
  register(descriptor: CompatibilityAdapterDescriptor): void {
    if (this.adapters.has(descriptor.id)) {
      throw new Error(`Adapter '${descriptor.id}' is already registered`);
    }
    this.adapters.set(descriptor.id, descriptor);
  }

  /**
   * Get an adapter by ID.
   */
  getAdapter(id: string): CompatibilityAdapterDescriptor | undefined {
    return this.adapters.get(id);
  }

  /**
   * Get all adapters for a specific gate.
   */
  getAdaptersForGate(gateId: EditorChatGateId): CompatibilityAdapterDescriptor[] {
    return Array.from(this.adapters.values()).filter((a) => a.gateId === gateId);
  }

  /**
   * Get all deprecated adapters still in use.
   */
  getActiveDeprecatedAdapters(): CompatibilityAdapterDescriptor[] {
    return Array.from(this.adapters.values()).filter(
      (a) => a.deprecated && (this.deprecationCounts.get(a.id) ?? 0) > 0,
    );
  }

  /**
   * Record a deprecation event when a legacy path is used.
   */
  recordDeprecation(adapterId: string, caller: string): DeprecationEvent | null {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return null;

    const count = (this.deprecationCounts.get(adapterId) ?? 0) + 1;
    this.deprecationCounts.set(adapterId, count);

    const event: DeprecationEvent = {
      adapterId,
      gateId: adapter.gateId,
      surface: adapter.surface,
      timestamp: new Date().toISOString(),
      caller,
      sessionCount: count,
    };

    this.deprecationLog.push(event);
    return event;
  }

  /**
   * Get deprecation telemetry for reporting.
   */
  getDeprecationTelemetry(): {
    totalEvents: number;
    byAdapter: Record<string, number>;
    byGate: Record<EditorChatGateId, number>;
    recentEvents: DeprecationEvent[];
  } {
    const byAdapter: Record<string, number> = {};
    const byGate: Partial<Record<EditorChatGateId, number>> = {};

    for (const [adapterId, count] of this.deprecationCounts) {
      byAdapter[adapterId] = count;
      const adapter = this.adapters.get(adapterId);
      if (adapter) {
        byGate[adapter.gateId] = (byGate[adapter.gateId] ?? 0) + count;
      }
    }

    return {
      totalEvents: this.deprecationLog.length,
      byAdapter,
      byGate: byGate as Record<EditorChatGateId, number>,
      recentEvents: this.deprecationLog.slice(-50),
    };
  }

  /**
   * Register an ownership boundary.
   */
  addOwnershipBoundary(boundary: OwnershipBoundary): void {
    this.ownershipBoundaries.push(boundary);
  }

  /**
   * Check if an operation is allowed through an adapter for a given entity type.
   * Adapters cannot mutate new authorities.
   */
  isOperationAllowed(entityType: string, operation: string, gateId: EditorChatGateId): boolean {
    const boundary = this.ownershipBoundaries.find(
      (b) => b.entityType === entityType && b.gateId === gateId,
    );
    if (!boundary) {
      // No boundary defined - operation is allowed (legacy behavior)
      return true;
    }
    if (boundary.blockedOperations.includes(operation)) {
      return false;
    }
    if (boundary.allowedOperations.length > 0) {
      return boundary.allowedOperations.includes(operation);
    }
    return true;
  }

  /**
   * Get all ownership boundaries for a gate.
   */
  getBoundariesForGate(gateId: EditorChatGateId): OwnershipBoundary[] {
    return this.ownershipBoundaries.filter((b) => b.gateId === gateId);
  }

  /**
   * Reset session telemetry (useful for testing).
   */
  resetTelemetry(): void {
    this.deprecationCounts.clear();
    this.deprecationLog = [];
  }
}
