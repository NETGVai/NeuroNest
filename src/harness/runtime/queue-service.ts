/**
 * Queue Service — Revision-guarded follow-up, steer, and inject queues.
 *
 * Implements the Turn_Controller inbox queue system (Queue_Dock) with:
 * 1. Stable entry identities and revisions (Requirement 39.1)
 * 2. Revision-guarded mutations — stale revisions rejected (Requirement 39.4)
 * 3. Replayable mutation events persisted durably (Requirement 39.3)
 * 4. Queue types: follow-up, steer, inject (Requirement 15.2)
 * 5. Configurable placement: end, after-current, beginning (Requirement 39.1)
 * 6. Busy-enter policy inputs (Requirement 39.5–39.6)
 * 7. Projection-confirmed command outcomes (Requirement 39.13–39.16)
 * 8. Owner-scoped entries (Requirement 39.1, 39.11)
 * 9. Ordered delivery in committed order (Requirement 39.12)
 *
 * Requirements: 15.2, 39.1–39.18
 */

import {
  type QueueType,
  type EntryDeliveryState,
  type EntryPlacement,
  type BusyEnterPolicy,
  type QueueEntry,
  type QueueMutationCommand,
  type QueueMutationEvent,
  type MutationOutcome,
  type MutationOutcomeStatus,
  type QueueProjection,
  type QueueServiceConfig,
  type BusyEnterConfig,
  type AddEntryCommand,
  type EditEntryCommand,
  type RemoveEntryCommand,
  type ReorderEntryCommand,
  type PromoteEntryCommand,
  QueueMutationCommandSchema,
  DEFAULT_QUEUE_SERVICE_CONFIG,
} from './queue-schemas';

// ─── Port Interfaces ────────────────────────────────────────────

/**
 * Persistence port — abstracts durable storage operations.
 * In production, writes to Shared_Database harness_queue_entries table.
 */
export interface QueuePersistencePort {
  /** Persist a new queue entry atomically. Returns false on duplicate entryId. */
  persistEntry(entry: QueueEntry): boolean;

  /** Load an entry by ID. */
  loadEntry(entryId: string): QueueEntry | undefined;

  /** Load all entries for a session, optionally filtered by queue type and turn. */
  loadEntries(params: {
    sessionId: string;
    queueType?: QueueType;
    turnId?: string;
    deliveryState?: EntryDeliveryState;
  }): QueueEntry[];

  /** Update an entry atomically. Returns false if the entry doesn't exist. */
  updateEntry(entry: QueueEntry): boolean;

  /** Persist a mutation event durably. */
  persistMutationEvent(event: QueueMutationEvent): void;

  /** Load mutation events for replay. */
  loadMutationEvents(sessionId: string): QueueMutationEvent[];
}

/**
 * Event emitter port — notifies consumers of queue changes.
 */
export interface QueueEventPort {
  /** Emit a mutation event for projection updates. */
  emitMutationEvent(event: QueueMutationEvent): void;

  /** Emit a projection confirmation. */
  emitProjectionConfirmed(projection: QueueProjection): void;
}

/**
 * ID generator port for stable identities.
 */
export interface QueueIdGeneratorPort {
  /** Generate a stable unique entry ID. */
  generateEntryId(): string;

  /** Generate a unique event ID. */
  generateEventId(): string;
}

/**
 * Clock port for timestamps.
 */
export interface QueueClockPort {
  /** Current ISO 8601 timestamp. */
  now(): string;
}

// ─── Dependencies ───────────────────────────────────────────────

export interface QueueServiceDeps {
  persistence?: QueuePersistencePort;
  events?: QueueEventPort;
  idGenerator?: QueueIdGeneratorPort;
  clock?: QueueClockPort;
  config?: QueueServiceConfig;
}

// ─── Default implementations ────────────────────────────────────

