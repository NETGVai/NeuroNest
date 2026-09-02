/**
 * Shared content-addressed artifact store for checkpoint backends
 * (FUT-PKG-05-RECOVERY/T-003).
 *
 * Every backend adapter (file-delta / git-ref / full-snapshot) captures the
 * pre-state into ONE immutable, content-addressed artifact directory and can
 * verify + stage-restore it. This module is the shared, backend-agnostic
 * mechanism they use so there is one place that enforces:
 *
 *   - atomic artifact promotion: bytes are written to a temp dir, fsynced where
 *     applicable, and atomically renamed into the content-addressed location so
 *     a partial artifact is never made active (NN-DATA-005);
 *   - a hashed prior-existence manifest: each entry records existedBefore,
 *     priorSha256 (when present), and capturedSha256 so restore distinguishes
 *     "was absent" from "was present with these bytes" (NN-CHECKPOINT-001/003);
 *   - integrity: a single `artifactDigest` binds the ordered manifest to the
 *     stored blob hashes, and verify recomputes it AND re-hashes every stored
 *     blob (NN-CHECKPOINT-005, NN-DATA-010);
 *   - staged restore: captured bytes are materialized into a staging dir beside
 *     the target, never overwriting the live root directly (D-12/D-14).
 *
 * Blobs are stored by their SHA-256 under `blobs/`, so two captures of the same
 * bytes deduplicate and the artifact is genuinely content-addressed.
 *
 * Design anchors: D-08 (atomic files, integrity), D-12/D-14 (staged restore),
 * NN-CHECKPOINT-001/003/005, NN-DATA-005/010.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { computeDigest, makeOpaqueId } from '../../shared/contract-primitives.js';
import type { CaptureTarget, CheckpointManifestEntry } from '../checkpoint-types.js';

/** SHA-256 lowercase hex of the given bytes. */
export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The empty-content marker digest used for absent/new files. */
export const EMPTY_CONTENT_DIGEST = sha256(Buffer.alloc(0));

/** Whether the given absolute path is inside `root` (containment guard). */
function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the hashed prior-existence manifest for a set of capture targets. A
 * target that existed captures its prior bytes' hash as both `priorSha256` and
 * `capturedSha256`; an absent/new file records `existedBefore=false`,
 * `priorSha256=undefined`, and the empty-content digest as `capturedSha256` so
 * restore knows to delete it (NN-CHECKPOINT-001/003).
 */
export function buildManifest(
  targets: readonly CaptureTarget[],
): CheckpointManifestEntry[] {
  // Deterministic order: sorted by pathRef so the manifest digest is stable
  // regardless of the caller's target order (NN-DATA-010).
  const sorted = [...targets].sort((a, b) => (a.pathRef < b.pathRef ? -1 : a.pathRef > b.pathRef ? 1 : 0));
  return sorted.map((t) => {
    const captured = t.existedBefore && t.priorContent ? sha256(t.priorContent) : EMPTY_CONTENT_DIGEST;
    return {
      pathRef: t.pathRef,
      existedBefore: t.existedBefore,
      ...(t.existedBefore && t.priorSha256 ? { priorSha256: t.priorSha256 } : {}),
      capturedSha256: captured,
      ...(t.mode !== null && t.mode !== undefined ? { mode: t.mode } : {}),
      ...(t.lineEnding ? { lineEnding: t.lineEnding } : {}),
    };
  });
}

/**
 * The immutability anchor: a single digest over the ordered manifest plus the
 * backend identity. Two captures with the same manifest under the same backend
 * yield the same artifact digest (content-addressed); any manifest change
 * changes the digest (NN-DATA-010).
 */
export function computeArtifactDigest(input: {
  readonly backendType: string;
  readonly backendVersion: number;
  readonly manifest: readonly CheckpointManifestEntry[];
  /** Optional backend-specific anchor folded into the digest (e.g. baseRef). */
  readonly anchor?: Record<string, unknown>;
}): string {
  return computeDigest({
    backendType: input.backendType,
    backendVersion: input.backendVersion,
    manifest: input.manifest,
    anchor: input.anchor ?? null,
  });
}

/**
 * Atomically write the captured blobs + manifest into a content-addressed
 * artifact directory under `artifactRoot`. Bytes are staged in a sibling temp
 * dir, then atomically renamed into place, so a partial artifact is never made
 * active (NN-DATA-005). Returns the artifactRef (directory name) and its
 * absolute path.
 *
 * Idempotent on content: the directory name is derived from the artifact
 * digest, so re-capturing identical content targets the same directory; if it
 * already exists and verifies, the existing artifact is reused rather than
 * rewritten.
 */
