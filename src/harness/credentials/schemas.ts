/**
 * Credential Schemas — Zod contracts for credential references, storage forms,
 * availability metadata, and external revisions.
 *
 * Credential references store only the identity and provider type of a secret,
 * never the resolved value. Storage forms insulate consumers from the persistence
 * backend. Availability metadata exposes non-secret inspection data.
 *
 * Requirements: 22.1–22.8
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';

// ─── Secret Provider Types ──────────────────────────────────────

/**
 * Supported secret resolution providers.
 */
export const SecretProviderTypeSchema = z.enum([
  'environment',
  'file',
  'os-keychain',
]);

export type SecretProviderType = z.infer<typeof SecretProviderTypeSchema>;

// ─── Credential Reference ───────────────────────────────────────

/**
 * A credential reference stores identity and provider metadata without the
 * actual secret value. This is the only representation that persists in
 * settings, logs, prompts, exports, or UI metadata.
 *
 * Requirements: 22.1
 */
export const CredentialRefSchema = z.object({
  /** Unique credential identity */
  refId: IdentifierSchema,
  /** The type of secret provider that can resolve this reference */
  providerType: SecretProviderTypeSchema,
  /** Provider-specific key or path used to locate the secret (not the secret itself) */
  providerKey: IdentifierSchema,
  /** Human-readable label for UI display */
  label: z.string().optional(),
  /** When this reference was registered */
  createdAt: TimestampSchema,
  /** Schema version for forward compatibility */
  schemaVersion: z.literal(1),
}).passthrough();

export type CredentialRef = z.infer<typeof CredentialRefSchema>;

// ─── Availability Metadata ──────────────────────────────────────

/**
 * Non-secret availability metadata exposed for inspection. Contains provider
 * type, existence, validity, and last-check status — but NEVER the secret value.
 *
 * Requirements: 22.3
 */
export const AvailabilityMetadataSchema = z.object({
  /** Reference to the credential */
  refId: IdentifierSchema,
  /** Whether the secret provider reports the credential as available */
  available: z.boolean(),
  /** Provider type for display purposes */
  providerType: SecretProviderTypeSchema,
  /** Last validation status */
  lastValidationStatus: z.enum(['valid', 'invalid', 'unchecked', 'expired']),
  /** When availability was last checked */
  lastCheckedAt: TimestampSchema.optional(),
  /** Schema version */
  schemaVersion: z.literal(1),
}).passthrough();

export type AvailabilityMetadata = z.infer<typeof AvailabilityMetadataSchema>;

// ─── External Revision ──────────────────────────────────────────

/**
 * A complete external revision for credential or settings updates.
 * Must be validated before commit (Requirements: 22.5–22.7).
 */
export const ExternalRevisionSchema = z.object({
  /** Monotonically increasing revision number */
  revision: z.number().int().positive(),
  /** Scope layer the revision targets */
  scope: z.enum(['user', 'workspace', 'project', 'session']),
  /** Actor who authored the revision */
  actor: IdentifierSchema,
  /** Timestamp of the revision */
  timestamp: TimestampSchema,
  /** Changed keys in this revision (never contains secrets) */
  changedKeys: z.array(z.string().min(1)),
  /** Source layer provenance */
  sourceLayer: z.string().min(1),
  /** Schema version */
  schemaVersion: z.literal(1),
}).passthrough();

export type ExternalRevision = z.infer<typeof ExternalRevisionSchema>;

// ─── Storage Form ───────────────────────────────────────────────

/**
 * A typed storage form that insulates consumers from the concrete persistence
 * backend. Consumers receive StorageForm values rather than raw database handles,
 * file descriptors, or secret-provider handles.
 *
 * Requirements: 22.8
 */
export const StorageFormSchema = z.object({
  /** The kind of storage form (discriminator) */
  kind: z.enum(['credential-ref', 'setting-value', 'bound-value']),
  /** The typed payload for this storage form */
  payload: z.unknown(),
  /** Source revision that produced this form */
  sourceRevision: z.number().int().positive(),
  /** Scope from which the value was resolved */
  resolvedFrom: z.enum(['user', 'workspace', 'project', 'session', 'default']),
  /** Whether this form carries secret material (always false for exported forms) */
  containsSecret: z.literal(false),
  /** Schema version */
  schemaVersion: z.literal(1),
}).passthrough();

export type StorageForm = z.infer<typeof StorageFormSchema>;

// ─── Resolved Secret (internal, never serialized to public surfaces) ────

/**
 * Internal type representing a resolved secret. This is NEVER persisted to
 * settings, logs, prompts, exports, or UI metadata. It exists only for the
 * duration of an operation boundary execution.
 */
export interface ResolvedSecret {
  /** The resolved secret value — NEVER serialize this */
  readonly value: string;
  /** The credential reference that produced this resolution */
  readonly ref: CredentialRef;
  /** When the secret was resolved */
  readonly resolvedAt: string;
}
