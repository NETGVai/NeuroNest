/**
 * Legacy checkpoint artifact wrapper (FUT-PKG-05-RECOVERY/T-003).
 *
 * File-delta, private Git-ref, and full-workspace-snapshot artifacts may exist
 * under legacy records/paths (M017/M051/runtime sources, CD-003). The migration
 * for the Checkpoint backends stream (D-20) is:
 *
 *     inventory  ->  verify  ->  wrap (as a verified read adapter)  ->  switch
 *                                new writes to CheckpointService
 *
 * with the CRITICAL constraint that legacy artifacts are WRAPPED, NOT removed
 * (removal is P9): a verified legacy artifact becomes a `Checkpoint@1` record
 * (source `migration`) whose one immutable artifact is a content-addressed copy
 * in the canonical store, and the original source is PRESERVED. An unverified or
 * orphan legacy item is QUARANTINED (blocks activation) with its source
 * preserved and readable only through the diagnostic recovery reader. Rollback
 * restores the prior read adapter, never raw untracked authority.
 *
 * This module is the read/verify/wrap adapter — it never authors records
 * itself; it hands each verified inventory item to the CheckpointService (the
 * sole writer, NN-INV-008) via {@link CheckpointService.wrapLegacyArtifact}.
 *
 * A legacy artifact is modeled as a directory containing:
 *   - `files/<relpath>` — the captured file bytes for each covered path;
 *   - optional `absent.json` — an array of relpaths that were absent at capture
 *     (new files, prior-existence = false);
 *   - optional `meta.json` — { description?, createdBy?, createdAt?, baseRef?,
 *     backendType? } describing the legacy capture.
 *
 * The wrapper re-hashes every legacy file into the canonical content-addressed
 * store, builds the hashed prior-existence manifest, and verifies the resulting
 * artifact BEFORE wrapping. A legacy directory whose declared hash sidecar (if
 * present) does not match the actual bytes is treated as unverified and
 * quarantined (NN-DATA-011 preserve-source, NN-CHECKPOINT-002).
 *
 * Design anchors: D-20 (Checkpoint backends migration row), CD-003, D-08
 * (integrity), D-07. Requirements: NN-CHECKPOINT-001/002, NN-DATA-005/007/010/
 * 011, NN-COMPAT-001/002, NN-INV-002/008.
 */

import fs from 'node:fs';
import path from 'node:path';

import { computeDigest, makeOpaqueId, type ScopeDescriptor } from '../shared/contract-primitives.js';
import {
  buildManifest,
  computeArtifactDigest,
  sha256,
  writeArtifact,
} from './backends/index.js';
import type {
  CaptureTarget,
  CheckpointBackendType,
  CheckpointManifestEntry,
} from './checkpoint-types.js';
import type { CheckpointMutationResult, CheckpointService } from './checkpoint-service.js';

/** One inventoried legacy artifact discovered under a legacy root. */
export interface LegacyInventoryItem {
  /** The legacy artifact directory (absolute). */
  readonly sourcePath: string;
  /** A stable id derived from the source path. */
  readonly legacyId: string;
  /** The legacy backend type, if declared; defaults to file-delta. */
  readonly backendType: CheckpointBackendType;
  /** The covered relative paths (files present + absent markers). */
  readonly coveredPaths: readonly string[];
  readonly description: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly baseRef?: string;
  /** A declared integrity digest sidecar, if the legacy format carried one. */
  readonly declaredDigest?: string;
}

/** The outcome of wrapping one legacy artifact. */
export interface WrapOutcome {
  readonly legacyId: string;
  readonly sourcePath: string;
  readonly verified: boolean;
  /** The wrapped record id (present whether active or quarantined). */
  readonly checkpointId: string;
  readonly state: 'active' | 'quarantined';
}

/** The result of a full inventory -> verify -> wrap pass over a legacy root. */
export interface LegacyMigrationResult {
  readonly wrapped: readonly WrapOutcome[];
  /** Legacy items that could not be inventoried at all (skipped, source kept). */
  readonly skippedSourcePaths: readonly string[];
}

