/**
 * Code Actions — Editor context menu actions for AI-assisted coding.
 *
 * Provides: Explain, Refactor, Write Tests, Fix Error, Document, Optimize
 * Each action takes selected code + context and produces a prompt for the LLM.
 */

export type CodeActionType = 'explain' | 'refactor' | 'write-tests' | 'fix-error' | 'document' | 'optimize' | 'review';

export interface CodeActionRequest {
  action: CodeActionType;
  code: string;
  language: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  errorMessage?: string;
  projectId?: string;
}

export interface CodeActionResult {
  action: CodeActionType;
  prompt: string;
  systemPrompt: string;
}

const ACTION_PROMPTS: Record<CodeActionType, { system: string; template: string }> = {
  'explain': {
    system: 'You are a senior software engineer explaining code to a colleague. Be clear and concise.',
    template: 'Explain what this {language} code does, step by step:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
  'refactor': {
    system: 'You are a senior software engineer focused on clean code. Suggest refactoring improvements with the refactored code.',
    template: 'Refactor this {language} code for better readability, performance, and maintainability. Show the improved version:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
  'write-tests': {
    system: 'You are a test engineer. Write comprehensive tests using the project\'s existing test framework.',
    template: 'Write unit tests for this {language} code. Cover edge cases and error paths:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
  'fix-error': {
    system: 'You are a debugging expert. Identify the root cause and provide a fix.',
    template: 'Fix the error in this {language} code:\n\nFile: {filePath}\nError: {errorMessage}\n```{language}\n{code}\n```',
  },
  'document': {
    system: 'You are a technical writer. Add clear, useful documentation comments.',
    template: 'Add documentation comments (JSDoc/docstring/etc.) to this {language} code:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
  'optimize': {
    system: 'You are a performance engineer. Identify bottlenecks and optimize.',
    template: 'Optimize this {language} code for performance. Explain what you changed and why:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
  'review': {
    system: 'You are a staff engineer doing a code review. Find bugs, security issues, and improvement opportunities.',
    template: 'Review this {language} code. Flag bugs, security issues, and suggest improvements:\n\nFile: {filePath}\n```{language}\n{code}\n```',
  },
};

/**
 * Build a prompt for a code action.
 */
export function buildCodeActionPrompt(request: CodeActionRequest): CodeActionResult {
  const config = ACTION_PROMPTS[request.action];
  if (!config) {
    return {
      action: request.action,
      prompt: `Analyze this code:\n\`\`\`${request.language}\n${request.code}\n\`\`\``,
      systemPrompt: 'You are a helpful coding assistant.',
    };
  }

  let prompt = config.template
    .replace(/\{language\}/g, request.language)
    .replace(/\{filePath\}/g, request.filePath)
    .replace(/\{code\}/g, request.code)
    .replace(/\{errorMessage\}/g, request.errorMessage || 'Unknown error');

  return {
    action: request.action,
    prompt,
    systemPrompt: config.system,
  };
}
