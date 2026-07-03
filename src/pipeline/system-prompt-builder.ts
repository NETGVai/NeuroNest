/**
 * SystemPromptBuilder — Enhanced system prompt construction with code quality
 * and action-first directives, steering content, and power context insertion.
 *
 * This module extends the base buildSystemPrompt with feature-gated sections
 * for production UX requirements:
 * - Code quality enforcement (Req 3.1–3.5)
 * - Action-first behavior (Req 2.1, 2.2, 2.4)
 * - Steering content prepending (Req 16.4)
 * - Power context appending (Req 19.2, 19.4)
 *
 * Feature gates:
 * - production_ux_code_quality: controls CodeQualityDirectives section
 * - production_ux_action_first: controls ActionFirstDirectives section
 */

import type { FunctionDefinition } from './agent-loop';

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for enhanced system prompt construction */
export interface SystemPromptConfig {
  projectDir: string;
  tools: FunctionDefinition[];
  rulesContent?: string;
  relevantContext?: string;
  /** Steering file content — prepended before instructions */
  steeringContent?: string;
  /** Power context — appended to system prompt when a power is activated */
  powerContext?: string;
  /** Code quality enforcement directives */
  codeQualityDirectives: CodeQualityDirectives;
  /** Action-first behavior directives */
  actionFirstDirectives: ActionFirstDirectives;
}

/** Controls code quality enforcement in the system prompt */
export interface CodeQualityDirectives {
  enforceErrorHandling: boolean;
  enforceTypeSafety: boolean;
  enforceConventionFollowing: boolean;
  enforceVerification: boolean;
  verificationTools: string[]; // e.g., ['tsc', 'eslint', 'vitest --run']
}

/** Controls action-first behavior enforcement in the system prompt */
export interface ActionFirstDirectives {
  prohibitPlanOnlyResponses: boolean;
  requireToolUsageForFileOps: boolean;
  requireToolUsageForExecution: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────

/** Default code quality directives — all enforcement enabled */
export const DEFAULT_CODE_QUALITY_DIRECTIVES: CodeQualityDirectives = {
  enforceErrorHandling: true,
  enforceTypeSafety: true,
  enforceConventionFollowing: true,
  enforceVerification: true,
  verificationTools: ['tsc', 'eslint'],
};

/** Default action-first directives — all enforcement enabled */
export const DEFAULT_ACTION_FIRST_DIRECTIVES: ActionFirstDirectives = {
  prohibitPlanOnlyResponses: true,
  requireToolUsageForFileOps: true,
  requireToolUsageForExecution: true,
};

// ─── Builder ────────────────────────────────────────────────────

/**
 * Build an enhanced system prompt incorporating code quality directives,
 * action-first directives, steering content, and power context.
 *
 * When feature gates are disabled (directives have all-false flags), the
 * corresponding sections are omitted from the prompt. The base instructions
 * remain identical to the original buildSystemPrompt for backwards compatibility.
 */
export function buildEnhancedSystemPrompt(config: SystemPromptConfig): string {
  const {
    projectDir,
    tools,
    rulesContent,
    relevantContext,
    steeringContent,
    powerContext,
    codeQualityDirectives,
    actionFirstDirectives,
  } = config;

  const toolDescriptions = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join('\n');

  // ── Sections ──────────────────────────────────────────────────

  const rulesSection = rulesContent
    ? `## Project Rules\n${rulesContent}\n\n`
    : '';

  const contextSection = relevantContext
    ? `## Relevant Context\n${relevantContext}\n\n`
    : '';

  const steeringSection = steeringContent
    ? `## Project Steering\n${steeringContent}\n\n`
    : '';

  const codeQualitySection = buildCodeQualitySection(codeQualityDirectives);
  const actionFirstSection = buildActionFirstSection(actionFirstDirectives);

  const powerSection = powerContext
    ? `\n\n## Active Power Context\n${powerContext}`
    : '';

  // ── Assembly ──────────────────────────────────────────────────

  return (
    `${steeringSection}${rulesSection}${contextSection}` +
    `You are NeuroNest, an AI coding assistant with access to tools for reading, writing, and executing operations on the user's project.\n\n` +
    `## Project Directory\n${projectDir}\n\n` +
    `## Available Tools\n${toolDescriptions}\n\n` +
    `## Instructions\n` +
    `- ALWAYS use tools to accomplish the user's request. Do NOT just describe what you would do — actually do it by calling the available tools.\n` +
    `- Start by reading existing files to understand the project structure, then create/modify files as needed.\n` +
    `- When asked to build something, immediately begin creating files and running commands. Do not ask for permission or present a plan first.\n` +
    `- Read files before making edits to understand current state\n` +
    `- When a tool call fails, analyze the error and try an alternative approach\n` +
    `- Provide brief explanations of what you're doing between tool calls\n` +
    `- When you're done, provide a final summary of all changes made\n` +
    `- NEVER respond with only text when the user asked you to build, create, or implement something. Use your tools.` +
    codeQualitySection +
    actionFirstSection +
    powerSection
  );
}

// ─── Section Builders ───────────────────────────────────────────

/**
 * Build the code quality directives section.
 * Only includes directives that are enabled; returns empty string when all are disabled.
 */
function buildCodeQualitySection(directives: CodeQualityDirectives): string {
  const lines: string[] = [];

  if (directives.enforceErrorHandling) {
    lines.push(
      '- Always include proper error handling with try/catch blocks. Handle edge cases and potential failures gracefully.',
    );
  }

  if (directives.enforceTypeSafety) {
    lines.push(
      '- Use TypeScript types for all function parameters and return values. Avoid `any` types; prefer explicit interfaces or type aliases.',
    );
  }

  if (directives.enforceConventionFollowing) {
    lines.push(
      '- Follow the conventions and patterns already present in the project. Match existing code style, naming conventions, and architectural patterns.',
    );
  }

  if (directives.enforceVerification) {
    const toolList = directives.verificationTools.length > 0
      ? ` (${directives.verificationTools.join(', ')})`
      : '';
    lines.push(
      `- Verify generated code by running available verification tools${toolList} after writing files. Fix any reported errors before proceeding.`,
    );
  }

  if (lines.length === 0) {
    return '';
  }

  return `\n\n## Code Quality Requirements\n${lines.join('\n')}`;
}

/**
 * Build the action-first directives section.
 * Only includes directives that are enabled; returns empty string when all are disabled.
 */
function buildActionFirstSection(directives: ActionFirstDirectives): string {
  const lines: string[] = [];

  if (directives.prohibitPlanOnlyResponses) {
    lines.push(
      '- NEVER respond with only a plan or description when tools are available to fulfill the request. Do not list steps—execute them.',
    );
  }

  if (directives.requireToolUsageForFileOps) {
    lines.push(
      '- When a user requests file creation, modification, or deletion, use the appropriate file tool immediately. Do not describe the changes—make them.',
    );
  }

  if (directives.requireToolUsageForExecution) {
    lines.push(
      '- When a user requests command execution, build steps, or test runs, use the shell-exec tool immediately. Do not suggest commands—run them.',
    );
  }

  if (lines.length === 0) {
    return '';
  }

  return `\n\n## Action-First Directives\n${lines.join('\n')}`;
}