/** In-memory persistence for testing and bootstrap. */
class InMemoryQueuePersistence implements QueuePersistencePort {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly mutationEvents: QueueMutationEvent[] = [];

  persistEntry(entry: QueueEntry): boolean {
    if (this.entries.has(entry.entryId)) return false;
    this.entries.set(entry.entryId, { ...entry });
    return true;
  }

  loadEntry(entryId: string): QueueEntry | undefined {
    const e = this.entries.get(entryId);
    return e ? { ...e } : undefined;
  }

  loadEntries(params: {
    sessionId: string;
    queueType?: QueueType;
    turnId?: string;
    deliveryState?: EntryDeliveryState;
  }): QueueEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.sessionId === params.sessionId)
      .filter((e) => !params.queueType || e.queueType === params.queueType)
      .filter((e) => !params.turnId || e.turnId === params.turnId)
      .filter((e) => !params.deliveryState || e.deliveryState === params.deliveryState)
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ ...e }));
  }

  updateEntry(entry: QueueEntry): boolean {
    if (!this.entries.has(entry.entryId)) return false;
    this.entries.set(entry.entryId, { ...entry });
    return true;
  }

  persistMutationEvent(event: QueueMutationEvent): void {
    this.mutationEvents.push({ ...event });
  }

  loadMutationEvents(sessionId: string): QueueMutationEvent[] {
    return this.mutationEvents
      .filter((e) => e.sessionId === sessionId)
      .map((e) => ({ ...e }));
  }
}

class DefaultQueueIdGenerator implements QueueIdGeneratorPort {
  private counter = 0;

  generateEntryId(): string {
    return `qentry_${Date.now()}_${++this.counter}`;
  }

  generateEventId(): string {
    return `qevt_${Date.now()}_${++this.counter}`;
  }
}

class DefaultQueueClock implements QueueClockPort {
  now(): string {
    return new Date().toISOString();
  }
}

class NoopQueueEvents implements QueueEventPort {
  emitMutationEvent(_event: QueueMutationEvent): void {}
  emitProjectionConfirmed(_projection: QueueProjection): void {}
}

// ─── Queue Service ──────────────────────────────────────────────

/**
 * The revision-guarded queue service implementing Queue_Dock behavior.
 *
 * All mutations are validated for:
 * - Correct entry identity (entry must exist for edit/remove/reorder/promote)
 * - Matching expected revision (stale revisions are rejected, Req 39.4)
 * - Owner scoping (entries scoped to their owner/session)
 * - Queue capacity (maxQueueSize)
 * - Incompatible subagent ownership (Req 39.11)
 *
 * Mutations are recorded as replayable events and can reconstruct state.
 */
export class QueueService {
  private readonly persistence: QueuePersistencePort;
  private readonly events: QueueEventPort;
  private readonly idGenerator: QueueIdGeneratorPort;
  private readonly clock: QueueClockPort;
  private readonly config: QueueServiceConfig;

  /** Tracks projection revision per session (monotonically increasing). */
  private readonly projectionRevisions = new Map<string, number>();

  /** Tracks pending (unconfirmed) entry IDs per session. */
  private readonly pendingEntries = new Map<string, Set<string>>();

  /** Tracks subagent ownership blocks per session. */
  private readonly subagentBlocks = new Map<string, { subagentId: string; reason: string }>();

  constructor(deps: QueueServiceDeps = {}) {
    this.persistence = deps.persistence ?? new InMemoryQueuePersistence();
    this.events = deps.events ?? new NoopQueueEvents();
    this.idGenerator = deps.idGenerator ?? new DefaultQueueIdGenerator();
    this.clock = deps.clock ?? new DefaultQueueClock();
    this.config = deps.config ?? DEFAULT_QUEUE_SERVICE_CONFIG;
  }

  // ─── Mutation Entry Point ───────────────────────────────────────

