/**
 * SendMessage Tool — Publishes inter-agent messages via the EventBus.
 *
 * Factory function `createSendMessageExecute` accepts event bus dependency
 * and returns a tool execute function that publishes messages to the
 * topic "agent.message.{targetAgentId}".
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ToolDependencies } from './tool-dependencies.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Input Interface ────────────────────────────────────────────

export interface SendMessageInput {
  targetAgentId: string;
  message: string;
}

// ─── Input Schema ───────────────────────────────────────────────

const sendMessageSchema: FieldSchema[] = [
  { name: 'targetAgentId', type: 'string', required: true },
  { name: 'message', type: 'string', required: true },
];

// ─── Factory Function ───────────────────────────────────────────

/**
 * Creates the SendMessage tool execute function.
 *
 * @param deps - Dependency injection containing the EventBus instance
 * @returns A tool execute function conforming to (input: unknown, context: ToolContext) => Promise<ToolResult>
 */
export function createSendMessageExecute(
  deps: Pick<ToolDependencies, 'eventBus'>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<SendMessageInput>(sendMessageSchema, async (input, context) => {
    const { targetAgentId, message } = input;

    // Check that EventBus is available
    if (!deps.eventBus) {
      return {
        success: false,
        output: null,
        error: 'EventBus is unavailable',
      };
    }

    const topic = `agent.message.${targetAgentId}`;
    const timestamp = new Date().toISOString();

    try {
      await deps.eventBus.publish(topic, {
        type: 'agent_message',
        data: {
          senderAgentId: context.agentId,
          targetAgentId,
          message,
          timestamp,
          sessionId: context.sessionId,
        },
        sessionId: context.sessionId,
      });

      return {
        success: true,
        output: {
          delivered: true,
          targetAgentId,
          timestamp,
        },
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        error: `Failed to publish message: ${errorMessage}`,
      };
    }
  });
}
