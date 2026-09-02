/**
 * Voice status + managed-manifest integrity behavior for the experience surface
 * (FUT-PKG-07-EXPERIENCE/T-006).
 *
 * NN-UI-009 requires voice input/output to "show listening/download/model
 * status … and never report unavailable models as ready." NN-UI-010 pins the
 * managed-manifest contract exactly: production downloads resolve exactly
 * `text_encoder.onnx`, `vector_estimator.onnx`, and `vocoder.onnx`; the manifest
 * shape is `{ version, files: { filename: { url, size?, sha256? } } }`; and
 * "whenever [sha256] is present for the effective artifact, SHA-256 verification
 * of the completed temporary file is mandatory before atomic rename, and a
 * malformed digest, read error, or mismatch SHALL fail visibly, block promotion,
 * remove/quarantine the temporary file, and preserve any prior verified file."
 *
 * This module owns the render-ready VIEW derivation (voice status) and the PURE
 * promotion decision (integrity verify → promote/refuse). It builds on the exact
 * required-file set and manifest shape the voice model downloader already
 * declares (src/voice/model-downloader.ts); it does not re-implement the
 * download transport. The promotion decision is pure so it can be verified over
 * generated digests without touching the network (NN-UI-010, NN-COMPAT-012).
 *
 * Design anchors: D-05, D-17, D-20. Requirements: NN-UI-009, NN-UI-010,
 * NN-COMPAT-012.
 */

/**
 * The exact production voice-model artifacts (NN-UI-010). Downloads MUST resolve
 * exactly these three filenames from the managed manifest; the set is frozen so
 * a surface can never silently add/drop an artifact.
 */
export const REQUIRED_VOICE_MODEL_FILES = Object.freeze([
  'text_encoder.onnx',
  'vector_estimator.onnx',
  'vocoder.onnx',
] as const);

export type VoiceModelFile = (typeof REQUIRED_VOICE_MODEL_FILES)[number];

/** A lowercase SHA-256 hex digest is 64 hex chars. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ─── Voice status view (NN-UI-009) ───────────────────────────────────────────

/** The listening state of the capture pipeline (NN-UI-009). */
export type VoiceListeningState =
  | 'idle'
  | 'push-to-talk'
  | 'wake-word'
  | 'listening'
  | 'released';

/** The state of a model download (NN-UI-009). */
export type VoiceDownloadState =
  | 'not-started'
  | 'downloading'
  | 'verifying'
  | 'complete'
  | 'error';

/**
 * The readiness of the voice models. `ready` means every required artifact is
 * present AND verified; anything else is NOT ready — an unavailable model is
 * NEVER reported as ready (NN-UI-009).
 */
export type VoiceModelReadiness = 'ready' | 'incomplete' | 'unverified' | 'unavailable';

/** A render-ready voice status view (NN-UI-009). */
export interface VoiceStatusView {
  readonly listening: VoiceListeningState;
  readonly download: VoiceDownloadState;
  readonly readiness: VoiceModelReadiness;
  /** Whether the surface may present voice output as usable now. */
  readonly ready: boolean;
  /** The required artifacts that are present AND verified. */
  readonly verifiedFiles: readonly string[];
  /** The required artifacts still missing/unverified. */
  readonly missingFiles: readonly string[];
}

/**
 * Per-artifact local state used to derive readiness: whether the file is present
 * on disk and whether it has been integrity-verified (SHA-256 matched, or the
 * manifest declared no digest and the file downloaded intact).
 */
export interface VoiceArtifactState {
  readonly present: boolean;
  readonly verified: boolean;
}

/**
 * Derive the voice status view. Readiness is computed over the EXACT required
 * artifact set: `ready` only when every required file is present AND verified.
 * A file that is present but unverified yields `unverified` (NOT ready); a
 * missing file yields `incomplete`/`unavailable` (NOT ready). An unavailable
 * model is never reported as ready (NN-UI-009).
 */
export function deriveVoiceStatus(input: {
  readonly listening: VoiceListeningState;
  readonly download: VoiceDownloadState;
  readonly artifacts: Readonly<Record<string, VoiceArtifactState>>;
}): VoiceStatusView {
  const verifiedFiles: string[] = [];
  const missingFiles: string[] = [];
  let anyPresent = false;
  let anyUnverified = false;

  for (const file of REQUIRED_VOICE_MODEL_FILES) {
    const state = input.artifacts[file] ?? { present: false, verified: false };
    if (state.present) anyPresent = true;
    if (state.present && state.verified) {
      verifiedFiles.push(file);
    } else {
      missingFiles.push(file);
      if (state.present && !state.verified) anyUnverified = true;
    }
  }

  let readiness: VoiceModelReadiness;
  if (verifiedFiles.length === REQUIRED_VOICE_MODEL_FILES.length) {
    readiness = 'ready';
  } else if (anyUnverified) {
    readiness = 'unverified';
  } else if (anyPresent) {
    readiness = 'incomplete';
  } else {
    readiness = 'unavailable';
  }

  return {
    listening: input.listening,
    download: input.download,
    readiness,
    ready: readiness === 'ready',
    verifiedFiles,
    missingFiles,
  };
}