/**
 * The legacy-artifact wrapper. Inventories a legacy root, re-hashes each legacy
 * artifact into the canonical content-addressed store, verifies it, and wraps it
 * through the CheckpointService (the sole writer). Never removes a source.
 */
export class LegacyArtifactWrapper {
  constructor(private readonly service: CheckpointService) {}

  /**
   * Inventory every legacy artifact directory directly under `legacyRoot`. A
   * legacy artifact is a subdirectory containing a `files/` directory. Reads
   * optional `meta.json`/`absent.json`/`digest` sidecars. Never mutates the
   * source (NN-DATA-011).
   */
  inventory(legacyRoot: string): LegacyInventoryItem[] {
    if (!fs.existsSync(legacyRoot)) return [];
    const items: LegacyInventoryItem[] = [];
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(legacyRoot, entry.name);
      const filesDir = path.join(sourcePath, 'files');
      if (!fs.existsSync(filesDir)) continue;

      const present = this.walkRelative(filesDir);
      const absent = this.readAbsent(sourcePath);
      const meta = this.readMeta(sourcePath);
      const declaredDigestPath = path.join(sourcePath, 'digest');
      const declaredDigest = fs.existsSync(declaredDigestPath)
        ? fs.readFileSync(declaredDigestPath, 'utf8').trim()
        : undefined;

      items.push({
        sourcePath,
        legacyId: makeOpaqueId('lgcy', `${entry.name}${sourcePath}`),
        backendType: meta.backendType ?? 'file-delta',
        coveredPaths: [...present, ...absent],
        description: meta.description ?? `wrapped legacy checkpoint ${entry.name}`,
        createdBy: meta.createdBy ?? 'legacy-migration',
        createdAt: meta.createdAt ?? new Date(0).toISOString(),
        ...(meta.baseRef !== undefined ? { baseRef: meta.baseRef } : {}),
        ...(declaredDigest !== undefined ? { declaredDigest } : {}),
      });
    }
    return items;
  }

  /**
   * Verify AND wrap one legacy artifact: re-hash its files into the canonical
   * content-addressed store, build the hashed prior-existence manifest, verify
   * the resulting artifact, and hand it to the CheckpointService. A verified
   * item becomes `active` (source `migration`); an unverified item (declared
   * digest mismatch, unreadable bytes, or artifact verify failure) is
   * `quarantined` — activation is blocked and the source is preserved. Never
   * removes the source.
   */
  wrap(input: {
    readonly item: LegacyInventoryItem;
    readonly scope: ScopeDescriptor;
    readonly projectId: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): WrapOutcome {
    const { item } = input;
    const filesDir = path.join(item.sourcePath, 'files');

    // Re-hash the legacy files into capture targets (present + absent markers).
    const targets: CaptureTarget[] = [];
    const absentSet = new Set(this.readAbsent(item.sourcePath));
    let readable = true;
    for (const rel of item.coveredPaths) {
      if (absentSet.has(rel)) {
        targets.push({ pathRef: rel, existedBefore: false, priorContent: null, priorSha256: null, mode: null });
        continue;
      }
      const abs = path.join(filesDir, rel.split('/').join(path.sep));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        readable = false;
        continue;
      }
      const bytes = fs.readFileSync(abs);
      targets.push({
        pathRef: rel,
        existedBefore: true,
        priorContent: bytes,
        priorSha256: sha256(bytes),
        mode: fs.statSync(abs).mode,
      });
    }

    const manifest: CheckpointManifestEntry[] = buildManifest(targets);
    const anchor = item.baseRef !== undefined ? { baseRef: item.baseRef } : undefined;
    const artifactDigest = computeArtifactDigest({
      backendType: item.backendType,
      backendVersion: 1,
      manifest,
      ...(anchor ? { anchor } : {}),
    });

    // A declared legacy digest that does not match the re-hashed content marks
    // the item unverified (tampered/corrupt source) — quarantine, preserve.
    const declaredMatches =
      item.declaredDigest === undefined ||
      item.declaredDigest === artifactDigest ||
      item.declaredDigest === this.legacyContentDigest(manifest);

    let verified = readable && declaredMatches;

    // Materialize the artifact into the canonical store, then verify it.
    let artifactRef = makeOpaqueId('ckpt', `${item.backendType}${artifactDigest}`);
    if (readable) {
      const written = writeArtifact({
        artifactRoot: this.service.artifactRootPath,
        backendType: item.backendType,
        backendVersion: 1,
        rootPath: item.sourcePath,
        targets,
        manifest,
        artifactDigest,
        ...(anchor ? { anchor } : {}),
      });
      artifactRef = written.artifactRef;
      const backend = this.service.backendFor(item.backendType);
      const artifactVerified =
        backend?.verify({
          artifactPath: written.artifactPath,
          manifest,
          artifactDigest,
        }) ?? false;
      verified = verified && artifactVerified;
    }

    const wrapped: CheckpointMutationResult = this.service.wrapLegacyArtifact({
      commandId: makeOpaqueId('cmd', `wrap${item.legacyId}`),
      idempotencyKey: `wrap-legacy:${item.legacyId}`,
      correlationId: input.correlationId,
      scope: input.scope,
      projectId: input.projectId,
      backendType: item.backendType,
      backendVersion: 1,
      artifactRef,
      artifactDigest,
      manifest,
      description: item.description,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      verified,
      ...(item.baseRef !== undefined ? { baseRef: item.baseRef } : {}),
      ...(input.now ? { now: input.now } : {}),
    });

    return {
      legacyId: item.legacyId,
      sourcePath: item.sourcePath,
      verified,
      checkpointId: wrapped.record.checkpointId,
      state: wrapped.record.state === 'active' ? 'active' : 'quarantined',
    };
  }

  /**
   * Run the full inventory -> verify -> wrap migration over a legacy root. The
   * new writer is the CheckpointService; the wrapped legacy artifacts remain
   * read adapters and their sources are preserved (NN-COMPAT-001/002).
   */
  migrate(input: {
    readonly legacyRoot: string;
    readonly scope: ScopeDescriptor;
    readonly projectId: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): LegacyMigrationResult {
    const items = this.inventory(input.legacyRoot);
    const wrapped: WrapOutcome[] = [];
    const skipped: string[] = [];
    for (const item of items) {
      try {
        wrapped.push(
          this.wrap({
            item,
            scope: input.scope,
            projectId: input.projectId,
            correlationId: input.correlationId,
            ...(input.now ? { now: input.now } : {}),
          }),
        );
      } catch {
        // Never remove or corrupt a source we could not process; skip it.
        skipped.push(item.sourcePath);
      }
    }
    return { wrapped, skippedSourcePaths: skipped };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private walkRelative(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    };
    walk(root);
    return out.sort();
  }

  private readAbsent(sourcePath: string): string[] {
    const absentPath = path.join(sourcePath, 'absent.json');
    if (!fs.existsSync(absentPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(absentPath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  private readMeta(sourcePath: string): {
    description?: string;
    createdBy?: string;
    createdAt?: string;
    baseRef?: string;
    backendType?: CheckpointBackendType;
  } {
    const metaPath = path.join(sourcePath, 'meta.json');
    if (!fs.existsSync(metaPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ReturnType<LegacyArtifactWrapper['readMeta']>;
    } catch {
      return {};
    }
  }

  /** A legacy-format content digest (over captured hashes) for older sidecars. */
  private legacyContentDigest(manifest: readonly CheckpointManifestEntry[]): string {
    return computeDigest(manifest.map((m) => ({ pathRef: m.pathRef, capturedSha256: m.capturedSha256 })));
  }
}
