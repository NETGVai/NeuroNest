/**
 * Smart Suggestions — Context-aware next-step action buttons.
 *
 * After each agent response, analyzes the content and suggests
 * 3-4 relevant follow-up actions the user might want to take.
 *
 * Uses LLM-based suggestion generation when a provider is available,
 * falls back to regex-based content detection otherwise.
 */

export interface Suggestion {
  id: string;
  label: string;
  icon: string;
  prompt: string;
  category: 'code' | 'test' | 'docs' | 'review' | 'deploy' | 'debug' | 'explore';
}

/**
 * Generate smart suggestions using an LLM for contextual understanding.
 * Falls back to pattern-based generation if LLM is unavailable.
 */
export async function generateSuggestionsWithLLM(
  lastResponse: string,
  lastUserMessage: string,
  llmClient?: any,
  filePath?: string
): Promise<Suggestion[]> {
  if (llmClient) {
    try {
      const { generateSmartSuggestions } = await import('./llm-decision-engine');
      const result = await generateSmartSuggestions(lastResponse, lastUserMessage, llmClient);
      if (result && result.suggestions.length > 0) {
        return result.suggestions.map((s: any, i: number) => ({
          id: `llm-suggestion-${i}`,
          label: s.label,
          icon: s.icon,
          prompt: s.prompt,
          category: s.category,
        }));
      }
    } catch (err: any) {
      console.warn('[SmartSuggestions] LLM generation failed, using pattern fallback:', err?.message);
    }
  }
  return generateSuggestions(lastResponse, lastUserMessage, filePath);
}

/**
 * Generate smart suggestions based on the agent's last response (pattern-based fallback).
 */
export function generateSuggestions(lastResponse: string, lastUserMessage: string, filePath?: string): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const response = lastResponse.toLowerCase();
  const userMsg = lastUserMessage.toLowerCase();

  // After code generation
  if (/```[\w]*\n/.test(lastResponse) || /function |class |const |let |var |def |import /.test(response)) {
    suggestions.push({ id: 'write-tests', label: 'Write Tests', icon: '🧪', prompt: 'Write comprehensive unit tests for the code you just generated.', category: 'test' });
    suggestions.push({ id: 'add-docs', label: 'Add Documentation', icon: '📝', prompt: 'Add documentation comments to the code you just wrote.', category: 'docs' });
    suggestions.push({ id: 'review-code', label: 'Review Code', icon: '🔍', prompt: 'Review the code you just wrote for bugs, security issues, and improvements.', category: 'review' });
  }

  // After test results
  if (/test|spec|assert|expect|describe|it\(/.test(response)) {
    if (/fail|error|✗|✘|FAIL/.test(response)) {
      suggestions.push({ id: 'fix-tests', label: 'Fix Failing Tests', icon: '🔧', prompt: 'Fix the failing tests. Analyze the error messages and correct the issues.', category: 'debug' });
    } else {
      suggestions.push({ id: 'more-tests', label: 'Add Edge Cases', icon: '🧪', prompt: 'Add more edge case tests to improve coverage.', category: 'test' });
    }
  }

  // After error/debugging
  if (/error|exception|traceback|stack trace|bug|crash|fail/i.test(response)) {
    suggestions.push({ id: 'debug', label: 'Debug Further', icon: '🐛', prompt: 'Investigate the root cause of this error and suggest a fix.', category: 'debug' });
    suggestions.push({ id: 'add-error-handling', label: 'Add Error Handling', icon: '🛡️', prompt: 'Add proper error handling and recovery for this code.', category: 'code' });
  }

  // After file creation/modification
  if (/created|wrote|saved|generated|modified|updated/.test(response) && /file|\.ts|\.js|\.py|\.json/.test(response)) {
    suggestions.push({ id: 'run-it', label: 'Run It', icon: '▶️', prompt: 'Run the code we just created and show me the output.', category: 'deploy' });
  }

  // After explanation
  if (/explain|understand|how|what|why/.test(userMsg)) {
    suggestions.push({ id: 'refactor', label: 'Refactor', icon: '♻️', prompt: 'Refactor this code based on the explanation to make it cleaner.', category: 'code' });
    suggestions.push({ id: 'explore-more', label: 'Explore More', icon: '🔎', prompt: 'Show me related code and how it connects to what we just discussed.', category: 'explore' });
  }

  // After API/endpoint work
  if (/api|endpoint|route|controller|handler|fetch|request/.test(response)) {
    suggestions.push({ id: 'test-api', label: 'Test API', icon: '🌐', prompt: 'Generate curl commands or test scripts to verify the API endpoints.', category: 'test' });
  }

  // After component/UI work
  if (/component|render|jsx|tsx|html|css|style|layout|button|form|modal/.test(response)) {
    suggestions.push({ id: 'add-styles', label: 'Improve Styling', icon: '🎨', prompt: 'Improve the styling and make it responsive.', category: 'code' });
    suggestions.push({ id: 'accessibility', label: 'Add Accessibility', icon: '♿', prompt: 'Add ARIA labels and keyboard navigation for accessibility.', category: 'code' });
  }

  // Generic fallbacks (always available)
  if (suggestions.length < 2) {
    suggestions.push({ id: 'continue', label: 'Continue', icon: '➡️', prompt: 'Continue with the next logical step.', category: 'explore' });
    suggestions.push({ id: 'optimize', label: 'Optimize', icon: '⚡', prompt: 'Optimize the code for better performance.', category: 'code' });
  }

  // Deduplicate and limit to 4
  const seen = new Set<string>();
  return suggestions.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  }).slice(0, 4);
}
