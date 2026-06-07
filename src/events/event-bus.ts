import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { agentSkillsErrorHandler, ErrorContext } from '../agent-skills/error-handler.js';

/**
 * Event Bus system replacing RabbitMQ messaging
 * 
 * Provides in-memory event handling with SQLite persistence for durability.
 * Maintains event ordering and delivery guarantees within the application.
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

export interface Event {
  id: string;
  type: string;
  topic: string;
  data: any;
  timestamp: Date;
  correlationId?: string;
  source?: string;
  sessionId?: string;
  retryCount?: number;
  maxRetries?: number;
}

export interface EventHandler {
  (event: Event): Promise<void> | void;
}

export interface Subscription {
  id: string;
  topic: string;
  handler: EventHandler;
  options: SubscriptionOptions;
}

export interface SubscriptionOptions {
  ordered?: boolean; // Guarantee event ordering for this subscription
  persistent?: boolean; // Persist events for replay
  retryOnFailure?: boolean; // Retry failed event deliveries
  maxRetries?: number; // Maximum retry attempts
  retryDelay?: number; // Delay between retries in milliseconds
}

export interface EventBusOptions {
  database: Database.Database;
  maxConcurrentEvents?: number;
  defaultRetryDelay?: number;
  defaultMaxRetries?: number;
  eventRetentionDays?: number;
}

export enum OrderingType {
  NONE = 'none',
  TOPIC = 'topic',
  GLOBAL = 'global'
}

/**
 * In-memory Event Bus with SQLite persistence
 * Replaces RabbitMQ messaging with guaranteed delivery and ordering
 */
export class EventBus extends EventEmitter {
  private db: Database.Database;
  private subscriptions = new Map<string, Subscription[]>();
  private eventQueue = new Map<string, Event[]>(); // Topic-based event queues
  private processingQueues = new Set<string>(); // Track which topics are being processed
  private options: Required<EventBusOptions>;
  
  // Prepared statements for performance
  private insertEventStmt!: Database.Statement;
  private getEventsStmt!: Database.Statement;
  private updateEventRetryStmt!: Database.Statement;
  private deleteOldEventsStmt!: Database.Statement;

  constructor(options: EventBusOptions) {
    super();
    
    this.db = options.database;
    this.options = {
      database: options.database,
      maxConcurrentEvents: options.maxConcurrentEvents || 100,
      defaultRetryDelay: options.defaultRetryDelay || 1000,
      defaultMaxRetries: options.defaultMaxRetries || 3,
      eventRetentionDays: options.eventRetentionDays || 90
    };

    this.initializePreparedStatements();
    this.startEventCleanup();
    
    logger.info('Event Bus initialized', {
      maxConcurrentEvents: this.options.maxConcurrentEvents,
      defaultRetryDelay: this.options.defaultRetryDelay,
      defaultMaxRetries: this.options.defaultMaxRetries
    });
  }

