/**
 * Prompt-to-App Workflow Orchestration
 *
 * Orchestrates the full end-to-end flow for generating a web application from
 * a natural language description:
 *
 *   1. User description → project decomposition (LLM)
 *   2. Project decomposition → file generation (LLM)
 *   3. File generation → sandbox deploy (WebContainerSandbox)
 *   4. Sandbox deploy → live preview URL
 *
 * Each iteration is stored as an ArtifactCheckpoint for version history,
 * enabling revert to any previous state.
 *
 * Hot-reload is wired for iterative refinements: when the user requests changes,
 * the orchestrator patches files in the sandbox and triggers hot-reload so the
 * preview updates without manual refresh.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import type { ArtifactService } from '../artifacts/artifact-service.js';
import type { ArtifactCheckpoint } from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { WebContainerSandbox } from './web-container-sandbox.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * LLM provider interface for prompt-to-app code generation.
 * Matches the pattern used in screenshot-to-code.ts.
 */
export interface AppGeneratorLLM {
  /** Generate a text completion from a prompt string. */
  generateText(prompt: string): Promise<string>;
}

/**
 * Describes the project structure decomposed from the user's description.
 */
export interface ProjectStructure {
  name: string;
  description: string;
  framework: string;
  files: GeneratedFile[];
}

/**
 * A single file to be generated and written to the sandbox.
 */
export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Options for initiating the prompt-to-app workflow.
 */
export interface PromptToAppOptions {
  /** Natural language description of the application to build. */
  description: string;
  /** Session ID for artifact linkage. */
  sessionId: string;
  /** Project directory for artifact storage. */
  projectDir: string;
  /** Optional preferred framework (e.g., 'react', 'vue', 'vanilla'). */
  framework?: string;
}

/**
 * Result of a prompt-to-app generation or refinement iteration.
 */
export interface PromptToAppResult {
  /** The sandbox instance ID hosting the running application. */
  sandboxInstanceId: string;
  /** The live preview URL for the running application. */
  previewUrl: string;
  /** The artifact ID storing the generated code. */
  artifactId: string;
  /** The current checkpoint version number. */
  version: number;
  /** The generated project structure. */
  projectStructure: ProjectStructure;
}

/**
 * Options for requesting a refinement to a running prompt-to-app.
 */
export interface RefinementOptions {
  /** Natural language description of changes requested. */
  changeDescription: string;
  /** Sandbox instance ID of the running app. */
  sandboxInstanceId: string;
  /** Artifact ID to update with new checkpoint. */
  artifactId: string;
}

/**
 * Result of a refinement iteration.
 */
export interface RefinementResult {
  /** Updated preview URL (may remain the same if hot-reloaded in place). */
  previewUrl: string;
  /** New checkpoint version number. */
  version: number;
  /** Files that were modified in this iteration. */
  modifiedFiles: string[];
  /** The updated project structure. */
  projectStructure: ProjectStructure;
}

// ─── Prompt Templates ───────────────────────────────────────────

/**
 * Build the project decomposition prompt from the user's description.
 * Instructs the LLM to output a JSON project structure.
 */
export function buildDecompositionPrompt(description: string, framework?: string): string {
  const frameworkHint = framework
    ? `Use the "${framework}" framework for this project.`
    : 'Choose the most appropriate framework based on the description (React, Vue, or vanilla HTML/JS).';

  return `You are a senior full-stack developer. Given the following application description, decompose it into a complete project structure.

## Application Description
${description}

## Framework
${frameworkHint}

## Instructions
1. Choose a project name (lowercase, kebab-case)
2. Determine the framework and required dependencies
3. Generate ALL necessary files for a working application:
   - package.json with all dependencies and a "dev" script
   - Configuration files (vite.config.js, tsconfig.json, etc. as appropriate)
   - Source code files implementing the described functionality
   - A README.md documenting the project structure
4. Each file must contain complete, production-ready code
5. The project must be runnable via "npm install && npm run dev"

## Output Format
Respond with ONLY a valid JSON object (no markdown fences, no explanation) matching this structure:
{
  "name": "project-name",
  "description": "Brief description",
  "framework": "react|vue|vanilla",
  "files": [
    { "path": "package.json", "content": "..." },
    { "path": "src/main.tsx", "content": "..." }
  ]
}`;
}

/**
 * Build a refinement prompt for iterative changes.
 * Includes the current file list so the LLM can produce targeted patches.
 */
export function buildRefinementPrompt(
  changeDescription: string,
  currentFiles: GeneratedFile[],
): string {
  const fileList = currentFiles
    .map((f) => `- ${f.path} (${f.content.length} chars)`)
    .join('\n');

  const fileSources = currentFiles
    .map((f) => `=== ${f.path} ===\n${f.content}`)
    .join('\n\n');

  return `You are a senior full-stack developer. The user has a running application and wants changes made.

## Current Project Files
${fileList}

## Current Source Code
${fileSources}

## Requested Changes
${changeDescription}

## Instructions
1. Identify which files need to be modified or created
2. Generate ONLY the files that changed (include the full updated content for each)
3. If new files are needed, include them
4. Do NOT include files that remain unchanged
5. Ensure the project remains runnable after changes

## Output Format
Respond with ONLY a valid JSON object (no markdown fences, no explanation):
{
  "name": "project-name",
  "description": "Updated description",
  "framework": "react|vue|vanilla",
  "files": [
    { "path": "src/App.tsx", "content": "...full updated content..." }
  ]
}`;
}

