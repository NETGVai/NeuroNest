/**
 * SessionIntegration — Wire SuperAgent conversation and session flow.
 *
 * Connects SuperAgent chat to session context maintenance,
 * connects identity loading during task processing,
 * connects memory retrieval/storage at task start/completion.
 *
 * Requirements: 4.6, 7.2, 7.3, 8.4
 */

import { randomUUID } from 'node:crypto';
import { CompoundingMemory, type MemoryEntry } from '../agents/compounding-memory.js';
import { AgentIdentityManager } from '../agents/agent-identity-manager.js';
import type { Session, Message, AgentIdentity } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface TaskContext {
  agentId: string;
  sessionId: string;
  task: string;
  relevantMemories: MemoryEntry[];
  identity: AgentIdentity | null;
}

export interface TaskCompletionData {
  agentId: string;
  sessionId: string;
  task: string;
  output: string;
  success: boolean;
}

// ─── SessionIntegration ─────────────────────────────────────────

export class SessionIntegration {
  private memory: CompoundingMemory;
  private identityManager: AgentIdentityManager;
  private sessions = new Map<string, Session>();

  constructor(
    memory: CompoundingMemory,
    identityManager: AgentIdentityManager,
  ) {
    this.memory = memory;
    this.identityManager = identityManager;
  }

  /**
   * Add a message to a session's conversation context.
   * Requirements: 4.6
   */
  addMessageToSession(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.updatedAt = new Date();
  }

  /**
   * Register a session for tracking.
   */
  registerSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  /**
   * Get session by ID.
   */
  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Prepare task context: load identity and retrieve relevant memories.
   * Requirements: 7.3, 8.4
   */
  async prepareTaskContext(agentId: string, sessionId: string, task: string): Promise<TaskContext> {
    // Load agent identity
    // Requirements: 8.4
    const identity = this.identityManager.loadIdentity(agentId);

    // Retrieve relevant memories from Compounding_Memory
    // Requirements: 7.3
    const relevantMemories = await this.memory.retrieve(agentId, task, 10);

    return {
      agentId,
      sessionId,
      task,
      relevantMemories,
      identity,
    };
  }

  /**
   * Handle task completion: store learned patterns to memory.
   * Requirements: 7.2
   */
  async onTaskComplete(data: TaskCompletionData): Promise<void> {
    // Store learned patterns to Compounding_Memory
    const memoryEntry: MemoryEntry = {
      id: randomUUID(),
      agentId: data.agentId,
      type: data.success ? 'strategy' : 'error',
      content: data.success
        ? `Successfully completed: ${data.task}. Output: ${data.output.slice(0, 500)}`
        : `Failed task: ${data.task}. Output: ${data.output.slice(0, 500)}`,
      context: `Session ${data.sessionId}`,
      relevanceScore: data.success ? 0.7 : 0.9,
      createdAt: new Date(),
    };

    await this.memory.store(data.agentId, memoryEntry);

    // Update session
    const session = this.sessions.get(data.sessionId);
    if (session) {
      session.updatedAt = new Date();
    }
  }

  /**
   * Get conversation history for a session.
   * Requirements: 4.6
   */
  getConversationHistory(sessionId: string): Message[] {
    const session = this.sessions.get(sessionId);
    return session?.messages ?? [];
  }
}
