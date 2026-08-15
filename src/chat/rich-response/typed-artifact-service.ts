/**
 * TypedArtifactService — Emits typed artifacts with explicit file target URIs
 * for code actions rather than assuming the active editor.
 *
 * Each artifact has: type, targetUri, content, metadata.
 * Never infers the active editor target.
 *
 * Requirements: 17.2, 17.3, 17.5
 */

import type {
  TypedArtifact,
  ArtifactType,
  ArtifactMetadata,
  EmitArtifactInput,
} from './types';

/**
 * Generates unique artifact IDs.
 */
function generateArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class TypedArtifactService {
  private readonly artifacts: Map<string, TypedArtifact> = new Map();

  /**
   * Emit a typed artifact with an explicit target URI.
   * Throws if targetUri is missing or empty.
   */
  emit(input: EmitArtifactInput): TypedArtifact {
    if (!input.targetUri || input.targetUri.trim() === '') {
      throw new Error(
        'Artifact targetUri is required. Never infer active editor; always provide an explicit file target URI.'
      );
    }

    if (!this.isValidArtifactType(input.type)) {
      throw new Error(`Invalid artifact type: ${input.type}`);
    }

    if (!input.content && input.content !== '') {
      throw new Error('Artifact content is required.');
    }

    const artifact: TypedArtifact = {
      id: generateArtifactId(),
      type: input.type,
      targetUri: input.targetUri,
      content: input.content,
      metadata: this.buildMetadata(input.metadata),
      createdAt: new Date().toISOString(),
    };

    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  /**
   * Retrieve an artifact by ID.
   */
  get(id: string): TypedArtifact | undefined {
    return this.artifacts.get(id);
  }

  /**
   * Get all artifacts for a specific target URI.
   */
  getByTargetUri(targetUri: string): readonly TypedArtifact[] {
    const results: TypedArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.targetUri === targetUri) {
        results.push(artifact);
      }
    }
    return results;
  }

  /**
   * Get all artifacts of a specific type.
   */
  getByType(type: ArtifactType): readonly TypedArtifact[] {
    const results: TypedArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.type === type) {
        results.push(artifact);
      }
    }
    return results;
  }

  /**
   * Get all artifacts associated with a task.
   */
  getByTaskId(taskId: string): readonly TypedArtifact[] {
    const results: TypedArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.metadata.taskId === taskId) {
        results.push(artifact);
      }
    }
    return results;
  }

  /**
   * Get all stored artifacts.
   */
  getAll(): readonly TypedArtifact[] {
    return [...this.artifacts.values()];
  }

  /**
   * Clear all artifacts (useful for testing).
   */
  clear(): void {
    this.artifacts.clear();
  }

  // ─── Private helpers ──────────────────────────────────────────

  private isValidArtifactType(type: string): type is ArtifactType {
    const validTypes: readonly string[] = [
      'code_change',
      'file_create',
      'file_modify',
      'diagram',
      'data',
    ];
    return validTypes.includes(type);
  }

  private buildMetadata(partial?: Partial<ArtifactMetadata>): ArtifactMetadata {
    return {
      language: partial?.language,
      version: partial?.version,
      taskId: partial?.taskId,
      runId: partial?.runId,
      changeSetId: partial?.changeSetId,
      description: partial?.description,
    };
  }
}