  /**
   * Initialize prepared statements for better performance
   */
  private initializePreparedStatements(): void {
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO skill_events (
        id, event_type, entity_type, entity_id, event_data,
        timestamp, correlation_id, source, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getEventsStmt = this.db.prepare(`
      SELECT id, event_type as type, entity_type, entity_id, event_data as data,
             timestamp, correlation_id, source, session_id
      FROM skill_events
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `);

    this.updateEventRetryStmt = this.db.prepare(`
      UPDATE skill_events 
      SET event_data = json_set(event_data, '$.retryCount', ?)
      WHERE id = ?
    `);

    this.deleteOldEventsStmt = this.db.prepare(`
      DELETE FROM skill_events 
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);
  }

  /**
   * Publish an event to a topic with comprehensive error handling
   * Events are delivered to all registered subscribers
   */
  async publish(topic: string, event: Omit<Event, 'id' | 'topic' | 'timestamp'>): Promise<void> {
    const context: ErrorContext = {
      component: 'event-bus',
      operation: 'publish',
      metadata: { topic, eventType: event.type },
      correlationId: event.correlationId,
      timestamp: new Date()
    };

    await agentSkillsErrorHandler.executeWithFallback(
      // Primary operation: full event publishing with persistence
      async () => {
        const fullEvent: Event = {
          id: this.generateEventId(),
          topic,
          timestamp: new Date(),
          retryCount: 0,
          maxRetries: event.maxRetries || this.options.defaultMaxRetries,
          ...event
        };

        // Persist event to SQLite for durability
        await this.persistEvent(fullEvent);
        
        // Add to in-memory queue for immediate processing
        if (!this.eventQueue.has(topic)) {
          this.eventQueue.set(topic, []);
        }
        this.eventQueue.get(topic)!.push(fullEvent);

        // Process events for this topic
        this.processTopicEvents(topic);

        logger.debug('Event published', {
          eventId: fullEvent.id,
          topic,
          type: fullEvent.type,
          correlationId: fullEvent.correlationId
        });
      },
      // Fallback operation: in-memory only (degraded mode)
      async () => {
        const fullEvent: Event = {
          id: this.generateEventId(),
          topic,
          timestamp: new Date(),
          retryCount: 0,
          maxRetries: event.maxRetries || this.options.defaultMaxRetries,
          ...event
        };

        logger.warn('Publishing event in degraded mode (memory-only)', {
          eventId: fullEvent.id,
          topic,
          type: fullEvent.type
        });

        // Add to in-memory queue only
        if (!this.eventQueue.has(topic)) {
          this.eventQueue.set(topic, []);
        }
        this.eventQueue.get(topic)!.push(fullEvent);

        // Process events for this topic
        this.processTopicEvents(topic);
      },
      context,
      {
        maxRetries: 3,
        baseDelay: 500,
        retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
      }
    );
  }

  /**
   * Subscribe to events on a topic
   */
  subscribe(topic: string, handler: EventHandler, options: SubscriptionOptions = {}): Subscription {
    const subscription: Subscription = {
      id: this.generateSubscriptionId(),
      topic,
      handler,
      options: {
        ordered: options.ordered ?? true,
        persistent: options.persistent ?? true,
        retryOnFailure: options.retryOnFailure ?? true,
        maxRetries: options.maxRetries ?? this.options.defaultMaxRetries,
        retryDelay: options.retryDelay ?? this.options.defaultRetryDelay,
        ...options
      }
    };

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
    }
    this.subscriptions.get(topic)!.push(subscription);

    logger.debug('Subscription created', {
      subscriptionId: subscription.id,
      topic,
      options: subscription.options
    });

    return subscription;
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(subscription: Subscription): void {
    const topicSubscriptions = this.subscriptions.get(subscription.topic);
    if (topicSubscriptions) {
      const index = topicSubscriptions.findIndex(sub => sub.id === subscription.id);
      if (index !== -1) {
        topicSubscriptions.splice(index, 1);
        
        // Clean up empty topic subscriptions
        if (topicSubscriptions.length === 0) {
          this.subscriptions.delete(subscription.topic);
        }

        logger.debug('Subscription removed', {
          subscriptionId: subscription.id,
          topic: subscription.topic
        });
      }
    }
  }

  /**
   * Persist event to SQLite database with error handling
   */
  async persistEvent(event: Event): Promise<void> {
    const context: ErrorContext = {
      component: 'event-bus',
      operation: 'persistEvent',
      metadata: { eventId: event.id, topic: event.topic },
      correlationId: event.correlationId,
      timestamp: new Date()
    };

    await agentSkillsErrorHandler.executeWithRetry(async () => {
      // Map event topics to appropriate entity types for the database schema
      const entityType = this.mapTopicToEntityType(event.topic);
      
      this.insertEventStmt.run(
        event.id,
        event.type,
        entityType,
        event.topic, // entity_id stores the topic
        JSON.stringify({
          ...event.data,
          retryCount: event.retryCount,
          maxRetries: event.maxRetries
        }),
        event.timestamp.toISOString(),
        event.correlationId || null,
        event.source || 'event-bus',
        event.sessionId || null
      );
    }, context, {
      maxRetries: 5,
      baseDelay: 500,
      maxDelay: 5000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }

  /**
   * Map event topic to appropriate entity_type for database schema
   */
  private mapTopicToEntityType(topic: string): string {
    // Map topics to valid entity_type values: 'skill', 'agent', 'assignment', 'task'
    if (topic.includes('skill')) {
      return 'skill';
    } else if (topic.includes('agent')) {
      return 'agent';
    } else if (topic.includes('assignment')) {
      return 'assignment';
    } else if (topic.includes('task')) {
      return 'task';
    } else {
      // Default to 'task' for general events
      return 'task';
    }
  }

  /**
   * Replay events from a specific timestamp
   */
  async *replayEvents(fromTimestamp: Date): AsyncGenerator<Event, void, unknown> {
    try {
      const rows = this.getEventsStmt.all(fromTimestamp.toISOString()) as any[];
      
      for (const row of rows) {
        const eventData = JSON.parse(row.data);
        const event: Event = {
          id: row.id,
          type: row.type,
          topic: row.entity_id, // topic is stored in entity_id
          data: eventData,
          timestamp: new Date(row.timestamp),
          correlationId: row.correlation_id,
          source: row.source,
          sessionId: row.session_id,
          retryCount: eventData.retryCount || 0,
          maxRetries: eventData.maxRetries || this.options.defaultMaxRetries
        };
        
        yield event;
      }
    } catch (error) {
      logger.error('Failed to replay events', {
        fromTimestamp: fromTimestamp.toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Set ordering guarantee for a topic
   */
  setOrderingGuarantee(topic: string, guarantee: OrderingType): void {
    // Update all subscriptions for this topic
    const topicSubscriptions = this.subscriptions.get(topic);
    if (topicSubscriptions) {
      topicSubscriptions.forEach(sub => {
        sub.options.ordered = guarantee !== OrderingType.NONE;
      });
    }

    logger.debug('Ordering guarantee set', { topic, guarantee });
  }

  /**
   * Process events for a specific topic with comprehensive error handling
   * Ensures ordering guarantees are maintained
   */
  private async processTopicEvents(topic: string): Promise<void> {
    // Prevent concurrent processing of the same topic to maintain ordering
    if (this.processingQueues.has(topic)) {
      return;
    }

    this.processingQueues.add(topic);

    const context: ErrorContext = {
      component: 'event-bus',
      operation: 'processTopicEvents',
      metadata: { topic },
      timestamp: new Date()
    };

    try {
      await agentSkillsErrorHandler.executeWithRetry(async () => {
        const events = this.eventQueue.get(topic) || [];
        const subscribers = this.subscriptions.get(topic) || [];

        while (events.length > 0 && subscribers.length > 0) {
          const event = events.shift()!;
          
          // Deliver event to all subscribers
          await this.deliverEventToSubscribers(event, subscribers);
        }
      }, context, {
        maxRetries: 2,
        baseDelay: 1000,
        retryableErrors: ['ECONNRESET', 'ETIMEDOUT']
      });
    } catch (error) {
      logger.error('Error processing topic events', {
        topic,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Don't throw - we want to continue processing other topics
      // Mark this topic for retry later
      setTimeout(() => {
        if (this.eventQueue.has(topic) && this.eventQueue.get(topic)!.length > 0) {
          this.processTopicEvents(topic);
        }
      }, 5000); // Retry after 5 seconds
    } finally {
      this.processingQueues.delete(topic);
    }
  }

  /**
   * Deliver event to all subscribers with retry logic
   */
  private async deliverEventToSubscribers(event: Event, subscribers: Subscription[]): Promise<void> {
    const deliveryPromises = subscribers.map(subscription => 
      this.deliverEventToSubscriber(event, subscription)
    );

    // Wait for all deliveries to complete
    const results = await Promise.allSettled(deliveryPromises);
    
    // Log any delivery failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn('Event delivery failed', {
          eventId: event.id,
          subscriptionId: subscribers[index].id,
          error: result.reason
        });
      }
    });
  }

  /**
   * Deliver event to a single subscriber with retry logic
   */
  private async deliverEventToSubscriber(event: Event, subscription: Subscription): Promise<void> {
    let attempt = 0;
    const maxAttempts = subscription.options.retryOnFailure ? 
      (subscription.options.maxRetries || this.options.defaultMaxRetries) + 1 : 1;

    while (attempt < maxAttempts) {
      try {
        await subscription.handler(event);
        
        // Success - emit delivery event
        this.emit('eventDelivered', {
          eventId: event.id,
          subscriptionId: subscription.id,
          attempt: attempt + 1
        });
        
        return;
      } catch (error) {
        attempt++;
        
        if (attempt >= maxAttempts) {
          // Max retries exceeded
          this.emit('eventDeliveryFailed', {
            eventId: event.id,
            subscriptionId: subscription.id,
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error)
          });
          
          logger.error('Event delivery failed after retries', {
            eventId: event.id,
            subscriptionId: subscription.id,
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error)
          });
          
          throw error;
        }

        // Wait before retry
        if (subscription.options.retryDelay) {
          await this.delay(subscription.options.retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
        }

        logger.debug('Retrying event delivery', {
          eventId: event.id,
          subscriptionId: subscription.id,
          attempt: attempt + 1,
          maxAttempts
        });
      }
    }
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique subscription ID
   */
  private generateSubscriptionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Utility function for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start periodic cleanup of old events
   */
  private startEventCleanup(): void {
    // Clean up old events every hour
    setInterval(() => {
      try {
        const result = this.deleteOldEventsStmt.run(this.options.eventRetentionDays);
        if (result.changes > 0) {
          logger.info('Cleaned up old events', { deletedCount: result.changes });
        }
      } catch (error) {
        logger.error('Failed to clean up old events', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  /**
   * Get statistics about the event bus
   */
  getStats(): {
    totalSubscriptions: number;
    activeTopics: number;
    queuedEvents: number;
    processingTopics: number;
  } {
    let totalSubscriptions = 0;
    let queuedEvents = 0;

    for (const subs of this.subscriptions.values()) {
      totalSubscriptions += subs.length;
    }

    for (const events of this.eventQueue.values()) {
      queuedEvents += events.length;
    }

    return {
      totalSubscriptions,
      activeTopics: this.subscriptions.size,
      queuedEvents,
      processingTopics: this.processingQueues.size
    };
  }

  /**
   * Shutdown the event bus gracefully
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Event Bus');
    
    // Wait for all processing to complete
    while (this.processingQueues.size > 0) {
      await this.delay(100);
    }

    // Clear all subscriptions
    this.subscriptions.clear();
    this.eventQueue.clear();
    
    this.removeAllListeners();
    
    logger.info('Event Bus shutdown complete');
  }
}