// ─── JSON Parsing Helper ────────────────────────────────────────

/**
 * Parse LLM output as a ProjectStructure, handling potential markdown wrapping.
 */
export function parseLLMProjectOutput(raw: string): ProjectStructure {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    // Remove opening fence (```json or ```)
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '');
    // Remove closing fence
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new FeatureError({
      message: 'Failed to parse LLM output as JSON. The model returned invalid project structure.',
      category: 'sandbox',
      code: 'LLM_PARSE_ERROR',
      details: { rawOutput: raw.slice(0, 500) },
    });
  }

  // Validate structure
  const obj = parsed as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new FeatureError({
      message: 'LLM output is not an object',
      category: 'sandbox',
      code: 'LLM_PARSE_ERROR',
    });
  }

  const name = typeof obj.name === 'string' ? obj.name : 'generated-app';
  const description = typeof obj.description === 'string' ? obj.description : '';
  const framework = typeof obj.framework === 'string' ? obj.framework : 'vanilla';

  if (!Array.isArray(obj.files)) {
    throw new FeatureError({
      message: 'LLM output missing "files" array',
      category: 'sandbox',
      code: 'LLM_PARSE_ERROR',
      details: { keys: Object.keys(obj) },
    });
  }

  const files: GeneratedFile[] = (obj.files as unknown[])
    .filter((f): f is { path: string; content: string } => {
      return (
        typeof f === 'object' &&
        f !== null &&
        typeof (f as Record<string, unknown>).path === 'string' &&
        typeof (f as Record<string, unknown>).content === 'string'
      );
    })
    .map((f) => ({ path: f.path, content: f.content }));

  if (files.length === 0) {
    throw new FeatureError({
      message: 'LLM output contains no valid files',
      category: 'sandbox',
      code: 'LLM_PARSE_ERROR',
    });
  }

  return { name, description, framework, files };
}

// ─── PromptToAppService ─────────────────────────────────────────

/**
 * Orchestrates the prompt-to-app workflow:
 *   User description → LLM decomposition → file generation → sandbox deploy → live preview
 *
 * Integrates with ArtifactService to store each iteration as an ArtifactCheckpoint
 * for version history and rollback support.
 *
 * Wires hot-reload for iterative refinements.
 */
export class PromptToAppService {
  /** Track current files per sandbox instance for refinement context. */
  private instanceFiles: Map<string, GeneratedFile[]> = new Map();

  constructor(
    private readonly llm: AppGeneratorLLM,
    private readonly sandbox: WebContainerSandbox,
    private readonly artifactService: ArtifactService,
  ) {}

  /**
   * Generate and deploy a full application from a natural language description.
   *
   * Flow:
   *   1. Send description to LLM for project decomposition (Req 10.1)
   *   2. Parse the structured project output (Req 10.2)
   *   3. Boot a WebContainer sandbox and write all files
   *   4. Run npm install and start dev server (Req 10.3)
   *   5. Store the generated code as a 'generated-app' artifact (Req 10.5)
   *   6. Return the live preview URL
   *
   * @throws FeatureError if LLM fails, sandbox unavailable, or install/server fails
   */
  async generate(options: PromptToAppOptions): Promise<PromptToAppResult> {
    const { description, sessionId, projectDir, framework } = options;

    // Step 1: Decompose via LLM
    const decompositionPrompt = buildDecompositionPrompt(description, framework);
    const llmOutput = await this.callLLM(decompositionPrompt);

    // Step 2: Parse project structure
    const projectStructure = parseLLMProjectOutput(llmOutput);

    // Step 3: Boot sandbox and write files
    const instance = await this.sandbox.boot();
    const sandboxInstanceId = instance.id;

    const fileMap: Record<string, string> = {};
    for (const file of projectStructure.files) {
      fileMap[file.path] = file.content;
    }
    await this.sandbox.writeFiles(sandboxInstanceId, fileMap);

    // Track files for future refinements
    this.instanceFiles.set(sandboxInstanceId, [...projectStructure.files]);

    // Step 4: Install dependencies and start dev server
    await this.sandbox.install(sandboxInstanceId);
    const previewUrl = await this.sandbox.startDevServer(sandboxInstanceId);

    // Step 5: Store as artifact (generated-app type) with initial checkpoint
    const allContent = this.serializeProjectFiles(projectStructure.files);
    const artifact = await this.artifactService.create({
      sessionId,
      projectDir,
      title: projectStructure.name || 'Generated App',
      type: 'generated-app',
      content: allContent,
      metadata: {
        framework: projectStructure.framework,
        description: projectStructure.description,
        fileCount: projectStructure.files.length,
        sandboxInstanceId,
        sourceDescription: description,
      },
    });

    return {
      sandboxInstanceId,
      previewUrl,
      artifactId: artifact.id,
      version: 1,
      projectStructure,
    };
  }

