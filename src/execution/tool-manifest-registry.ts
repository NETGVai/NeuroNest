/**
 * Tool Manifest Registry — the single source of truth for which tool paths may
 * execute (FUT-PKG-06-EXECUTION/T-002, NN-EXEC-002/003).
 *
 * D-11 / D-05 require that the ToolExecutionPipeline begin every invocation with
 * a manifest registry lookup. This registry is that authority: a
 * {@link ToolManifest} (`ToolManifest@1`) may be admitted only if it is
 * well-formed, has a unique effective identity (name + major version), is not
 * a duplicate under a diverging content digest, is a compatible major version,
 * and is really implemented. It NEVER admits an inert (catalog-only) tool as an
 * executable success path (NN-EXEC-003), and it blocks a duplicate or
 * incompatible manifest (NN-EXEC-002).
 *
 * The registry is deliberately in-memory and descriptive: it performs no I/O,
 * spawns nothing, and resolves no secrets. It is the pipeline's first gate —
 * a tool the registry does not admit can never reach any later D-11 stage,
 * which is one half of the no-bypass guarantee (the other half is that the
 * pipeline is the only path to execution).
 *
 * Design anchors: D-05 (registry lookup as stage 1), D-07 (`ToolManifest@1`),
 * D-11 (governed sequence). Requirements: NN-EXEC-002 (manifests / duplicate /
 * incompatible), NN-EXEC-003 (no inert tools), NN-INV-001 (deny by default),
 * NN-INV-011 (typed failure).
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import {
  ToolManifestSchema,
  computeManifestDigest,
  manifestIdentity,
  type ToolManifest,
} from './tool-types';

const REGISTRY_OWNER = 'authority-tool-execution';

/** A typed registry outcome: an admitted manifest or a typed denial. */
export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function registryError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: REGISTRY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction: 'internal',
  };
}

/** Input to {@link ToolManifestRegistry.register}: a manifest sans digest. */
export type ManifestInput = Omit<ToolManifest, 'contentDigest'>;

/**
 * The in-memory tool manifest registry. Solely owns admission state; the
 * pipeline queries it and never bypasses it.
 */
export class ToolManifestRegistry {
  private readonly manifests = new Map<string, ToolManifest>();

  /**
   * Register (admit) a tool manifest. The identity key is `name@majorVersion`.
   * Admission rules (all fail closed with a typed error and NO mutation):
   *
   *   - the manifest must pass schema validation (`VALIDATION`);
   *   - it must be really implemented — an inert manifest is refused
   *     (`UNAVAILABLE`, NN-EXEC-003);
   *   - re-registering the SAME identity with a DIFFERENT content digest is a
   *     duplicate/ambiguous manifest and is rejected (`CONFLICT`, NN-EXEC-002);
   *     re-registering the identical content is an idempotent no-op replay.
   *
   * The registry computes and stamps the `contentDigest` so a caller cannot
   * forge it.
   */
  register(
    input: ManifestInput,
    correlationId?: string,
  ): RegistryResult<ToolManifest> {
    const contentDigest = computeManifestDigest(input);
    const candidate: ToolManifest = { ...input, contentDigest };

    const parsed = ToolManifestSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        error: registryError(
          'VALIDATION',
          'tool manifest failed schema validation',
          'registry.register',
          correlationId,
        ),
      };
    }
    const manifest = parsed.data;

    if (!manifest.implemented) {
      // NN-EXEC-003: an advertised-but-inert tool stays catalog metadata; it is
      // never admitted as an executable success path.
      return {
        ok: false,
        error: registryError(
          'UNAVAILABLE',
          `tool '${manifest.name}' is not implemented; catalog-only, not executable`,
          'registry.register',
          correlationId,
        ),
      };
    }

    const identity = manifestIdentity(manifest.name, manifest.manifestVersion);
    const existing = this.manifests.get(identity);
    if (existing) {
      if (existing.contentDigest === manifest.contentDigest) {
        // Idempotent re-registration of identical content.
        return { ok: true, value: existing };
      }
      // NN-EXEC-002: same identity, diverging content — ambiguous duplicate.
      return {
        ok: false,
        error: registryError(
          'CONFLICT',
          `duplicate tool manifest '${identity}' with a diverging content digest`,
          'registry.register',
          correlationId,
        ),
      };
    }

    this.manifests.set(identity, manifest);
    return { ok: true, value: manifest };
  }

  /**
   * Look up an admitted manifest for a `name`/`manifestVersion`. Returns a
   * typed `UNAVAILABLE` when the tool is unknown (never a silent undefined that
   * a caller might treat as permission — NN-INV-001) or `INCOMPATIBLE` when the
   * caller requested a major version the registry does not hold.
   */
  lookup(
    name: string,
    manifestVersion: number,
    correlationId?: string,
  ): RegistryResult<ToolManifest> {
    const identity = manifestIdentity(name, manifestVersion);
    const manifest = this.manifests.get(identity);
    if (manifest) {
      return { ok: true, value: manifest };
    }
    // Distinguish "unknown tool" from "known tool, wrong major version".
    const anyVersion = [...this.manifests.values()].some((m) => m.name === name);
    if (anyVersion) {
      return {
        ok: false,
        error: registryError(
          'INCOMPATIBLE',
          `tool '${name}' has no admitted manifest at major version ${manifestVersion}`,
          'registry.lookup',
          correlationId,
        ),
      };
    }
    return {
      ok: false,
      error: registryError(
        'UNAVAILABLE',
        `no admitted manifest for tool '${name}'`,
        'registry.lookup',
        correlationId,
      ),
    };
  }

  /** Whether a manifest identity is admitted. */
  has(name: string, manifestVersion: number): boolean {
    return this.manifests.has(manifestIdentity(name, manifestVersion));
  }

  /** Snapshot every admitted manifest, sorted by identity for determinism. */
  snapshot(): readonly ToolManifest[] {
    return Object.freeze(
      [...this.manifests.values()].sort((a, b) =>
        manifestIdentity(a.name, a.manifestVersion) <
        manifestIdentity(b.name, b.manifestVersion)
          ? -1
          : 1,
      ),
    );
  }

  /** Number of admitted manifests. */
  get size(): number {
    return this.manifests.size;
  }
}
