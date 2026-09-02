/**
 * Plugin / MCP versioned manifest validation (NN-SEC-016, NN-INTEGRATION-003,
 * D-16.7).
 *
 * FUT-PKG-04-SECURITY/T-008. Third-party plugins and MCP servers declare a
 * versioned manifest before anything is staged. The manifest is the untrusted
 * boundary (NN-SEC-001): every field is schema-validated with zod, and a
 * malformed / ambiguous / missing manifest is a typed `VALIDATION` failure that
 * yields NO activation — never a "best-effort" partial install.
 *
 * D-16.7: "Manifests include publisher/source, package/version/integrity/
 * signature, transport/entrypoint, capabilities, permissions, schemas, sandbox
 * profile, resources, update policy, and provenance."
 *
 * The module is pure TypeScript (no Node/Electron I/O) so it runs identically
 * in the main process and in test fixtures.
 *
 * Requirements: NN-SEC-016, NN-INTEGRATION-003, NN-SEC-001, NN-INV-001,
 * NN-INV-009, NN-INV-011.
 * Design anchors: D-03, D-16 (D-16.7).
 */

import { z } from 'zod';
import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ContractValidation,
  type ErrorEnvelope,
} from '../../shared/contract-primitives';
import { SANDBOX_PROFILES } from '../../shared/platform-sandbox';

const MANIFEST_OWNER = 'authority-supply-chain';

// ─── Declared transports (NN-INTEGRATION-003) ───────────────────────────────

/** MCP transports declared by a manifest (NN-INTEGRATION-003: stdio/SSE/WS). */
export const MANIFEST_TRANSPORTS = Object.freeze([
  'stdio',
  'sse',
  'websocket',
  'in-process',
] as const);
export type ManifestTransport = (typeof MANIFEST_TRANSPORTS)[number];

/** The kind of artifact the manifest describes. */
export const MANIFEST_KINDS = Object.freeze(['plugin', 'mcp-server'] as const);
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

/** A requested capability/permission (least privilege, NN-INV-005). */
export const ManifestPermissionSchema = z.strictObject({
  /** Stable permission id, e.g. `fs.read`, `net.egress`, `process.spawn`. */
  id: z.string().min(1).max(128),
  /** Human-safe reason the plugin declares for requesting it. */
  reason: z.string().min(1).max(512),
});
export type ManifestPermission = z.infer<typeof ManifestPermissionSchema>;

/**
 * A pinned semantic-ish version. We require an exact pinned version string
 * (D-16.7 "pinned"); ranges (`^`, `~`, `*`, `x`, `latest`) are rejected so an
 * install can never float to an unreviewed artifact.
 */
const PinnedVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, {
    message: 'version must be an exact pinned semver (no ranges)',
  });

/** A lowercase sha-256 hex integrity digest, when the publisher provides one. */
const IntegritySchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, {
    message: 'integrity must be `sha256:<64 hex>`',
  });

/**
 * `PluginManifest@1`. Every field the supply-chain gate needs to reason about
 * is declared here so the gate never guesses. `integrity`/`signature` are
 * optional because not every ecosystem provides them, but the gate treats a
 * missing signature as an ambiguity to be classified, not ignored.
 */
export const PluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  kind: z.enum(MANIFEST_KINDS),
  /** Package identity, e.g. `@scope/name` or `name`. */
  name: z.string().min(1).max(256),
  /** Exact pinned version (no range). */
  version: PinnedVersionSchema,
  /** Publisher/source identity. */
  publisher: z.string().min(1).max(256),
  source: z.string().min(1).max(1024),
  /** Optional integrity digest and detached signature reference. */
  integrity: IntegritySchema.optional(),
  signature: z.string().min(1).max(4096).optional(),
  /** SPDX-ish license identifier. */
  license: z.string().min(1).max(128),
  /** Declared transport + entrypoint. */
  transport: z.enum(MANIFEST_TRANSPORTS),
  entrypoint: z.string().min(1).max(1024),
  /** Declared install scripts (empty array = none). */
  installScripts: z.array(z.string().min(1).max(1024)).max(64),
  /** Declared capabilities and requested permissions. */
  capabilities: z.array(z.string().min(1).max(128)).max(128),
  permissions: z.array(ManifestPermissionSchema).max(128),
  /** Selected sandbox profile the plugin must run under. */
  sandboxProfile: z.enum(SANDBOX_PROFILES),
  /** Declared engine/runtime compatibility range. */
  compatibility: z.strictObject({
    /** Minimum host application version this artifact supports. */
    minHostVersion: PinnedVersionSchema,
    /** Maximum host version, when declared. */
    maxHostVersion: PinnedVersionSchema.optional(),
  }),
  /** Update policy (pinned/manual/none — never silent auto-float). */
  updatePolicy: z.enum(['pinned', 'manual', 'none']),
  /** Whether a rollback (prior verified artifact) is declared available. */
  rollbackAvailable: z.boolean(),
  /** Free-form provenance note (source repo/build). */
  provenance: z.string().min(1).max(2048),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

function manifestError(
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code: 'VALIDATION',
    message,
    owner: MANIFEST_OWNER,
    operation: 'validate-manifest',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Publish a complete versioned manifest with pinned version, ' +
      'declared transport/entrypoint, permissions, sandbox profile, ' +
      'compatibility, update policy, and provenance. A malformed or ' +
      'ambiguous manifest is never partially installed.',
    redaction: 'internal',
  };
}

/**
 * Validate an untrusted manifest object. Returns a typed value on success or a
 * typed `VALIDATION` `ErrorEnvelope` on any schema failure. Deterministic: the
 * same input always yields the same typed outcome with no side effect
 * (NN-INV-011).
 */
export function validatePluginManifest(
  value: unknown,
  correlationId?: string,
): ContractValidation<PluginManifest> {
  const parsed = PluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '(root)';
    const detail = first?.message ?? 'invalid manifest';
    return {
      ok: false,
      error: manifestError(`manifest field \`${where}\`: ${detail}`, correlationId),
    };
  }
  return { ok: true, value: parsed.data };
}
