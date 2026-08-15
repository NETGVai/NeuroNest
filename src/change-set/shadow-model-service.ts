/**
 * ShadowModelService — creates non-file URI shadow Monaco models for preview.
 *
 * Shadow models use the `neuronest-diff://<changeSetId>/<encoded-uri>` scheme
 * and CANNOT be resolved as writable filesystem targets. They exist solely for
 * previewing proposed changes without mutating authoritative workspace content
 * or coupling to the active editor.
 */

/**
 * The URI scheme for shadow preview models.
 * This scheme is intentionally non-file to prevent filesystem writes.
 */
export const SHADOW_MODEL_SCHEME = 'neuronest-diff';

/**
 * Represents a shadow model for previewing a proposed file operation.
 */
export interface ShadowModel {
  /** The unique shadow model URI (neuronest-diff://...) */
  readonly uri: string;
  /** The Change_Set ID this model belongs to */
  readonly changeSetId: string;
  /** The original workspace file URI this preview relates to */
  readonly originalUri: string;
  /** The base content (before changes) — null for create operations */
  readonly baseContent: string | null;
  /** The proposed content (after changes) — null for delete operations */
  readonly proposedContent: string | null;
  /** Language identifier for syntax highlighting */
  readonly languageId: string;
  /** Whether this model is read-only (always true for shadow models) */
  readonly readOnly: true;
}

/**
 * Parameters for creating a shadow model.
 */
export interface CreateShadowModelParams {
  changeSetId: string;
  originalUri: string;
  baseContent: string | null;
  proposedContent: string | null;
  languageId?: string;
}

/**
 * Generates a shadow model URI for a given Change_Set and file.
 *
 * Format: neuronest-diff://<changeSetId>/<encoded-uri>
 */
export function buildShadowModelUri(changeSetId: string, originalUri: string): string {
  const encodedUri = encodeURIComponent(originalUri);
  return `${SHADOW_MODEL_SCHEME}://${changeSetId}/${encodedUri}`;
}

/**
 * Parses a shadow model URI back into its components.
 * Returns null if the URI is not a valid shadow model URI.
 */
export function parseShadowModelUri(
  uri: string
): { changeSetId: string; originalUri: string } | null {
  const prefix = `${SHADOW_MODEL_SCHEME}://`;
  if (!uri.startsWith(prefix)) return null;

  const rest = uri.slice(prefix.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) return null;

  const changeSetId = rest.slice(0, slashIndex);
  const encodedUri = rest.slice(slashIndex + 1);

  if (!changeSetId || !encodedUri) return null;

  try {
    const originalUri = decodeURIComponent(encodedUri);
    return { changeSetId, originalUri };
  } catch {
    return null;
  }
}

/**
 * Checks whether a URI is a shadow model URI (non-writable).
 */
export function isShadowModelUri(uri: string): boolean {
  return uri.startsWith(`${SHADOW_MODEL_SCHEME}://`);
}

/**
 * ShadowModelService manages preview models for Change_Set operations.
 *
 * Shadow models:
 * - Use non-file URIs that cannot be resolved as writable filesystem targets
 * - Are always read-only
 * - Support viewing proposed changes without affecting the workspace
 * - Are ephemeral and tied to the lifecycle of their parent Change_Set
 */
export class ShadowModelService {
  private readonly models = new Map<string, ShadowModel>();

  /**
   * Creates a shadow model for previewing a proposed file change.
   * Shadow models are immutable and read-only by design.
   */
  create(params: CreateShadowModelParams): ShadowModel {
    const uri = buildShadowModelUri(params.changeSetId, params.originalUri);

    const model: ShadowModel = Object.freeze({
      uri,
      changeSetId: params.changeSetId,
      originalUri: params.originalUri,
      baseContent: params.baseContent,
      proposedContent: params.proposedContent,
      languageId: params.languageId ?? 'plaintext',
      readOnly: true as const,
    });

    this.models.set(uri, model);
    return model;
  }

  /**
   * Retrieves a shadow model by its URI.
   */
  get(uri: string): ShadowModel | undefined {
    return this.models.get(uri);
  }

  /**
   * Lists all shadow models for a given Change_Set.
   */
  listByChangeSet(changeSetId: string): ShadowModel[] {
    return Array.from(this.models.values()).filter(
      (m) => m.changeSetId === changeSetId
    );
  }

  /**
   * Disposes all shadow models for a given Change_Set.
   * Called when a Change_Set is applied, rejected, or failed.
   */
  disposeByChangeSet(changeSetId: string): number {
    let disposed = 0;
    for (const [uri, model] of this.models) {
      if (model.changeSetId === changeSetId) {
        this.models.delete(uri);
        disposed++;
      }
    }
    return disposed;
  }

  /**
   * Disposes a single shadow model by URI.
   */
  dispose(uri: string): boolean {
    return this.models.delete(uri);
  }

  /**
   * Attempts to write to a shadow model URI.
   * Always throws — shadow models cannot be written to.
   */
  assertNotWritable(uri: string): void {
    if (isShadowModelUri(uri)) {
      throw new Error(
        `Cannot write to shadow model URI '${uri}': ` +
          `shadow models are read-only previews and cannot be resolved as writable filesystem targets`
      );
    }
  }

  /**
   * Returns the total number of shadow models.
   */
  get size(): number {
    return this.models.size;
  }
}
