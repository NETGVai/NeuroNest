/**
 * RefusalDetector — Pattern-match agent responses for refusal indicators
 * and trigger reassignment or drop.
 *
 * Detects when an agent refuses a task (e.g., "I can't do this", "outside my capability")
 * and handles the refusal by attempting reassignment to an alternative agent or
 * dropping the subtask with a recorded reason.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.5, 3.6
 */

import type { CapabilityMatch } from './capability-router.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RefusalResult {
  isRefusal: boolean;
  pattern?: string; // which pattern matched
  confidence: number; // 0-1
}

export type SubtaskStatus = 'completed' | 'failed' | 'refused' | 'dropped';

export interface SubtaskOutcome {
  taskId: string;
  agentId: string;
  status: SubtaskStatus;
  output?: string;
  refusalReason?: string;
  reassignedTo?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Maximum number of characters to inspect for refusal pattern matching.
 * Large responses are truncated to this length for performance.
 */
const MAX_RESPONSE_LENGTH = 2000;

/**
 * Default refusal patterns that indicate an agent cannot perform a task.
 */
const DEFAULT_REFUSAL_PATTERNS: string[] = [
  "I can't do this",
  'I cannot do this',
  'outside my capability',
  'outside my scope',
  'not within my scope',
  'not able to',
  "I'm unable to",
  'I am unable to',
  'beyond my expertise',
  'not something I can',
];

// ─── RefusalDetector ────────────────────────────────────────────

export class RefusalDetector {
  private patterns: RegExp[];

  /**
   * Create a RefusalDetector with default patterns and optional custom patterns.
   *
   * @param customPatterns - Additional refusal pattern strings to match (appended to defaults)
   */
  constructor(customPatterns?: string[]) {
    const allPatterns = [...DEFAULT_REFUSAL_PATTERNS, ...(customPatterns ?? [])];
    this.patterns = allPatterns.map(
      (pattern) => new RegExp(this.escapeRegex(pattern), 'i'),
    );
  }

  /**
   * Check if an agent response contains a refusal pattern.
   *
   * Edge cases:
   * - Empty response → treated as failure (not refusal): { isRefusal: false, confidence: 0 }
   * - Large response → truncated to first 2000 chars for pattern matching
   *
   * @param response - The agent's response text
   * @returns RefusalResult indicating whether a refusal was detected
   */
  detect(response: string): RefusalResult {
    // Edge case: empty response is a failure, not a refusal
    if (!response || response.trim().length === 0) {
      return { isRefusal: false, confidence: 0 };
    }

    // Truncate large responses for pattern matching performance
    const textToCheck =
      response.length > MAX_RESPONSE_LENGTH
        ? response.slice(0, MAX_RESPONSE_LENGTH)
        : response;

    // Check each pattern for a match
    for (const pattern of this.patterns) {
      if (pattern.test(textToCheck)) {
        return {
          isRefusal: true,
          pattern: pattern.source,
          confidence: 1,
        };
      }
    }

    return { isRefusal: false, confidence: 0 };
  }

  /**
   * Handle a detected refusal by attempting reassignment or dropping the subtask.
   *
   * When availableAgents is non-empty:
   *   → Returns status 'refused' with reassignedTo pointing to the first available agent
   *
   * When availableAgents is empty:
   *   → Returns status 'dropped' with a recorded refusalReason
   *
   * @param taskId - The ID of the refused subtask
   * @param refusedAgentId - The ID of the agent that refused
   * @param availableAgents - List of alternative agents that could handle the task
   * @returns SubtaskOutcome describing the resolution
   */
  handleRefusal(
    taskId: string,
    refusedAgentId: string,
    availableAgents: CapabilityMatch[],
  ): SubtaskOutcome {
    // Filter out the agent that already refused
    const alternatives = availableAgents.filter(
      (agent) => agent.agentId !== refusedAgentId,
    );

    if (alternatives.length > 0) {
      // Reassign to the first available alternative agent
      const reassignTarget = alternatives[0]!;
      return {
        taskId,
        agentId: refusedAgentId,
        status: 'refused',
        refusalReason: `Agent ${refusedAgentId} refused the task`,
        reassignedTo: reassignTarget.agentId,
      };
    }

    // No alternatives available — drop the subtask
    return {
      taskId,
      agentId: refusedAgentId,
      status: 'dropped',
      refusalReason: `No alternative agents available after agent ${refusedAgentId} refused. Cascading refusal — subtask dropped.`,
    };
  }

  /**
   * Escape special regex characters in a pattern string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
