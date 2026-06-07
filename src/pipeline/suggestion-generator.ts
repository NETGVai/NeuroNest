/**
 * Suggestion_Generator — produces contextual follow-up suggestions after
 * task completion based on task output, agent domain, and user memory facts.
 *
 * Normalizes mixed content (markdown, code blocks, objects) to plain text
 * before analysis. Returns diagnostic suggestions when task output is empty
 * or error-only.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.6
 */

import { randomUUID } from 'node:crypto';
import type { Suggestion } from './types/deerflow-types.js';
import type { MemoryStore } from '../storage/memory-store.js';

// ─── Error detection patterns ───────────────────────────────────

const ERROR_PATTERNS = [
  /^error:/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bstack\s*trace\b/i,
  /\btraceback\b/i,
  /\bfatal\b/i,
  /\bunhandled\b/i,
];

// ─── Domain suggestion templates ────────────────────────────────

const DOMAIN_SUGGESTIONS: Record<string, Array<{ text: string; action: string }>> = {
  code: [
    { text: 'Run tests to verify the changes', action: 'Run the test suite for the modified files' },
    { text: 'Review the code for potential issues', action: 'Review the code changes for bugs or improvements' },
    { text: 'Add documentation for the new code', action: 'Generate documentation for the recent changes' },
    { text: 'Refactor for better readability', action: 'Refactor the code for clarity and maintainability' },
    { text: 'Check for security vulnerabilities', action: 'Scan the code for security issues' },
  ],
  deploy: [
    { text: 'Deploy to staging environment', action: 'Deploy the current build to staging' },
    { text: 'Run integration tests', action: 'Execute integration tests before deployment' },
    { text: 'Check deployment logs', action: 'Review the latest deployment logs' },
    { text: 'Roll back to previous version', action: 'Roll back the deployment to the previous version' },
    { text: 'Monitor application health', action: 'Check application health metrics after deployment' },
  ],
  research: [
    { text: 'Summarize the findings', action: 'Create a summary of the research findings' },
    { text: 'Explore related topics', action: 'Research related topics for deeper understanding' },
    { text: 'Compare with alternatives', action: 'Compare the findings with alternative approaches' },
    { text: 'Create an action plan', action: 'Draft an action plan based on the research' },
    { text: 'Share the results', action: 'Format the research results for sharing' },
  ],
  test: [
    { text: 'Fix the failing tests', action: 'Fix the failing test cases' },
    { text: 'Add more test coverage', action: 'Write additional tests for edge cases' },
    { text: 'Run the full test suite', action: 'Execute the complete test suite' },
    { text: 'Review test results', action: 'Analyze the test results in detail' },
    { text: 'Update test snapshots', action: 'Update outdated test snapshots' },
  ],
  default: [
    { text: 'Continue with the next step', action: 'Proceed to the next task' },
    { text: 'Review the output in detail', action: 'Analyze the output for important details' },
    { text: 'Try a different approach', action: 'Attempt an alternative approach to this task' },
    { text: 'Save the results', action: 'Save the current results for later reference' },
    { text: 'Ask a follow-up question', action: 'Ask a clarifying question about the results' },
  ],
};

// ─── Diagnostic suggestion templates ────────────────────────────

const DIAGNOSTIC_SUGGESTIONS: Array<{ text: string; action: string }> = [
  { text: 'Re-run the task', action: 'Re-run the previous task' },
  { text: 'Check logs for errors', action: 'Check the logs for error details' },
  { text: 'Try a different execution mode', action: 'Switch to a different execution mode and retry' },
  { text: 'Report the issue', action: 'Report this issue for investigation' },
];

// ─── Markdown stripping helpers ─────────────────────────────────

/** Strip markdown formatting from a string. */
function stripMarkdown(text: string): string {
  let result = text;

  // Extract code block contents (remove fences, keep content)
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const lines = match.split('\n');
    // Remove first and last lines (the fences)
    return lines.slice(1, -1).join('\n');
  });

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1');

  // Remove headers (# ## ### etc.)
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Remove bold (**text** or __text__)
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');

  // Remove italic (*text* or _text_)
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');

  // Remove strikethrough (~~text~~)
  result = result.replace(/~~(.+?)~~/g, '$1');

  // Remove links [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove images ![alt](url) → alt
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

  // Remove horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');

  // Remove blockquotes
  result = result.replace(/^>\s?/gm, '');

  // Remove list markers
  result = result.replace(/^[\s]*[-*+]\s+/gm, '');
  result = result.replace(/^[\s]*\d+\.\s+/gm, '');

  // Collapse multiple newlines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// ─── SuggestionGenerator ────────────────────────────────────────