// ─── Managed-manifest integrity + promotion (NN-UI-010, NN-COMPAT-012) ───────

/** A single artifact entry in the managed manifest (NN-UI-010 exact shape). */
export interface ManagedManifestFile {
  readonly url: string;
  readonly size?: number;
  readonly sha256?: string;
}

/**
 * The managed voice-model manifest. Additive and exact at the top level:
 * `{ version, files: { filename: { url, size?, sha256? } } }` (NN-UI-010).
 */
export interface ManagedVoiceManifest {
  readonly version: string;
  readonly files: Readonly<Record<string, ManagedManifestFile>>;
}

/**
 * Whether a manifest is well-formed AND resolves every EXACT required artifact
 * with a non-empty URL. A manifest that omits a required file (or has an empty
 * URL) is rejected — a partial manifest can never satisfy a production download
 * (NN-UI-010).
 */
export function manifestResolvesRequiredFiles(manifest: ManagedVoiceManifest): boolean {
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) return false;
  for (const file of REQUIRED_VOICE_MODEL_FILES) {
    const entry = manifest.files[file];
    if (!entry || typeof entry.url !== 'string' || entry.url.length === 0) return false;
  }
  return true;
}

/**
 * Why a completed download's promotion was refused. Every reason blocks the
 * atomic rename, quarantines the temporary file, and preserves any prior
 * verified file (NN-UI-010):
 *   - `malformed-digest`  — the manifest's declared sha256 is not a valid
 *                           lowercase 64-hex digest.
 *   - `read-error`        — the completed temporary file could not be hashed.
 *   - `digest-mismatch`   — the computed digest does not equal the declared one.
 */
export type VoicePromotionRefusal = 'malformed-digest' | 'read-error' | 'digest-mismatch';

/** The outcome of a voice-artifact promotion decision (pure). */
export type VoicePromotionDecision =
  | { readonly promote: true }
  | { readonly promote: false; readonly reason: VoicePromotionRefusal };

/**
 * Decide whether a completed voice-model download may be atomically promoted.
 *
 * Contract (NN-UI-010):
 *   - When the manifest declares NO sha256 for the effective artifact, promotion
 *     proceeds (verification is only mandatory when a digest is present).
 *   - When a sha256 IS declared, SHA-256 verification of the completed temporary
 *     file is MANDATORY before the atomic rename. A malformed declared digest,
 *     a read error while hashing, or a mismatch REFUSES promotion so the caller
 *     removes/quarantines the temporary file and preserves any prior verified
 *     file. An unverified download is NEVER promoted.
 *
 * The decision is PURE: the caller supplies the declared digest and the computed
 * digest (or null on a read error); this function performs no I/O so it can be
 * verified over arbitrary generated digests. A promotion decision of `true` is
 * the ONLY path that authorizes the atomic rename.
 */
export function decideVoicePromotion(input: {
  readonly declaredSha256: string | undefined;
  /** The digest computed over the completed temp file, or null on read error. */
  readonly computedSha256: string | null;
}): VoicePromotionDecision {
  const declared = input.declaredSha256;
  // No declared digest → verification is not mandatory; promote (NN-UI-010).
  if (declared === undefined) return { promote: true };

  // A declared digest MUST be a well-formed lowercase 64-hex sha-256.
  if (typeof declared !== 'string' || !SHA256_HEX.test(declared)) {
    return { promote: false, reason: 'malformed-digest' };
  }
  // A read error while hashing the temp file blocks promotion.
  if (input.computedSha256 === null) {
    return { promote: false, reason: 'read-error' };
  }
  // The computed digest must EXACTLY equal the declared digest.
  if (input.computedSha256 !== declared) {
    return { promote: false, reason: 'digest-mismatch' };
  }
  return { promote: true };
}

/** The state of the voice model store after a promotion attempt (pure). */
export interface VoiceStoreState {
  /** The digest of the currently promoted (verified) file, or null if none. */
  readonly promotedDigest: string | null;
  /** Whether a temporary download file is pending quarantine/removal. */
  readonly tempPending: boolean;
}

/**
 * Apply a promotion decision to the voice store state (pure). On `promote` the
 * new verified digest becomes the promoted file and the temp is consumed; on a
 * refusal the PRIOR promoted digest is preserved unchanged and the temp is
 * marked for quarantine/removal — a corrupt/unverified download never replaces a
 * good file (NN-UI-010).
 */
export function applyVoicePromotion(
  prior: VoiceStoreState,
  decision: VoicePromotionDecision,
  completedDigest: string | null,
): VoiceStoreState {
  if (decision.promote) {
    return { promotedDigest: completedDigest ?? prior.promotedDigest, tempPending: false };
  }
  // Refusal: preserve the prior verified file, quarantine the temp.
  return { promotedDigest: prior.promotedDigest, tempPending: true };
}