  /**
   * Execute a queue mutation command with revision-guarding.
   * Returns a MutationOutcome indicating committed, rejected, or pending status.
   *
   * Requirement 39.2-39.4, 39.9, 39.13-39.17
   */
  mutate(command: QueueMutationCommand): MutationOutcome {
    // Validate command schema
    const parsed = QueueMutationCommandSchema.safeParse(command);
    if (!parsed.success) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        reason: `Invalid command: ${parsed.error.message}`,
      });
    }

    // Check subagent ownership block (Requirement 39.11)
    const block = this.subagentBlocks.get(command.sessionId);
    if (block) {
      return this.buildOutcome(command.commandId, 'rejected_incompatible_owner', {
        reason: block.reason,
        owningSubagentId: block.subagentId,
      });
    }

    switch (command.kind) {
      case 'add':
        return this.handleAdd(command);
      case 'edit':
        return this.handleEdit(command);
      case 'remove':
        return this.handleRemove(command);
      case 'reorder':
        return this.handleReorder(command);
      case 'promote':
        return this.handlePromote(command);
    }
  }

  // ─── Add ────────────────────────────────────────────────────────

  private handleAdd(command: AddEntryCommand): MutationOutcome {
    const { sessionId, queueType, content, placement, actor, metadata, turnId } = command;

    // Check capacity
    const existing = this.persistence.loadEntries({ sessionId, queueType, deliveryState: 'queued' });
    if (existing.length >= this.config.maxQueueSize) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        reason: `Queue capacity reached (max ${this.config.maxQueueSize})`,
      });
    }

    // Compute position based on placement
    const position = this.computePosition(existing, placement);

    // Shift existing entries at or after the target position
    this.shiftPositions(existing, position);

    const now = this.clock.now();
    const entryId = this.idGenerator.generateEntryId();

    const entry: QueueEntry = {
      entryId,
      queueType,
      revision: 0,
      position,
      owner: actor,
      sessionId,
      turnId,
      deliveryState: 'queued',
      placement,
      content,
      metadata,
      createdAt: now,
      modifiedAt: now,
      schemaVersion: 1,
    };

    this.persistence.persistEntry(entry);

    // Record replayable mutation event (Requirement 39.3)
    const event = this.buildMutationEvent({
      commandId: command.commandId,
      mutationKind: 'add',
      entryId,
      priorRevision: 0,
      resultingRevision: 0,
      actor,
      sessionId,
      turnId,
      queueType,
      placement,
      contentSnapshot: content,
      metadataSnapshot: metadata,
      resultingPosition: position,
    });

    this.persistence.persistMutationEvent(event);
    this.events.emitMutationEvent(event);

    // Mark as pending until projection confirms
    this.addPending(sessionId, entryId);

    // Advance projection revision
    const projRev = this.advanceProjectionRevision(sessionId);

    return this.buildOutcome(command.commandId, 'committed', {
      entryId,
      resultingRevision: 0,
      projectionRevision: projRev,
    });
  }

  // ─── Edit ───────────────────────────────────────────────────────

  private handleEdit(command: EditEntryCommand): MutationOutcome {
    const { entryId, expectedRevision, content, metadata, actor, sessionId, turnId } = command;

    const entry = this.persistence.loadEntry(entryId);
    if (!entry) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry not found',
      });
    }

    // Session scoping check
    if (entry.sessionId !== sessionId) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry belongs to a different session',
      });
    }

    // Stale revision rejection (Requirement 39.4)
    if (entry.revision !== expectedRevision) {
      return this.buildOutcome(command.commandId, 'rejected_stale', {
        entryId,
        currentRevision: entry.revision,
        reason: `Expected revision ${expectedRevision} but entry is at revision ${entry.revision}`,
      });
    }

    // Cannot edit delivered or cancelled entries
    if (entry.deliveryState === 'delivered' || entry.deliveryState === 'cancelled') {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        currentRevision: entry.revision,
        reason: `Cannot edit entry in ${entry.deliveryState} state`,
      });
    }

    const now = this.clock.now();
    const newRevision = entry.revision + 1;

    const updatedEntry: QueueEntry = {
      ...entry,
      revision: newRevision,
      content,
      metadata: metadata ?? entry.metadata,
      modifiedAt: now,
    };

    this.persistence.updateEntry(updatedEntry);

    // Record replayable mutation event
    const event = this.buildMutationEvent({
      commandId: command.commandId,
      mutationKind: 'edit',
      entryId,
      priorRevision: expectedRevision,
      resultingRevision: newRevision,
      actor,
      sessionId,
      turnId,
      queueType: entry.queueType,
      contentSnapshot: content,
      metadataSnapshot: metadata,
    });

    this.persistence.persistMutationEvent(event);
    this.events.emitMutationEvent(event);

    this.addPending(sessionId, entryId);
    const projRev = this.advanceProjectionRevision(sessionId);

    return this.buildOutcome(command.commandId, 'committed', {
      entryId,
      resultingRevision: newRevision,
      projectionRevision: projRev,
    });
  }

  // ─── Remove ─────────────────────────────────────────────────────

  private handleRemove(command: RemoveEntryCommand): MutationOutcome {
    const { entryId, expectedRevision, actor, sessionId, turnId } = command;

    const entry = this.persistence.loadEntry(entryId);
    if (!entry) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry not found',
      });
    }

    if (entry.sessionId !== sessionId) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry belongs to a different session',
      });
    }

    // Stale revision rejection (Requirement 39.4)
    if (entry.revision !== expectedRevision) {
      return this.buildOutcome(command.commandId, 'rejected_stale', {
        entryId,
        currentRevision: entry.revision,
        reason: `Expected revision ${expectedRevision} but entry is at revision ${entry.revision}`,
      });
    }

    // Cannot remove already delivered entries
    if (entry.deliveryState === 'delivered') {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        currentRevision: entry.revision,
        reason: 'Cannot remove already delivered entry',
      });
    }

    const now = this.clock.now();
    const newRevision = entry.revision + 1;

    const updatedEntry: QueueEntry = {
      ...entry,
      revision: newRevision,
      deliveryState: 'cancelled',
      modifiedAt: now,
    };

    this.persistence.updateEntry(updatedEntry);

    // Record replayable mutation event
    const event = this.buildMutationEvent({
      commandId: command.commandId,
      mutationKind: 'remove',
      entryId,
      priorRevision: expectedRevision,
      resultingRevision: newRevision,
      actor,
      sessionId,
      turnId,
      queueType: entry.queueType,
      priorPosition: entry.position,
    });

    this.persistence.persistMutationEvent(event);
    this.events.emitMutationEvent(event);

    this.addPending(sessionId, entryId);
    const projRev = this.advanceProjectionRevision(sessionId);

    return this.buildOutcome(command.commandId, 'committed', {
      entryId,
      resultingRevision: newRevision,
      projectionRevision: projRev,
    });
  }

  // ─── Reorder ────────────────────────────────────────────────────

  private handleReorder(command: ReorderEntryCommand): MutationOutcome {
    const { entryId, expectedRevision, newPosition, actor, sessionId, turnId } = command;

    const entry = this.persistence.loadEntry(entryId);
    if (!entry) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry not found',
      });
    }

    if (entry.sessionId !== sessionId) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry belongs to a different session',
      });
    }

    // Stale revision rejection (Requirement 39.4)
    if (entry.revision !== expectedRevision) {
      return this.buildOutcome(command.commandId, 'rejected_stale', {
        entryId,
        currentRevision: entry.revision,
        reason: `Expected revision ${expectedRevision} but entry is at revision ${entry.revision}`,
      });
    }

    if (entry.deliveryState !== 'queued') {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        currentRevision: entry.revision,
        reason: `Cannot reorder entry in ${entry.deliveryState} state`,
      });
    }

    const now = this.clock.now();
    const newRevision = entry.revision + 1;
    const priorPosition = entry.position;

    // Shift other entries to accommodate the new position
    const siblings = this.persistence.loadEntries({
      sessionId,
      queueType: entry.queueType,
      deliveryState: 'queued',
    });

    // Move entry to new position and shift others
    for (const sibling of siblings) {
      if (sibling.entryId === entryId) continue;

      if (priorPosition < newPosition) {
        // Moving down: shift entries between old and new position up
        if (sibling.position > priorPosition && sibling.position <= newPosition) {
          this.persistence.updateEntry({ ...sibling, position: sibling.position - 1 });
        }
      } else if (priorPosition > newPosition) {
        // Moving up: shift entries between new and old position down
        if (sibling.position >= newPosition && sibling.position < priorPosition) {
          this.persistence.updateEntry({ ...sibling, position: sibling.position + 1 });
        }
      }
    }

    const updatedEntry: QueueEntry = {
      ...entry,
      revision: newRevision,
      position: newPosition,
      modifiedAt: now,
    };

    this.persistence.updateEntry(updatedEntry);

    // Record replayable mutation event
    const event = this.buildMutationEvent({
      commandId: command.commandId,
      mutationKind: 'reorder',
      entryId,
      priorRevision: expectedRevision,
      resultingRevision: newRevision,
      actor,
      sessionId,
      turnId,
      queueType: entry.queueType,
      priorPosition,
      resultingPosition: newPosition,
    });

    this.persistence.persistMutationEvent(event);
    this.events.emitMutationEvent(event);

    this.addPending(sessionId, entryId);
    const projRev = this.advanceProjectionRevision(sessionId);

    return this.buildOutcome(command.commandId, 'committed', {
      entryId,
      resultingRevision: newRevision,
      projectionRevision: projRev,
    });
  }

  // ─── Promote ────────────────────────────────────────────────────

  private handlePromote(command: PromoteEntryCommand): MutationOutcome {
    const { entryId, expectedRevision, targetQueueType, actor, sessionId, turnId } = command;

    const entry = this.persistence.loadEntry(entryId);
    if (!entry) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry not found',
      });
    }

    if (entry.sessionId !== sessionId) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        reason: 'Entry belongs to a different session',
      });
    }

    // Stale revision rejection (Requirement 39.4)
    if (entry.revision !== expectedRevision) {
      return this.buildOutcome(command.commandId, 'rejected_stale', {
        entryId,
        currentRevision: entry.revision,
        reason: `Expected revision ${expectedRevision} but entry is at revision ${entry.revision}`,
      });
    }

    if (entry.deliveryState !== 'queued') {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        currentRevision: entry.revision,
        reason: `Cannot promote entry in ${entry.deliveryState} state`,
      });
    }

    // Cannot promote to the same queue type
    if (entry.queueType === targetQueueType) {
      return this.buildOutcome(command.commandId, 'rejected_unavailable', {
        entryId,
        currentRevision: entry.revision,
        reason: `Entry is already in ${targetQueueType} queue`,
      });
    }

    const now = this.clock.now();
    const newRevision = entry.revision + 1;
    const priorQueueType = entry.queueType;

    // Compute position in the target queue
    const targetEntries = this.persistence.loadEntries({
      sessionId,
      queueType: targetQueueType,
      deliveryState: 'queued',
    });
    const newPosition = targetEntries.length; // Add at end of target queue

    const updatedEntry: QueueEntry = {
      ...entry,
      revision: newRevision,
      queueType: targetQueueType,
      position: newPosition,
      modifiedAt: now,
    };

    this.persistence.updateEntry(updatedEntry);

    // Record replayable mutation event
    const event = this.buildMutationEvent({
      commandId: command.commandId,
      mutationKind: 'promote',
      entryId,
      priorRevision: expectedRevision,
      resultingRevision: newRevision,
      actor,
      sessionId,
      turnId,
      queueType: targetQueueType,
      priorQueueType,
      priorPosition: entry.position,
      resultingPosition: newPosition,
    });

    this.persistence.persistMutationEvent(event);
    this.events.emitMutationEvent(event);

    this.addPending(sessionId, entryId);
    const projRev = this.advanceProjectionRevision(sessionId);

    return this.buildOutcome(command.commandId, 'committed', {
      entryId,
      resultingRevision: newRevision,
      projectionRevision: projRev,
    });
  }

  // ─── Delivery ───────────────────────────────────────────────────

  /**
   * Deliver the next entry from a queue in committed order (Requirement 39.12).
   * Returns the entry and marks it as delivered.
   */
  deliverNext(params: {
    sessionId: string;
    queueType: QueueType;
    turnId?: string;
  }): QueueEntry | undefined {
    const entries = this.persistence.loadEntries({
      sessionId: params.sessionId,
      queueType: params.queueType,
      turnId: params.turnId,
      deliveryState: 'queued',
    });

    // Filter out pending entries — only deliver committed entries
    const pending = this.pendingEntries.get(params.sessionId);
    const deliverable = entries.filter((e) => !pending?.has(e.entryId));

    if (deliverable.length === 0) return undefined;

    // Deliver the first in committed order (lowest position)
    const next = deliverable[0];
    const now = this.clock.now();

    const delivered: QueueEntry = {
      ...next,
      deliveryState: 'delivered',
      modifiedAt: now,
    };

    this.persistence.updateEntry(delivered);
    return delivered;
  }

  // ─── Projection ─────────────────────────────────────────────────

  /**
   * Get the current queue projection for a session (Requirement 39.1, 39.13).
   */
  getProjection(params: {
    sessionId: string;
    turnId?: string;
    queueType?: QueueType;
  }): QueueProjection {
    const entries = this.persistence.loadEntries({
      sessionId: params.sessionId,
      turnId: params.turnId,
      queueType: params.queueType,
    }).filter((e) => e.deliveryState !== 'cancelled');

    const pending = this.pendingEntries.get(params.sessionId);
    const pendingEntryIds = pending ? Array.from(pending) : [];

    const projRev = this.projectionRevisions.get(params.sessionId) ?? 0;

    const projection: QueueProjection = {
      sessionId: params.sessionId,
      turnId: params.turnId,
      projectionRevision: projRev,
      entries,
      pendingEntryIds,
      projectedAt: this.clock.now(),
      schemaVersion: 1,
    };

    return projection;
  }

  // ─── Projection Confirmation ────────────────────────────────────

  /**
   * Confirm a projection revision, marking pending entries as committed
   * (Requirement 39.15–39.16).
   */
  confirmProjection(params: {
    sessionId: string;
    projectionRevision: number;
    confirmedEntryIds: string[];
  }): void {
    const pending = this.pendingEntries.get(params.sessionId);
    if (!pending) return;

    for (const entryId of params.confirmedEntryIds) {
      pending.delete(entryId);
    }

    if (pending.size === 0) {
      this.pendingEntries.delete(params.sessionId);
    }

    // Emit projection confirmed event
    const projection = this.getProjection({ sessionId: params.sessionId });
    this.events.emitProjectionConfirmed(projection);
  }

  // ─── Busy-Enter Policy ──────────────────────────────────────────

  /**
   * Resolve what should happen on Enter while a turn is active
   * (Requirement 39.5–39.6).
   */
  resolveBusyEnterPolicy(params: {
    isTurnActive: boolean;
    isCompatibleTurn: boolean;
  }): { action: BusyEnterPolicy; alternateAction?: BusyEnterPolicy } {
    if (!params.isTurnActive || !params.isCompatibleTurn) {
      // Not busy — normal submission
      return { action: 'queue' };
    }

    const { defaultPolicy, alternatePolicy } = this.config.busyEnter;
    return {
      action: defaultPolicy,
      alternateAction: alternatePolicy ?? (defaultPolicy === 'queue' ? 'steer' : 'queue'),
    };
  }

  // ─── Subagent Ownership ─────────────────────────────────────────

  /**
   * Block queue mutations due to incompatible subagent ownership
   * (Requirement 39.11).
   */
  setSubagentBlock(sessionId: string, subagentId: string, reason: string): void {
    this.subagentBlocks.set(sessionId, { subagentId, reason });
  }

  /**
   * Clear a subagent ownership block.
   */
  clearSubagentBlock(sessionId: string): void {
    this.subagentBlocks.delete(sessionId);
  }

  /**
   * Check if a session has an active subagent block (Requirement 39.11).
   */
  hasSubagentBlock(sessionId: string): { blocked: boolean; subagentId?: string; reason?: string } {
    const block = this.subagentBlocks.get(sessionId);
    if (block) {
      return { blocked: true, subagentId: block.subagentId, reason: block.reason };
    }
    return { blocked: false };
  }

  // ─── Replay ─────────────────────────────────────────────────────

  /**
   * Replay mutation events to reconstruct queue state (Requirement 39.3).
   * Used for disaster recovery and state reconstruction.
   */
  replayMutations(sessionId: string): {
    entries: QueueEntry[];
    eventsReplayed: number;
    errors: string[];
  } {
    const events = this.persistence.loadMutationEvents(sessionId);
    const entries = new Map<string, QueueEntry>();
    const errors: string[] = [];

    for (const event of events) {
      try {
        this.applyReplayEvent(event, entries);
      } catch (err) {
        errors.push(`Failed to replay event ${event.eventId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      entries: Array.from(entries.values()).sort((a, b) => a.position - b.position),
      eventsReplayed: events.length,
      errors,
    };
  }

  // ─── Query ──────────────────────────────────────────────────────

  /**
   * Get entries for a queue type in committed order.
   */
  getEntries(params: {
    sessionId: string;
    queueType?: QueueType;
    turnId?: string;
    includeDelivered?: boolean;
  }): QueueEntry[] {
    const states: EntryDeliveryState[] | undefined = params.includeDelivered
      ? undefined
      : undefined;

    const entries = this.persistence.loadEntries({
      sessionId: params.sessionId,
      queueType: params.queueType,
      turnId: params.turnId,
    });

    if (!params.includeDelivered) {
      return entries.filter((e) => e.deliveryState === 'queued' || e.deliveryState === 'pending');
    }

    return entries;
  }

  /**
   * Get a single entry by ID.
   */
  getEntry(entryId: string): QueueEntry | undefined {
    return this.persistence.loadEntry(entryId);
  }

  /**
   * Get the current busy-enter configuration.
   */
  getBusyEnterConfig(): BusyEnterConfig {
    return { ...this.config.busyEnter };
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  private computePosition(existing: QueueEntry[], placement: EntryPlacement): number {
    if (existing.length === 0) return 0;

    switch (placement) {
      case 'end':
        return existing[existing.length - 1].position + 1;
      case 'beginning':
        return 0;
      case 'after_current':
        // After current means position 1 (after position 0 which is "current")
        return existing.length > 0 ? 1 : 0;
    }
  }

  private shiftPositions(entries: QueueEntry[], fromPosition: number): void {
    for (const entry of entries) {
      if (entry.position >= fromPosition) {
        this.persistence.updateEntry({
          ...entry,
          position: entry.position + 1,
        });
      }
    }
  }

  private buildMutationEvent(params: {
    commandId: string;
    mutationKind: QueueMutationEvent['mutationKind'];
    entryId: string;
    priorRevision: number;
    resultingRevision: number;
    actor: string;
    sessionId: string;
    turnId?: string;
    queueType: QueueType;
    placement?: EntryPlacement;
    contentSnapshot?: string;
    metadataSnapshot?: Record<string, unknown>;
    priorPosition?: number;
    resultingPosition?: number;
    priorQueueType?: QueueType;
  }): QueueMutationEvent {
    return {
      eventId: this.idGenerator.generateEventId(),
      commandId: params.commandId,
      mutationKind: params.mutationKind,
      entryId: params.entryId,
      priorRevision: params.priorRevision,
      resultingRevision: params.resultingRevision,
      actor: params.actor,
      sessionId: params.sessionId,
      turnId: params.turnId,
      queueType: params.queueType,
      placement: params.placement,
      contentSnapshot: params.contentSnapshot,
      metadataSnapshot: params.metadataSnapshot,
      priorPosition: params.priorPosition,
      resultingPosition: params.resultingPosition,
      priorQueueType: params.priorQueueType,
      committedAt: this.clock.now(),
      schemaVersion: 1,
    };
  }

  private buildOutcome(
    commandId: string,
    status: MutationOutcomeStatus,
    extra: Partial<Omit<MutationOutcome, 'commandId' | 'status' | 'determinedAt'>> = {},
  ): MutationOutcome {
    return {
      commandId,
      status,
      determinedAt: this.clock.now(),
      ...extra,
    };
  }

  private addPending(sessionId: string, entryId: string): void {
    let pending = this.pendingEntries.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingEntries.set(sessionId, pending);
    }
    pending.add(entryId);
  }

  private advanceProjectionRevision(sessionId: string): number {
    const current = this.projectionRevisions.get(sessionId) ?? 0;
    const next = current + 1;
    this.projectionRevisions.set(sessionId, next);
    return next;
  }

  private applyReplayEvent(event: QueueMutationEvent, entries: Map<string, QueueEntry>): void {
    switch (event.mutationKind) {
      case 'add': {
        const entry: QueueEntry = {
          entryId: event.entryId,
          queueType: event.queueType,
          revision: event.resultingRevision,
          position: event.resultingPosition ?? 0,
          owner: event.actor,
          sessionId: event.sessionId,
          turnId: event.turnId,
          deliveryState: 'queued',
          placement: event.placement ?? 'end',
          content: event.contentSnapshot ?? '',
          metadata: event.metadataSnapshot,
          createdAt: event.committedAt,
          modifiedAt: event.committedAt,
          schemaVersion: 1,
        };
        entries.set(event.entryId, entry);
        break;
      }
      case 'edit': {
        const existing = entries.get(event.entryId);
        if (!existing) throw new Error(`Cannot edit non-existent entry ${event.entryId}`);
        entries.set(event.entryId, {
          ...existing,
          revision: event.resultingRevision,
          content: event.contentSnapshot ?? existing.content,
          metadata: event.metadataSnapshot ?? existing.metadata,
          modifiedAt: event.committedAt,
        });
        break;
      }
      case 'remove': {
        const existing = entries.get(event.entryId);
        if (!existing) throw new Error(`Cannot remove non-existent entry ${event.entryId}`);
        entries.set(event.entryId, {
          ...existing,
          revision: event.resultingRevision,
          deliveryState: 'cancelled',
          modifiedAt: event.committedAt,
        });
        break;
      }
      case 'reorder': {
        const existing = entries.get(event.entryId);
        if (!existing) throw new Error(`Cannot reorder non-existent entry ${event.entryId}`);
        entries.set(event.entryId, {
          ...existing,
          revision: event.resultingRevision,
          position: event.resultingPosition ?? existing.position,
          modifiedAt: event.committedAt,
        });
        break;
      }
      case 'promote': {
        const existing = entries.get(event.entryId);
        if (!existing) throw new Error(`Cannot promote non-existent entry ${event.entryId}`);
        entries.set(event.entryId, {
          ...existing,
          revision: event.resultingRevision,
          queueType: event.queueType,
          position: event.resultingPosition ?? existing.position,
          modifiedAt: event.committedAt,
        });
        break;
      }
    }
  }
}
