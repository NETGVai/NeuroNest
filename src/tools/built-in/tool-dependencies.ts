/**
 * Shared dependency injection interface used by all built-in tool implementations.
 *
 * Provides access to database, event bus, tool system, agent registry,
 * and LLM client resolution for the tool execute functions.
 */

import type { EventBus } from '../../events/event-bus.js';
import type { ToolSystem } from '../tool-system.js';
import type { AgentDefinition } from '../../agents/agent-registry.js';
import type Database from 'better-sqlite3';

export interface ToolDependencies {
  /** SQLite database instance for task operations */
  db: Database.Database;
  /** EventBus for inter-agent messaging */
  eventBus: EventBus;
  /** ToolSystem reference for tool search */
  toolSystem: ToolSystem;
  /** Agent registry array for agent delegation */
  agentRegistry: AgentDefinition[];
  /** LLM client resolver */
  resolveLLMClient: () => LLMClient | null;
}

export interface LLMClient {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string>;
}
