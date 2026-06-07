/**
 * EventBatcher - Performance optimization for file creation events
 * Batches multiple file events within 200ms windows to prevent UI flooding
 */

import { FileCreatedEvent } from './file-event-emitter';

export interface BatchedEvent {
  type: 'files-batch';
  projectId: string;
  filePaths: string[];
  batchId: string;
  timestamp: number;
}

/**
 * Batches file creation events within 200ms windows for performance optimization
 * Prevents UI flooding during rapid file creation scenarios
 */
export class EventBatcher {
  private static readonly BATCH_WINDOW_MS = 200;
  
  private pendingEvents: Map<string, FileCreatedEvent[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private batchHandlers: Map<string, (event: BatchedEvent) => void> = new Map();
  private batchCounter = 0;

  /**
   * Add a file creation event to the batching system with error recovery
   * Events for the same project are batched together within the 200ms window
   */
  addEvent(event: FileCreatedEvent): void {
    try {
      this.addEventInternal(event);
    } catch (error) {
      console.error('[EventBatcher] Error adding event:', error);
      
      // Attempt to recover by flushing current batch and retrying
      try {
        console.log('[EventBatcher] Attempting recovery by flushing batch for project:', event.projectId);
        this.flushBatch(event.projectId);
        this.addEventInternal(event);
      } catch (recoveryError) {
        console.error('[EventBatcher] Recovery failed, event will be lost:', recoveryError);
        // Event is lost, but we don't want to crash the entire system
        // The final project-files-updated event will serve as reconciliation
      }
    }
  }

  /**
   * Internal event addition logic (separated for error recovery)
   */
  private addEventInternal(event: FileCreatedEvent): void {
    const { projectId } = event;

    // Initialize pending events array for this project if needed
    if (!this.pendingEvents.has(projectId)) {
      this.pendingEvents.set(projectId, []);
    }

    // Add event to pending batch
    const events = this.pendingEvents.get(projectId)!;
    events.push(event);

    // Reset or create timer for this project
    this.resetBatchTimer(projectId);
  }

  /**
   * Reset the batch timer for a project, creating a new 200ms window
   */
  private resetBatchTimer(projectId: string): void {
    // Clear existing timer if present
    const existingTimer = this.batchTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Create new timer for 200ms window
    const timer = setTimeout(() => {
      this.flushBatch(projectId);
    }, EventBatcher.BATCH_WINDOW_MS);

    this.batchTimers.set(projectId, timer);
  }

  /**
   * Flush the batch for a specific project, emitting the batched event with error recovery
   */
  private flushBatch(projectId: string): void {
    const events = this.pendingEvents.get(projectId);
    
    // Nothing to flush if no events pending
    if (!events || events.length === 0) {
      return;
    }

    try {
      // Create batched event
      const batchedEvent: BatchedEvent = {
        type: 'files-batch',
        projectId,
        filePaths: events.map(event => event.filePath),
        batchId: this.generateBatchId(),
        timestamp: Date.now()
      };

      // Clear pending events and timer for this project first
      // This prevents infinite loops if handlers fail
      this.pendingEvents.delete(projectId);
      const timer = this.batchTimers.get(projectId);
      if (timer) {
        clearTimeout(timer);
        this.batchTimers.delete(projectId);
      }

      // Emit to all registered handlers with individual error handling
      let successfulHandlers = 0;
      this.batchHandlers.forEach((handler, handlerId) => {
        try {
          handler(batchedEvent);
          successfulHandlers++;
        } catch (error) {
          console.error(`[EventBatcher] Error in handler ${handlerId}:`, error);
          // Continue with other handlers even if one fails
        }
      });

      if (successfulHandlers === 0 && this.batchHandlers.size > 0) {
        console.warn('[EventBatcher] All batch handlers failed for project:', projectId);
        // Events are lost, but the final project-files-updated event will reconcile
      } else if (successfulHandlers < this.batchHandlers.size) {
        console.warn('[EventBatcher] Some batch handlers failed for project:', projectId, 
                    `(${successfulHandlers}/${this.batchHandlers.size} succeeded)`);
      }

    } catch (error) {
      console.error('[EventBatcher] Critical error in flushBatch:', error);
      
      // Ensure cleanup even if batch creation failed
      this.pendingEvents.delete(projectId);
      const timer = this.batchTimers.get(projectId);
      if (timer) {
        clearTimeout(timer);
        this.batchTimers.delete(projectId);
      }
    }
  }

  /**
   * Generate a unique batch ID for tracking
   */
  private generateBatchId(): string {
    return `batch-${Date.now()}-${++this.batchCounter}`;
  }

  /**
   * Register a handler for batched events
   * @param handlerId - Unique identifier for the handler
   * @param handler - Function to handle batched events
   */
  onBatchReady(handlerId: string, handler: (event: BatchedEvent) => void): void {
    this.batchHandlers.set(handlerId, handler);
  }

  /**
   * Unregister a batch handler
   * @param handlerId - The handler identifier to remove
   */
  removeBatchHandler(handlerId: string): void {
    this.batchHandlers.delete(handlerId);
  }

  /**
   * Force flush all pending batches (useful for shutdown or testing)
   */
  flushAllBatches(): void {
    const projectIds = Array.from(this.pendingEvents.keys());
    projectIds.forEach(projectId => {
      this.flushBatch(projectId);
    });
  }

  /**
   * Get the number of pending events for a project (for testing)
   */
  getPendingEventCount(projectId: string): number {
    const events = this.pendingEvents.get(projectId);
    return events ? events.length : 0;
  }

  /**
   * Get the number of active batch timers (for testing)
   */
  getActiveTimerCount(): number {
    return this.batchTimers.size;
  }

  /**
   * Get the number of registered batch handlers (for testing)
   */
  getBatchHandlerCount(): number {
    return this.batchHandlers.size;
  }

  /**
   * Clear all pending events and timers (for testing/cleanup)
   */
  clear(): void {
    // Clear all timers
    this.batchTimers.forEach(timer => clearTimeout(timer));
    
    // Clear all data structures
    this.pendingEvents.clear();
    this.batchTimers.clear();
    this.batchHandlers.clear();
    
    // Reset counter
    this.batchCounter = 0;
  }
}