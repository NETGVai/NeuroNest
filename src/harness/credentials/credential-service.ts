/**
 * Credential Service — Stores credential references and resolves secret values
 * only at operation boundaries.
 *
 * Key invariants:
 * - Only CredentialRef (reference metadata) is stored, never the resolved secret value.
 * - Secret resolution is lazy: secrets are resolved only when an operation requires them.
 * - Non-secret availability metadata is exposed for inspection.
 * - External revisions are validated completely before commit.
 * - Consumers receive typed StorageForm values, never raw handles.
 * - Resolved secrets are excluded from JSON.stringify of any public surface.
 *
 * Requirements: 22.1–22.8
 */

import type {
  CredentialRef,
  AvailabilityMetadata,
  ExternalRevision,
  StorageForm,
  ResolvedSecret,
  SecretProviderType,
} from './schemas';
import {
  CredentialRefSchema,
  ExternalRevisionSchema,
} from './schemas';

// ─── Secret Provider Interface ──────────────────────────────────

/**
 * A pluggable secret provider that can resolve credential references to values.
 * Implementations handle environment variables, files, OS keychains, etc.
 */
export interface SecretProvider {
  readonly type: SecretProviderType;
  /**
   * Resolve a secret value from the provider.
   * Returns the raw secret string or undefined if not available.
   */
  resolve(providerKey: string): string | undefined;
  /**
   * Check whether a secret is available without resolving its value.
   */
  isAvailable(providerKey: string): boolean;
}

// ─── Validation Errors ──────────────────────────────────────────

export interface RevisionValidationError {
  field: string;
  reason: string;
}

export interface RevisionValidationResult {
  valid: boolean;
  errors: RevisionValidationError[];
}

// ─── Credential Service ─────────────────────────────────────────

/**
 * Manages credential references, lazy secret resolution, availability inspection,
 * external revision validation, and typed storage form delivery.
 */
export class CredentialService {
  /**
   * Internal store of credential references (never stores secret values).
   */
  private readonly refs: Map<string, CredentialRef> = new Map();

  /**
   * Registered secret providers keyed by type.
   */
  private readonly providers: Map<SecretProviderType, SecretProvider> = new Map();

  /**
   * Committed revision history for audit (never contains secrets).
   */
  private readonly committedRevisions: ExternalRevision[] = [];

  /**
   * Current revision counter.
   */
  private currentRevision = 0;

  // ─── Provider Registration ──────────────────────────────────

  /**
   * Register a secret provider for a given type.
   */
  registerProvider(provider: SecretProvider): void {
    this.providers.set(provider.type, provider);
  }

  // ─── Reference Storage (22.1) ───────────────────────────────

  /**
   * Store a credential reference. Only the reference metadata is persisted,
   * NEVER the resolved secret value.
   */
  storeRef(ref: CredentialRef): void {
    // Validate the reference shape
    CredentialRefSchema.parse(ref);
    this.refs.set(ref.refId, { ...ref });
  }

  /**
   * Retrieve a stored credential reference by ID.
   * Returns the reference metadata only — never a secret value.
   */
  getRef(refId: string): CredentialRef | undefined {
    const ref = this.refs.get(refId);
    return ref ? { ...ref } : undefined;
  }

  /**
   * List all stored credential references.
   * Returns only reference metadata — never secret values.
   */
  listRefs(): CredentialRef[] {
    return Array.from(this.refs.values()).map((ref) => ({ ...ref }));
  }

  /**
   * Remove a credential reference.
   */
  removeRef(refId: string): boolean {
    return this.refs.delete(refId);
  }

  // ─── Lazy Secret Resolution (22.2) ─────────────────────────

