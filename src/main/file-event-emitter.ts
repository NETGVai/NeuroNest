/**
 * FileEventEmitter - Real-time file creation event system
 * Provides singleton pattern for coordinating file events across the main process
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { EventBatcher, BatchedEvent } from './event-batcher';

export interface FileCreatedEvent {
  type: 'file-created';
  projectId: string;
  filePath: string;
  timestamp: number;
}

/**
 * Singleton class for emitting file creation events with path validation
 * Integrates with existing project directory structure for security
 * Uses EventBatcher internally for performance optimization
 */
export class FileEventEmitter {
  private static instance: FileEventEmitter;
  private eventHandlers: Map<string, (event: FileCreatedEvent) => void> = new Map();
  private eventBatcher: EventBatcher;

  private constructor() {
    this.eventBatcher = new EventBatcher();
    
    // Register ourselves as a handler for batched events
    this.eventBatcher.onBatchReady('file-event-emitter', (batchedEvent: BatchedEvent) => {
      try {
        this.handleBatchedEvent(batchedEvent);
      } catch (error) {
        console.error('[FileEventEmitter] Error handling batched event:', error);
        // Batch failure is logged but doesn't affect individual handlers
        // Individual handlers were already called synchronously
      }
    });
  }

  /**
   * Get the singleton instance of FileEventEmitter
   */
  static getInstance(): FileEventEmitter {
    if (!FileEventEmitter.instance) {
      FileEventEmitter.instance = new FileEventEmitter();
    }
    return FileEventEmitter.instance;
  }

  /**
   * Validate file path for security - prevents directory traversal attacks
   * Ensures path is within the authorized project directory
   */
  private validateFilePath(projectId: string, filePath: string): boolean {
    try {
      // Prevent directory traversal sequences
      if (filePath.includes('..')) {
        console.warn('[FileEventEmitter] Directory traversal attempt blocked:', filePath);
        return false;
      }

      // Get project directory (following existing pattern from IPC)
      const projectDir = path.join(os.homedir(), '.neuronest', 'projects', projectId);
      
      // Resolve the full path and ensure it's within project directory
      const resolvedPath = path.resolve(projectDir, filePath);
      const normalizedProjectDir = path.resolve(projectDir);
      
      if (!resolvedPath.startsWith(normalizedProjectDir)) {
        console.warn('[FileEventEmitter] Path outside project directory blocked:', filePath);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[FileEventEmitter] Path validation error:', error);
      return false;
    }
  }

  /**
   * Emit a file created event with path validation and comprehensive error recovery
   * Events are delivered immediately to individual handlers and batched for IPC
   * @param projectId - The project identifier
   * @param filePath - The relative file path within the project
   */
  emitFileCreated(projectId: string, filePath: string): void {
    // Validate inputs
    if (!projectId || !filePath) {
      console.warn('[FileEventEmitter] Invalid parameters - projectId and filePath are required');
      return;
    }

    // Validate file path for security
    if (!this.validateFilePath(projectId, filePath)) {
      console.error('[FileEventEmitter] File path validation failed for:', filePath);
      return;
    }

    // Create the event
    const event: FileCreatedEvent = {
      type: 'file-created',
      projectId,
      filePath,
      timestamp: Date.now()
    };

    // Track success/failure for error recovery
    let individualHandlerSuccess = false;
    let batchingSuccess = false;

    // Emit immediately to individual handlers (for backward compatibility)
    if (this.eventHandlers.size > 0) {
      let successfulHandlers = 0;
      this.eventHandlers.forEach((handler, handlerId) => {
        try {
          handler(event);
          successfulHandlers++;
        } catch (error) {
          console.error(`[FileEventEmitter] Error in handler ${handlerId}:`, error);
        }
      });
      
      individualHandlerSuccess = successfulHandlers > 0;
      if (successfulHandlers < this.eventHandlers.size) {
        console.warn('[FileEventEmitter] Some individual handlers failed:', 
                    `${successfulHandlers}/${this.eventHandlers.size} succeeded`);
      }
    } else {
      individualHandlerSuccess = true; // No handlers to fail
    }

    // Also add to EventBatcher for IPC batching (with error handling)
    try {
      this.eventBatcher.addEvent(event);
      batchingSuccess = true;
    } catch (error) {
      console.error('[FileEventEmitter] Error adding event to batch:', error);
      batchingSuccess = false;
      
      // Attempt to recover by flushing all batches and retrying
      try {
        console.log('[FileEventEmitter] Attempting batch recovery by flushing all batches');
        this.eventBatcher.flushAllBatches();
        this.eventBatcher.addEvent(event);
        batchingSuccess = true;
        console.log('[FileEventEmitter] Batch recovery successful');
      } catch (recoveryError) {
        console.error('[FileEventEmitter] Batch recovery failed:', recoveryError);
        // Individual handlers were already called, so this doesn't affect them
        // This error only affects IPC batching - final reconciliation will handle it
      }
    }

    // Log overall success/failure status
    if (!individualHandlerSuccess && !batchingSuccess) {
      console.error('[FileEventEmitter] Complete failure for file event:', filePath);
    } else if (!batchingSuccess) {
      console.warn('[FileEventEmitter] Batching failed but individual handlers succeeded for:', filePath);
    }
  }

  /**
   * Handle batched events from EventBatcher
   * This is used for IPC communication, not for individual handlers
   */
  private handleBatchedEvent(batchedEvent: BatchedEvent): void {
    // This method is reserved for IPC integration
    // Individual handlers are called immediately in emitFileCreated
    // The batched events will be handled by IPC handlers registered via onBatchReady
  }

  /**
   * Register an event handler for file creation events
   * @param handlerId - Unique identifier for the handler
   * @param handler - Function to handle file creation events
   */
  onFileCreated(handlerId: string, handler: (event: FileCreatedEvent) => void): void {
    this.eventHandlers.set(handlerId, handler);
  }

  /**
   * Unregister an event handler
   * @param handlerId - The handler identifier to remove
   */
  removeHandler(handlerId: string): void {
    this.eventHandlers.delete(handlerId);
  }

  /**
   * Get the number of registered handlers (for testing)
   */
  getHandlerCount(): number {
    return this.eventHandlers.size;
  }

  /**
   * Get access to the EventBatcher for batch handling (for IPC integration)
   */
  getEventBatcher(): EventBatcher {
    return this.eventBatcher;
  }

  /**
   * Force flush all pending batches (useful for shutdown or error recovery)
   */
  flushAllBatches(): void {
    try {
      this.eventBatcher.flushAllBatches();
    } catch (error) {
      console.error('[FileEventEmitter] Error flushing batches:', error);
    }
  }

  /**
   * Register a handler for batched events directly (for IPC integration)
   * @param handlerId - Unique identifier for the handler
   * @param handler - Function to handle batched events
   */
  onBatchReady(handlerId: string, handler: (event: BatchedEvent) => void): void {
    try {
      this.eventBatcher.onBatchReady(handlerId, handler);
    } catch (error) {
      console.error('[FileEventEmitter] Error registering batch handler:', error);
    }
  }

  /**
   * Remove a batch handler
   * @param handlerId - The handler identifier to remove
   */
  removeBatchHandler(handlerId: string): void {
    try {
      this.eventBatcher.removeBatchHandler(handlerId);
    } catch (error) {
      console.error('[FileEventEmitter] Error removing batch handler:', error);
    }
  }
}