/**
 * Auto-Versioning — Automatically commits file changes with AI-generated commit messages.
 *
 * After the Agent Loop completes a set of file modifications, this module:
 * 1. Checks if the project directory is a git repository
 * 2. Stages modified files
 * 3. Generates a conventional-commit message using the LLM
 * 4. Creates a commit
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Minimal LLM client interface for generating commit messages.
 * Kept intentionally thin so various LLMClient implementations are
 * structurally assignable without tight coupling.
 */
export interface AutoVersioningLLMClient {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ content?: string | null }>;
}

/**
 * Configuration options for auto-versioning behavior.
 */
export interface AutoVersioningConfig {
  /** When false, auto-versioning is skipped entirely. Default: true */
  autoVersioning?: boolean;
}

/**
 * Check if the given directory is inside a git work tree.
 * Returns true if it is, false otherwise.
 */
async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      timeout: 5000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Stage modified files using `git add`.
 * Returns true if staging succeeded, false otherwise.
 */
async function stageFiles(projectDir: string, files: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', ['add', ...files], {
      cwd: projectDir,
      timeout: 10000,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AutoVersioning] Failed to stage files:', message);
    return false;
  }
}

/**
 * Generate a conventional commit message using the LLM.
 * Returns the generated message or a fallback if the LLM call fails.
 */
async function generateCommitMessage(
  filesModified: string[],
  llmClient: AutoVersioningLLMClient,
): Promise<string> {
  const fileList = filesModified.join(', ');
  const prompt = `Generate a concise conventional commit message for these file changes: [${fileList}]. Format: type(scope): description. Reply with ONLY the commit message, no quotes, no explanation.`;

  try {
    const result = await llmClient.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, maxTokens: 100 },
    );

    const raw = (result?.content || '').trim();
    if (!raw) {
      return buildFallbackMessage(filesModified);
    }

    // Strip surrounding quotes if present
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();
    // Validate it looks like a conventional commit
    if (/^[a-z]+(\([^)]*\))?:\s*.+/i.test(cleaned)) {
      return cleaned;
    }
    // If the LLM returned something but not in the right format, use it anyway
    // but truncate to a reasonable length
    return cleaned.slice(0, 72);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AutoVersioning] LLM commit message generation failed:', message);
    return buildFallbackMessage(filesModified);
  }
}

/**
 * Build a fallback commit message when the LLM is unavailable.
 */
function buildFallbackMessage(filesModified: string[]): string {
  const count = filesModified.length;
  if (count === 1) {
    return `chore: update ${filesModified[0]}`;
  }
  return `chore: update ${count} files`;
}

/**
 * Create a git commit with the given message.
 * Returns true if commit succeeded, false otherwise.
 */
async function createCommit(projectDir: string, message: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['commit', '-m', message], {
      cwd: projectDir,
      timeout: 10000,
    });
    return true;
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    console.warn('[AutoVersioning] Failed to create commit:', message_);
    return false;
  }
}

/**
 * Automatically stage and commit modified files with an AI-generated commit message.
 *
 * Skips silently when:
 * - `config.autoVersioning` is false
 * - The project directory is not a git repository
 * - No files were modified
 *
 * Handles errors gracefully: logs warnings but never throws.
 *
 * @param projectDir - The project directory path
 * @param filesModified - List of file paths that were modified (relative or absolute)
 * @param llmClient - LLM client for generating commit messages
 * @param config - Optional configuration (respects autoVersioning setting)
 */
export async function autoCommit(
  projectDir: string,
  filesModified: string[],
  llmClient: AutoVersioningLLMClient,
  config?: AutoVersioningConfig,
): Promise<void> {
  // Respect autoVersioning config setting (skip if false)
  if (config?.autoVersioning === false) {
    return;
  }

  // Nothing to commit
  if (!filesModified || filesModified.length === 0) {
    return;
  }

  // Check if project dir is a git repo
  const gitRepo = await isGitRepo(projectDir);
  if (!gitRepo) {
    return;
  }

  // Stage modified files
  const staged = await stageFiles(projectDir, filesModified);
  if (!staged) {
    return;
  }

  // Generate commit message using LLM
  const commitMessage = await generateCommitMessage(filesModified, llmClient);

  // Create the commit
  await createCommit(projectDir, commitMessage);
}