  /**
   * Resolve a credential reference to its secret value AT THE OPERATION BOUNDARY.
   *
   * This method should only be called at the point where the secret is actually
   * needed for an operation (e.g., making an API call). The resolved value must
   * not be stored, logged, or passed to any surface that serializes state.
   *
   * Returns undefined if the provider is not registered or the secret is unavailable.
   */
  resolveAtBoundary(refId: string): ResolvedSecret | undefined {
    const ref = this.refs.get(refId);
    if (!ref) return undefined;

    const provider = this.providers.get(ref.providerType);
    if (!provider) return undefined;

    const value = provider.resolve(ref.providerKey);
    if (value === undefined) return undefined;

    return {
      value,
      ref: { ...ref },
      resolvedAt: new Date().toISOString(),
    };
  }

  // ─── Availability Metadata (22.3) ──────────────────────────

  /**
   * Get non-secret availability metadata for a credential reference.
   * Exposes provider type, availability, and validation status WITHOUT
   * revealing the secret value.
   */
  getAvailability(refId: string): AvailabilityMetadata | undefined {
    const ref = this.refs.get(refId);
    if (!ref) return undefined;

    const provider = this.providers.get(ref.providerType);
    const available = provider ? provider.isAvailable(ref.providerKey) : false;

    return {
      refId: ref.refId,
      available,
      providerType: ref.providerType,
      lastValidationStatus: available ? 'valid' : (provider ? 'invalid' : 'unchecked'),
      lastCheckedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
  }

  // ─── External Revision Validation (22.5–22.7) ──────────────

  /**
   * Validate a complete external revision before commit.
   * The candidate must pass schema validation and contain all required fields
   * (version, scope, actor, timestamp, changed keys, source layer).
   */
  validateRevision(candidate: unknown): RevisionValidationResult {
    const errors: RevisionValidationError[] = [];

    const parsed = ExternalRevisionSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          field: issue.path.join('.'),
          reason: issue.message,
        });
      }
      return { valid: false, errors };
    }

    const revision = parsed.data;

    // Ensure revision is strictly increasing
    if (revision.revision <= this.currentRevision) {
      errors.push({
        field: 'revision',
        reason: `Revision ${revision.revision} must be greater than current revision ${this.currentRevision}`,
      });
    }

    // Ensure changedKeys is non-empty
    if (revision.changedKeys.length === 0) {
      errors.push({
        field: 'changedKeys',
        reason: 'Revision must declare at least one changed key',
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Commit a validated external revision.
   * Records changed keys, source layer, revision, actor, and timestamp
   * WITHOUT recording secrets.
   *
   * Returns false if validation fails.
   */
  commitRevision(candidate: unknown): boolean {
    const validation = this.validateRevision(candidate);
    if (!validation.valid) return false;

    const revision = ExternalRevisionSchema.parse(candidate);
    this.currentRevision = revision.revision;
    this.committedRevisions.push(revision);
    return true;
  }

  /**
   * Get the current committed revision number.
   */
  getCurrentRevision(): number {
    return this.currentRevision;
  }

  // ─── Typed Storage Forms (22.8) ────────────────────────────

  /**
   * Return a typed StorageForm for a credential reference.
   * Insulates the consumer from the persistence backend — the consumer never
   * receives a raw database handle, file descriptor, or secret-provider handle.
   */
  getStorageForm(refId: string): StorageForm | undefined {
    const ref = this.refs.get(refId);
    if (!ref) return undefined;

    return {
      kind: 'credential-ref',
      payload: {
        refId: ref.refId,
        providerType: ref.providerType,
        providerKey: ref.providerKey,
        label: ref.label,
      },
      sourceRevision: this.currentRevision || 1,
      resolvedFrom: 'default',
      containsSecret: false as const,
      schemaVersion: 1,
    };
  }

  // ─── Serialization Safety ──────────────────────────────────

  /**
   * Custom toJSON to ensure no secrets leak through serialization.
   * Only exposes reference counts and revision metadata.
   */
  toJSON(): Record<string, unknown> {
    return {
      refCount: this.refs.size,
      currentRevision: this.currentRevision,
      committedRevisionCount: this.committedRevisions.length,
      providerTypes: Array.from(this.providers.keys()),
    };
  }
}
