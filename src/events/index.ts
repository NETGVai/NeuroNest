/**
 * Event Bus system for NeuroNest
 * 
 * Replaces RabbitMQ messaging with in-memory event handling
 * backed by SQLite persistence for durability.
 */

export { EventBus, OrderingType } from './event-bus.js';
export type { 
  Event, 
  EventHandler, 
  Subscription, 
  SubscriptionOptions, 
  EventBusOptions 
} from './event-bus.js';