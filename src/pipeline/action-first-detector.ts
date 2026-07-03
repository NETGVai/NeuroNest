/**
 * ActionFirstDetector — Detects when the LLM produces text-only responses
 * for requests that clearly imply tool usage, and generates re-prompt messages.
 *
 * This enforces the "action-first" behavior: the agent should use tools
 * immediately rather than describing what it would do.
 *
 * Requirements: 2.3, 2.5
 */

import type { AgentLLMResponse } from './agent-loop';

/**
 * Keywords that indicate the user expects the agent to take action via tools
 * (file creation, modification, command execution, project scaffolding).
 */
const ACTION_IMPLYING_KEYWORDS: string[] = [
  'create',
  'write',
  'modify',
  'edit',
  'delete',
  'run',
  'execute',
  'build',
  'install',
  'scaffold',
  'implement',
  'fix',
  'refactor',
  'add',
  'remove',
  'update',
];

/**
 * Compiled regex pattern that matches any action-implying keyword as a whole word.
 * Case-insensitive matching ensures natural language variants are caught.
 */
const ACTION_KEYWORD_PATTERN = new RegExp(
  `\\b(${ACTION_IMPLYING_KEYWORDS.join('|')})\\b`,
  'i',
);

export class ActionFirstDetector {
  /**
   * Returns true if the response is text-only when tools should have been used.
   *
   * A response is classified as "text-only when tools expected" if:
   * 1. The LLM response has no tool_calls (or empty tool_calls array)
   * 2. The user message contains action-implying keywords indicating they want
   *    file creation, modification, command execution, or project scaffolding
   *
   * @param response - The LLM response to evaluate
   * @param userMessage - The original user message that prompted the response
   * @returns true if this is a text-only response when tools should have been used
   */
  isTextOnlyWhenToolsExpected(response: AgentLLMResponse, userMessage: string): boolean {
    // If the response contains tool calls, it's not text-only
    if (response.tool_calls && response.tool_calls.length > 0) {
      return false;
    }

    // Check if the user message implies an action that requires tool usage
    return ACTION_KEYWORD_PATTERN.test(userMessage);
  }

  /**
   * Generates the re-prompt message instructing the LLM to use tools
   * instead of describing actions in text.
   *
   * @param originalResponse - The text content from the LLM's text-only response
   * @returns A re-prompt message to append to the conversation
   */
  buildRePromptMessage(originalResponse: string): string {
    return (
      'You provided a text-only response describing actions instead of executing them. ' +
      'You MUST use the available tools to perform the requested actions directly. ' +
      'Do not describe what you would do — use tools (file-write, file-edit, shell-exec, etc.) ' +
      'to actually carry out the task. Execute the actions now using tool calls.'
    );
  }
}

/**
 * Exported constant for the default maximum re-prompt attempts.
 * After this many re-prompts, the agent loop accepts the text response.
 */
export const DEFAULT_MAX_RE_PROMPT_ATTEMPTS = 3;