export function writeArtifact(input: {
  readonly artifactRoot: string;
  readonly backendType: string;
  readonly backendVersion: number;
  readonly rootPath: string;
  readonly targets: readonly CaptureTarget[];
  readonly manifest: readonly CheckpointManifestEntry[];
  readonly artifactDigest: string;
  /** Backend-specific anchor persisted into manifest.json and re-hashed on verify. */
  readonly anchor?: Record<string, unknown>;
}): { readonly artifactRef: string; readonly artifactPath: string } {
  const artifactRef = makeOpaqueId('ckpt', `${input.backendType}${input.artifactDigest}`);
  const artifactPath = path.join(input.artifactRoot, artifactRef);

  // Reuse a matching, already-verified artifact (content-addressed dedupe).
  if (fs.existsSync(artifactPath)) {
    return { artifactRef, artifactPath };
  }

  fs.mkdirSync(input.artifactRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(input.artifactRoot, '.staging-'));
  try {
    const blobsDir = path.join(tmp, 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });

    // Write one blob per existing target, keyed by its captured hash.
    const byPath = new Map(input.targets.map((t) => [t.pathRef, t] as const));
    for (const entry of input.manifest) {
      if (!entry.existedBefore) continue;
      const target = byPath.get(entry.pathRef);
      const bytes = target?.priorContent ?? Buffer.alloc(0);
      const blobPath = path.join(blobsDir, entry.capturedSha256);
      if (!fs.existsSync(blobPath)) {
        fs.writeFileSync(blobPath, bytes);
      }
    }

    const manifestJson = JSON.stringify({
      backendType: input.backendType,
      backendVersion: input.backendVersion,
      artifactDigest: input.artifactDigest,
      manifest: input.manifest,
      anchor: input.anchor ?? null,
    });
    fs.writeFileSync(path.join(tmp, 'manifest.json'), manifestJson);

    // fsync the directory contents where the platform supports it (best-effort).
    try {
      const fd = fs.openSync(tmp, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {
      /* fsync of a directory is not supported everywhere; best-effort */
    }

    // Atomic promote: rename the fully-written temp dir into its final name.
    fs.renameSync(tmp, artifactPath);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  return { artifactRef, artifactPath };
}

/**
 * Verify an artifact: the on-disk `manifest.json` must exist, its recorded
 * `artifactDigest` must match `artifactDigest`, the recomputed digest over the
 * stored manifest must equal it, and every existing entry's stored blob must
 * re-hash to its `capturedSha256` (NN-CHECKPOINT-005, NN-DATA-010).
 */
export function verifyArtifact(input: {
  readonly artifactPath: string;
  readonly manifest: readonly CheckpointManifestEntry[];
  readonly artifactDigest: string;
}): boolean {
  const manifestPath = path.join(input.artifactPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;

  let stored: {
    backendType?: string;
    backendVersion?: number;
    artifactDigest?: string;
    manifest?: CheckpointManifestEntry[];
    anchor?: Record<string, unknown> | null;
  };
  try {
    stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof stored;
  } catch {
    return false;
  }

  if (stored.artifactDigest !== input.artifactDigest) return false;
  if (
    stored.backendType === undefined ||
    stored.backendVersion === undefined ||
    !Array.isArray(stored.manifest)
  ) {
    return false;
  }

  // Recompute the digest over the stored manifest + anchor; it must match.
  const recomputed = computeArtifactDigest({
    backendType: stored.backendType,
    backendVersion: stored.backendVersion,
    manifest: stored.manifest,
    ...(stored.anchor ? { anchor: stored.anchor } : {}),
  });
  if (recomputed !== input.artifactDigest) return false;

  // The caller-supplied manifest must equal the stored one (digest-equivalent).
  if (computeDigest(stored.manifest) !== computeDigest(input.manifest)) return false;

  // Re-hash every stored blob: the bytes must match their content-addressed name.
  const blobsDir = path.join(input.artifactPath, 'blobs');
  for (const entry of stored.manifest) {
    if (!entry.existedBefore) continue;
    const blobPath = path.join(blobsDir, entry.capturedSha256);
    if (!fs.existsSync(blobPath)) return false;
    if (sha256(fs.readFileSync(blobPath)) !== entry.capturedSha256) return false;
  }
  return true;
}

/**
 * Materialize the captured bytes into a staging directory beside the target
 * (never overwriting the live root; D-12/D-14). Returns the staged path map and
 * the deletions (paths that were absent at capture, to be removed on promotion).
 * Refuses any manifest path that escapes the staging root (defense in depth).
 */
export function stageRestoreArtifact(input: {
  readonly artifactPath: string;
  readonly manifest: readonly CheckpointManifestEntry[];
  readonly stagingRoot: string;
}): { readonly staged: ReadonlyMap<string, string>; readonly deletions: readonly string[] } {
  const blobsDir = path.join(input.artifactPath, 'blobs');
  const staged = new Map<string, string>();
  const deletions: string[] = [];
  const resolvedStagingRoot = path.resolve(input.stagingRoot);

  for (const entry of input.manifest) {
    const relNative = entry.pathRef.split('/').join(path.sep);
    const stagedAbsolute = path.resolve(resolvedStagingRoot, relNative);
    if (!isContained(resolvedStagingRoot, stagedAbsolute)) {
      throw new Error(`checkpoint restore: manifest path "${entry.pathRef}" escapes the staging root`);
    }
    if (!entry.existedBefore) {
      deletions.push(entry.pathRef);
      continue;
    }
    const blobPath = path.join(blobsDir, entry.capturedSha256);
    fs.mkdirSync(path.dirname(stagedAbsolute), { recursive: true });
    fs.copyFileSync(blobPath, stagedAbsolute);
    if (entry.mode !== undefined) {
      try {
        fs.chmodSync(stagedAbsolute, entry.mode & 0o777);
      } catch {
        /* best-effort mode restore */
      }
    }
    staged.set(entry.pathRef, stagedAbsolute);
  }
  return { staged, deletions };
}