export class SuggestionGenerator {
  private readonly memoryStore: MemoryStore | null;

  constructor(memoryStore: MemoryStore | null) {
    this.memoryStore = memoryStore;
  }

  /**
   * Generate follow-up suggestions based on task output and context.
   *
   * - If taskOutput is empty or error-only → returns diagnostic suggestions
   * - Otherwise → returns 2–5 contextual domain suggestions
   * - Personalizes with memory facts when available
   *
   * Requirements: 8.1, 8.3, 8.4, 8.6
   */
  generate(taskOutput: string, agentDomain: string, userId: string): Suggestion[] {
    // Check for empty or error-only output → diagnostic suggestions
    if (this.isErrorOrEmpty(taskOutput)) {
      return this.buildDiagnosticSuggestions();
    }

    // Build domain-specific suggestions
    const domainKey = this.resolveDomainKey(agentDomain);
    const templates = DOMAIN_SUGGESTIONS[domainKey] ?? DOMAIN_SUGGESTIONS.default;

    // Load memory facts for personalization
    const memoryFacts = this.loadMemoryFacts(userId);

    // Select 2–5 suggestions, personalizing where possible
    const count = Math.min(Math.max(2, templates.length), 5);
    const selected = templates.slice(0, count);

    const suggestions: Suggestion[] = selected.map((template) => ({
      id: randomUUID(),
      text: template.text,
      action: template.action,
      category: 'domain' as const,
    }));

    // If we have memory facts, personalize the last suggestion
    if (memoryFacts.length > 0 && suggestions.length > 0) {
      const topFact = memoryFacts[0];
      const personalized: Suggestion = {
        id: randomUUID(),
        text: `Review based on your ${topFact.category}: ${topFact.key}`,
        action: `Consider your ${topFact.category} "${topFact.key}" for the next step`,
        category: 'domain',
      };
      // Replace the last suggestion with a personalized one
      suggestions[suggestions.length - 1] = personalized;
    }

    return suggestions;
  }

  /**
   * Normalize mixed content (markdown, code blocks, objects) to plain text.
   *
   * - String input: strips markdown formatting, extracts code block contents
   * - Object input: JSON.stringify
   * - null/undefined: returns empty string (but always at least "[empty]")
   *
   * Requirements: 8.2
   */
  normalize(content: unknown): string {
    if (content === null || content === undefined) {
      return '[empty]';
    }

    if (typeof content === 'string') {
      const stripped = stripMarkdown(content);
      return stripped.length > 0 ? stripped : '[empty]';
    }

    if (typeof content === 'object') {
      try {
        const json = JSON.stringify(content);
        return json.length > 0 ? json : '[empty]';
      } catch {
        return '[empty]';
      }
    }

    // For other types (number, boolean, etc.), convert to string
    const str = String(content);
    return str.length > 0 ? str : '[empty]';
  }

  // ─── Private helpers ────────────────────────────────────────────

  /** Check if output is empty or contains only error patterns. */
  private isErrorOrEmpty(output: string): boolean {
    if (!output || output.trim().length === 0) {
      return true;
    }

    const trimmed = output.trim();

    // Check if the entire output matches error patterns
    return ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  /** Resolve a domain string to a known template key. */
  private resolveDomainKey(domain: string): string {
    const lower = domain.toLowerCase();

    if (lower.includes('code') || lower.includes('develop') || lower.includes('program') || lower.includes('engineer')) {
      return 'code';
    }
    if (lower.includes('deploy') || lower.includes('devops') || lower.includes('infra') || lower.includes('ci')) {
      return 'deploy';
    }
    if (lower.includes('research') || lower.includes('analy') || lower.includes('data') || lower.includes('science')) {
      return 'research';
    }
    if (lower.includes('test') || lower.includes('qa') || lower.includes('quality')) {
      return 'test';
    }

    return 'default';
  }

  /** Load memory facts for personalization. Returns empty array if store is unavailable. */
  private loadMemoryFacts(userId: string): Array<{ category: string; key: string; value: string }> {
    if (!this.memoryStore || !userId) {
      return [];
    }

    try {
      const facts = this.memoryStore.listFacts(userId);
      return facts.slice(0, 5).map((f) => ({
        category: f.category,
        key: f.key,
        value: f.value,
      }));
    } catch {
      return [];
    }
  }

  /** Build diagnostic suggestions (2–4 items, all category 'diagnostic'). */
  private buildDiagnosticSuggestions(): Suggestion[] {
    return DIAGNOSTIC_SUGGESTIONS.map((template) => ({
      id: randomUUID(),
      text: template.text,
      action: template.action,
      category: 'diagnostic' as const,
    }));
  }
}

export default SuggestionGenerator;