  /**
   * Apply a refinement to a running prompt-to-app instance.
   *
   * Flow:
   *   1. Get current files for context (Req 10.4)
   *   2. Send refinement request to LLM with current project state
   *   3. Parse the modified files from LLM output
   *   4. Write changed files to sandbox
   *   5. Trigger hot-reload so preview updates automatically (Req 10.4)
   *   6. Store the new iteration as an ArtifactCheckpoint (Req 10.5)
   *
   * @throws FeatureError if instance not found, LLM fails, or write/reload fails
   */
  async refine(options: RefinementOptions): Promise<RefinementResult> {
    const { changeDescription, sandboxInstanceId, artifactId } = options;

    // Step 1: Get current file state
    const currentFiles = this.instanceFiles.get(sandboxInstanceId);
    if (!currentFiles) {
      throw new FeatureError({
        message: `No tracked files for sandbox instance: ${sandboxInstanceId}`,
        category: 'sandbox',
        code: 'INSTANCE_NOT_TRACKED',
        details: { sandboxInstanceId },
      });
    }

    // Step 2: Send refinement request to LLM
    const refinementPrompt = buildRefinementPrompt(changeDescription, currentFiles);
    const llmOutput = await this.callLLM(refinementPrompt);

    // Step 3: Parse the modified files
    const patchStructure = parseLLMProjectOutput(llmOutput);
    const modifiedFiles = patchStructure.files.map((f) => f.path);

    // Step 4: Write changed files to sandbox
    const fileMap: Record<string, string> = {};
    for (const file of patchStructure.files) {
      fileMap[file.path] = file.content;
    }
    await this.sandbox.writeFiles(sandboxInstanceId, fileMap);

    // Update tracked files: merge modified into current set
    const mergedFiles = this.mergeFiles(currentFiles, patchStructure.files);
    this.instanceFiles.set(sandboxInstanceId, mergedFiles);

    // Step 5: Trigger hot-reload for the changed files
    await this.sandbox.hotReload(sandboxInstanceId, modifiedFiles);

    // Step 6: Store new iteration as ArtifactCheckpoint
    const allContent = this.serializeProjectFiles(mergedFiles);
    const checkpoint: ArtifactCheckpoint = await this.artifactService.update(artifactId, allContent);

    // Retrieve current preview URL from sandbox
    const instances = this.sandbox.getInstances();
    const currentInstance = instances.find((inst) => inst.id === sandboxInstanceId);
    const previewUrl = currentInstance?.previewUrl ?? '';

    // Build the full updated project structure
    const updatedProjectStructure: ProjectStructure = {
      name: patchStructure.name,
      description: patchStructure.description,
      framework: patchStructure.framework,
      files: mergedFiles,
    };

    return {
      previewUrl,
      version: checkpoint.version,
      modifiedFiles,
      projectStructure: updatedProjectStructure,
    };
  }

  /**
   * Get the current file state for a tracked sandbox instance.
   * Useful for displaying the project structure in the UI.
   */
  getTrackedFiles(sandboxInstanceId: string): GeneratedFile[] | null {
    return this.instanceFiles.get(sandboxInstanceId) ?? null;
  }

  /**
   * Remove tracking for a terminated sandbox instance.
   * Should be called when the sandbox is terminated.
   */
  removeTracking(sandboxInstanceId: string): void {
    this.instanceFiles.delete(sandboxInstanceId);
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /**
   * Call the LLM with error wrapping.
   */
  private async callLLM(prompt: string): Promise<string> {
    try {
      const result = await this.llm.generateText(prompt);
      if (!result || result.trim().length === 0) {
        throw new FeatureError({
          message: 'LLM returned empty response for project generation',
          category: 'sandbox',
          code: 'LLM_EMPTY_RESPONSE',
        });
      }
      return result;
    } catch (err) {
      if (err instanceof FeatureError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new FeatureError({
        message: `LLM generation failed: ${message}`,
        category: 'sandbox',
        code: 'LLM_GENERATION_FAILED',
        details: { originalError: message },
      });
    }
  }

  /**
   * Merge modified files into the current file set.
   * Updated files replace existing ones; new files are appended.
   */
  private mergeFiles(current: GeneratedFile[], modified: GeneratedFile[]): GeneratedFile[] {
    const fileMap = new Map<string, GeneratedFile>();

    // Add all current files
    for (const file of current) {
      fileMap.set(file.path, file);
    }

    // Override/add modified files
    for (const file of modified) {
      fileMap.set(file.path, file);
    }

    return Array.from(fileMap.values());
  }

  /**
   * Serialize all project files into a single string for artifact storage.
   * Uses a delimiter format that preserves file boundaries.
   */
  private serializeProjectFiles(files: GeneratedFile[]): string {
    return JSON.stringify(
      {
        _format: 'neuronest-generated-app-v1',
        files: files.map((f) => ({ path: f.path, content: f.content })),
      },
      null,
      2,
    );
  }
}
