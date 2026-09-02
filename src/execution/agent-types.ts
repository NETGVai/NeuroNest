/**
 * Agent contracts — `AgentManifest@1`, least-privilege profiles/custom modes,
 * exact imported-quality scoring, and capability-checked model routes
 * (FUT-PKG-06-EXECUTION/T-004).
 *
 * D-04 names `AgentRegistry` as the sole write authority for the Agent catalog
 * (canonical identity `agentId`, `manifest version/hash`, `registry
 * revision`); the selector, dashboard, and orchestrator view are read models.
 * D-07 pins `AgentManifest@1`:
 *
 *   `{schemaVersion, agentId, manifestVersion, name, role, departmentId,
 *     specialty?, promptRef, promptFingerprint, skillIds[], modelRouteRef?,
 *     toolPolicyRef, capabilities[], compatibility, provenance, status,
 *     contentDigest}`
 *
 * with the invariant that "duplicate effective IDs, names, aliases,
 * incompatible ranges, or digest ambiguity quarantine the manifest."
 *
 * This module owns the versioned contract, the deterministic profile/custom
 * mode layering (NN-AGENT-005), the exact six-section import quality scorer
 * (NN-AGENT-006), and the capability-checked route decision (NN-AGENT-010). It
 * is additive over {@link ../shared/contract-primitives} and reuses its
 * canonical serializer, `computeDigest`, opaque IDs, revisions, and redaction
 * ladder; and over {@link ../shared/capability-registry} for the route
 * capability check.
 *
 * Design anchors: D-04, D-05, D-07 (`AgentManifest@1`, `ProviderRoute@1`),
 * D-13, D-19.
 * Requirements: NN-AGENT-005/006/010, NN-IDENT-003, NN-INV-001/005,
 * NN-COMPAT-009.
 */

import { z } from 'zod';

import type { CapabilityRegistry } from '../shared/capability-registry';
import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RedactionClassSchema,
  RevisionSchema,
  TimestampSchema,
  computeDigest,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import {
  ROO_ROLE_IDS,
  isReservedRoleId,
  isWithinCeiling,
  roleCeiling,
  type PermissionSet,
} from './agent-roles';

// ─── Agent status ladder (NN-AGENT-002) ─────────────────────────────────────

/**
 * Agent runtime status (NN-AGENT-002). Retained across selectors and
 * navigation. `active`, `busy`, `offline` are the canonical live states;
 * `quarantined` is the fail-closed state for a manifest that failed validation
 * and can never be offered.
 */
export const AGENT_STATUSES = Object.freeze([
  'active',
  'busy',
  'offline',
  'quarantined',
] as const);
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AgentStatusSchema = z.enum(AGENT_STATUSES);

/** Whether a status means the agent may appear as a live selector member. */
export function isLiveAgentStatus(status: AgentStatus): boolean {
  return status === 'active' || status === 'busy' || status === 'offline';
}

// ─── AgentManifest@1 (D-07, NN-IDENT-003) ───────────────────────────────────

/** The manifest role id — one of the eight Roo role identities. */
export const AgentRoleSchema = z.enum(ROO_ROLE_IDS);

/**
 * Compatibility range for a manifest (D-07 "incompatible ranges … quarantine").
 * A manifest is compatible only when the current app major is within
 * `[minAppMajor, maxAppMajor]`.
 */
export const AgentCompatibilitySchema = z.strictObject({
  minAppMajor: z.number().int().nonnegative().finite(),
  maxAppMajor: z.number().int().nonnegative().finite(),
});
export type AgentCompatibility = z.infer<typeof AgentCompatibilitySchema>;

/** Provenance for a discovered manifest (NN-IDENT-003/006). */
export const AgentProvenanceSchema = z.strictObject({
  /** The discovery source path/ref (never a private absolute path in exports). */
  source: z.string().min(1).max(1024),
  /** The actor/tool that produced the manifest. */
  producer: z.string().min(1).max(256),
  /** The source version/ref. */
  sourceVersion: z.string().min(1).max(256),
  importedAt: TimestampSchema,
});
export type AgentProvenance = z.infer<typeof AgentProvenanceSchema>;

/**
 * `AgentManifest@1` (D-07, NN-IDENT-003). The Agent Registry owns activation
 * state; source manifests retain provenance. Duplicate effective IDs, names,
 * aliases, incompatible ranges, or digest ambiguity quarantine the manifest
 * (enforced by the registry, {@link ./agent-registry}).
 */
export const AgentManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  agentId: OpaqueIdSchema,
  manifestVersion: RevisionSchema,
  /** The stable display name; must be unique among effective agents. */
  name: z.string().min(1).max(256),
  /** Optional aliases; must not collide with any effective id/name/alias. */
  aliases: z.array(z.string().min(1).max(256)).default([]),
  role: AgentRoleSchema,
  departmentId: OpaqueIdSchema,
  specialty: z.string().min(1).max(256).optional(),
  promptRef: OpaqueIdSchema,
  promptFingerprint: DigestSchema,
  skillIds: z.array(OpaqueIdSchema),
  modelRouteRef: OpaqueIdSchema.optional(),
  toolPolicyRef: OpaqueIdSchema,
  /** The capability ids this agent's route requires (checked at routing). */
  capabilities: z.array(z.string().min(1).max(128)),
  compatibility: AgentCompatibilitySchema,
  provenance: AgentProvenanceSchema,
  status: AgentStatusSchema,
  contentDigest: DigestSchema,
  redaction: RedactionClassSchema,
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/**
 * Compute the exact content digest of a manifest's MEANING (not presentation).
 * Two manifests with the same effective identity/config produce the same
 * digest; a differing digest under the same effective id is "digest ambiguity"
 * and quarantines the manifest (D-07). Excludes volatile provenance timestamps
 * and the stored `contentDigest`/`status` fields.
 */
export function computeManifestDigest(input: {
  readonly agentId: string;
  readonly manifestVersion: number;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: string;
  readonly departmentId: string;
  readonly specialty?: string;
  readonly promptRef: string;
  readonly promptFingerprint: string;
  readonly skillIds: readonly string[];
  readonly modelRouteRef?: string;
  readonly toolPolicyRef: string;
  readonly capabilities: readonly string[];
  readonly compatibility: AgentCompatibility;
}): string {
  return computeDigest({
    agentId: input.agentId,
    manifestVersion: input.manifestVersion,
    name: input.name,
    aliases: [...input.aliases].sort(),
    role: input.role,
    departmentId: input.departmentId,
    specialty: input.specialty ?? null,
    promptRef: input.promptRef,
    promptFingerprint: input.promptFingerprint,
    skillIds: [...input.skillIds].sort(),
    modelRouteRef: input.modelRouteRef ?? null,
    toolPolicyRef: input.toolPolicyRef,
    capabilities: [...input.capabilities].sort(),
    compatibility: {
      minAppMajor: input.compatibility.minAppMajor,
      maxAppMajor: input.compatibility.maxAppMajor,
    },
  });
}

/** Whether the manifest's compatibility range admits `appMajor`. */
export function isManifestCompatible(
  manifest: Pick<AgentManifest, 'compatibility'>,
  appMajor: number,
): boolean {
  const { minAppMajor, maxAppMajor } = manifest.compatibility;
  return appMajor >= minAppMajor && appMajor <= maxAppMajor;
}

/**
 * The effective identity tokens a manifest occupies: its id, its name, and each
 * alias, all lower-cased for case-insensitive collision detection. Two
 * manifests with any overlapping token have a duplicate effective identity
 * (NN-IDENT-003) and both are quarantined.
 */
export function effectiveIdentityTokens(
  manifest: Pick<AgentManifest, 'agentId' | 'name' | 'aliases'>,
): string[] {
  return [manifest.agentId, manifest.name, ...manifest.aliases].map((t) =>
    t.toLowerCase(),
  );
}

// ─── Manifest validation (fail-closed, NN-AGENT-001) ────────────────────────

/** A per-manifest validation reason (why a single manifest is malformed). */
export type ManifestDefect =
  | 'schema-invalid'
  | 'digest-mismatch'
  | 'reserved-role-id'
  | 'incompatible-range';

/** The outcome of validating a single (untrusted) manifest value. */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: AgentManifest }
  | { readonly ok: false; readonly defect: ManifestDefect; readonly detail: string };

/**
 * Validate a single untrusted manifest value against the schema, its own
 * content digest, the reserved-id rule, and the compatibility range. This is
 * per-manifest validation; cross-manifest duplicate detection and set-equality
 * live in the registry ({@link ./agent-registry}). Deterministic and
 * side-effect free — the same input always yields the same typed outcome
 * (NN-INV-011).
 *
 * @param appMajor the current app major used for the compatibility check.
 */
export function validateManifest(
  value: unknown,
  appMajor: number,
): ManifestValidation {
  const parsed = AgentManifestSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? first.path.join('.') : '<root>';
    return {
      ok: false,
      defect: 'schema-invalid',
      detail: `${path}: ${first?.message ?? 'invalid'}`,
    };
  }
  const manifest = parsed.data;

  // The agent's role id must not collide with a reserved optimizer/auditor id
  // (NN-AGENT-004). (The role enum already restricts to Roo ids, but a
  // manifest could still name a reserved id in a future variant — fail closed.)
  if (isReservedRoleId(manifest.role)) {
    return {
      ok: false,
      defect: 'reserved-role-id',
      detail: `role ${manifest.role} collides with a reserved identity`,
    };
  }

  // The stored content digest must equal the recomputed digest of its meaning.
  // A mismatch is "digest ambiguity" — quarantine (D-07).
  const expected = computeManifestDigest({
    agentId: manifest.agentId,
    manifestVersion: manifest.manifestVersion,
    name: manifest.name,
    aliases: manifest.aliases,
    role: manifest.role,
    departmentId: manifest.departmentId,
    ...(manifest.specialty !== undefined ? { specialty: manifest.specialty } : {}),
    promptRef: manifest.promptRef,
    promptFingerprint: manifest.promptFingerprint,
    skillIds: manifest.skillIds,
    ...(manifest.modelRouteRef !== undefined
      ? { modelRouteRef: manifest.modelRouteRef }
      : {}),
    toolPolicyRef: manifest.toolPolicyRef,
    capabilities: manifest.capabilities,
    compatibility: manifest.compatibility,
  });
  if (manifest.contentDigest !== expected) {
    return {
      ok: false,
      defect: 'digest-mismatch',
      detail: 'contentDigest does not match the manifest meaning',
    };
  }

  if (manifest.compatibility.minAppMajor > manifest.compatibility.maxAppMajor) {
    return {
      ok: false,
      defect: 'incompatible-range',
      detail: 'compatibility range is inverted',
    };
  }
  if (!isManifestCompatible(manifest, appMajor)) {
    return {
      ok: false,
      defect: 'incompatible-range',
      detail: `app major ${appMajor} outside [${manifest.compatibility.minAppMajor},${manifest.compatibility.maxAppMajor}]`,
    };
  }

  return { ok: true, manifest };
}

// ─── Profiles / custom modes (NN-AGENT-005) ─────────────────────────────────

/**
 * A profile / custom mode: a deterministic layer of role, prompt, model, tool,
 * skill, and policy configuration over a base manifest (NN-AGENT-005). The
 * profile's requested permissions MUST be within the role's ceiling; an invalid
 * or incompatible combination is rejected at selection ({@link resolveProfile}).
 * Effects are reversible: a profile never mutates the base manifest, it derives
 * a new effective permission set.
 */
export const AgentProfileSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  profileId: OpaqueIdSchema,
  /** The base agent this profile layers over. */
  agentId: OpaqueIdSchema,
  /** The role the profile assumes; must equal the manifest role. */
  role: AgentRoleSchema,
  /** Requested permission scopes (clamped/validated against the role ceiling). */
  requested: z.strictObject({
    read: z.boolean(),
    edit: z.boolean(),
    command: z.boolean(),
    mcp: z.boolean(),
    commandAllow: z.array(z.string().min(1).max(128)),
    mcpServers: z.array(OpaqueIdSchema),
  }),
  /** Optional overrides (deterministic, fingerprinted). */
  promptRef: OpaqueIdSchema.optional(),
  modelRouteRef: OpaqueIdSchema.optional(),
  redaction: RedactionClassSchema,
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** The reason a profile/custom mode combination is rejected (NN-AGENT-005). */
export type ProfileRejection =
  | 'role-mismatch'
  | 'exceeds-ceiling'
  | 'schema-invalid';

/** The result of resolving a profile against its base manifest + role ceiling. */
export type ProfileResolution =
  | {
      readonly ok: true;
      /** The effective, least-privilege permission set (subset of ceiling). */
      readonly effective: PermissionSet;
      /** A deterministic fingerprint of the resolved profile. */
      readonly fingerprint: string;
    }
  | {
      readonly ok: false;
      readonly rejection: ProfileRejection;
      readonly detail: string;
      readonly violations?: readonly string[];
    };

/**
 * Resolve a profile deterministically against its base manifest and the role's
 * permission ceiling (NN-AGENT-005). The profile is REJECTED when:
 *
 *   - its role does not equal the manifest's role (`role-mismatch`), or
 *   - its requested permissions exceed the role ceiling (`exceeds-ceiling`) —
 *     a profile can NEVER widen a role (NN-INV-005, V-AGENT-001
 *     role-permission-boundary).
 *
 * On success the effective permission set is exactly the requested set (which
 * is within the ceiling) and a stable fingerprint is returned. The base
 * manifest is never mutated (reversible effects).
 */
export function resolveProfile(
  profile: AgentProfile,
  manifest: Pick<AgentManifest, 'agentId' | 'role'>,
): ProfileResolution {
  if (profile.agentId !== manifest.agentId || profile.role !== manifest.role) {
    return {
      ok: false,
      rejection: 'role-mismatch',
      detail: 'profile role/agent does not match the base manifest',
    };
  }
  const ceiling = roleCeiling(manifest.role);
  const requested: PermissionSet = {
    read: profile.requested.read,
    edit: profile.requested.edit,
    command: profile.requested.command,
    mcp: profile.requested.mcp,
    commandAllow: profile.requested.commandAllow,
    mcpServers: profile.requested.mcpServers,
  };
  if (!isWithinCeiling(requested, ceiling)) {
    return {
      ok: false,
      rejection: 'exceeds-ceiling',
      detail: 'profile requests permissions beyond the role ceiling',
    };
  }
  const fingerprint = computeDigest({
    profileId: profile.profileId,
    agentId: profile.agentId,
    role: profile.role,
    requested: {
      read: requested.read,
      edit: requested.edit,
      command: requested.command,
      mcp: requested.mcp,
      commandAllow: [...requested.commandAllow].sort(),
      mcpServers: [...requested.mcpServers].sort(),
    },
    promptRef: profile.promptRef ?? null,
    modelRouteRef: profile.modelRouteRef ?? null,
  });
  return { ok: true, effective: requested, fingerprint };
}

// ─── Exact imported-quality scoring (NN-AGENT-006) ──────────────────────────

/**
 * The four authoritative scoring sections (NN-AGENT-006). Each is independently
 * scored EXACTLY 25 points; activation requires an earned 100/100 plus
 * authenticity and provenance evidence.
 */
export const QUALITY_SECTIONS = Object.freeze([
  'promptSpecificity',
  'deliverableStructure',
  'workflowCompleteness',
  'domainDepth',
] as const);
export type QualitySection = (typeof QUALITY_SECTIONS)[number];

/** The exact per-section maximum (NN-AGENT-006). */
export const SECTION_MAX = 25 as const;
/** The exact activation threshold (NN-AGENT-006). */
export const QUALITY_PASS_TOTAL = 100 as const;

/**
 * The six sections the authoritative parser extracts from an imported agent
 * (NN-AGENT-006 "authoritative six-section parser"). Four are scored (25 each);
 * `authenticity` and `provenance` are evidence gates that must also hold.
 */
export const IMPORT_SECTIONS = Object.freeze([
  'promptSpecificity',
  'deliverableStructure',
  'workflowCompleteness',
  'domainDepth',
  'authenticity',
  'provenance',
] as const);
export type ImportSection = (typeof IMPORT_SECTIONS)[number];

/** A parsed import: the four section scores plus the two evidence gates. */
export interface ImportedQualityInput {
  readonly promptSpecificity: number;
  readonly deliverableStructure: number;
  readonly workflowCompleteness: number;
  readonly domainDepth: number;
  /** Authenticity evidence present (not a fabricated/plagiarized import). */
  readonly authenticityVerified: boolean;
  /** Provenance evidence present (attributable source/version/lineage). */
  readonly provenanceVerified: boolean;
}

/** The result of {@link scoreImportedAgent}. */
export interface QualityScore {
  readonly total: number;
  readonly perSection: Readonly<Record<QualitySection, number>>;
  /** Whether activation is permitted: 100/100 AND both evidence gates hold. */
  readonly activationAllowed: boolean;
  /** Safe, secret-free reason when activation is not allowed. */
  readonly reason: string;
}

function clampSection(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > SECTION_MAX) return SECTION_MAX;
  return value;
}

/**
 * Score an imported agent EXACTLY per NN-AGENT-006: each of the four sections
 * contributes at most 25 points; activation requires an earned 100/100 AND
 * both the authenticity and provenance evidence gates. A missing gate or any
 * section below 25 refuses activation (fail-closed). Deterministic and
 * side-effect free.
 */
export function scoreImportedAgent(input: ImportedQualityInput): QualityScore {
  const perSection: Record<QualitySection, number> = {
    promptSpecificity: clampSection(input.promptSpecificity),
    deliverableStructure: clampSection(input.deliverableStructure),
    workflowCompleteness: clampSection(input.workflowCompleteness),
    domainDepth: clampSection(input.domainDepth),
  };
  const total =
    perSection.promptSpecificity +
    perSection.deliverableStructure +
    perSection.workflowCompleteness +
    perSection.domainDepth;

  const gatesOk = input.authenticityVerified && input.provenanceVerified;
  const perfect = total === QUALITY_PASS_TOTAL;
  const activationAllowed = perfect && gatesOk;

  let reason: string;
  if (activationAllowed) {
    reason = 'earned 100/100 with authenticity and provenance evidence';
  } else if (!perfect) {
    reason = `quality ${total}/100 below the required ${QUALITY_PASS_TOTAL}`;
  } else if (!input.authenticityVerified) {
    reason = 'authenticity evidence missing';
  } else {
    reason = 'provenance evidence missing';
  }

  return {
    total,
    perSection: Object.freeze(perSection),
    activationAllowed,
    reason,
  };
}

// ─── Capability-checked model routes (NN-AGENT-010) ─────────────────────────

/**
 * A per-agent model route request (NN-AGENT-010). The route names the
 * platform/architecture cell and the capability the model requires; a route to
 * an UNAVAILABLE capability is refused (NN-INV-001). Fallback is allowed only
 * through pre-approved routes preserving trust and capability.
 */
export interface RouteRequest {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly platform: string;
  readonly architecture: string;
  /** Pre-approved fallback capability ids, tried in order (NN-AGENT-010). */
  readonly preApprovedFallbacks?: readonly string[];
  readonly correlationId?: string;
}

/** The outcome of {@link checkRouteCapability}. */
export type RouteDecision =
  | {
      readonly ok: true;
      readonly capabilityId: string;
      /** Whether a pre-approved fallback was used instead of the primary. */
      readonly usedFallback: boolean;
    }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * Decide a model route against the Capability Registry (NN-AGENT-010). The
 * primary capability is checked first; if it is unavailable, each PRE-APPROVED
 * fallback is tried in order. A route to a capability that is neither available
 * nor covered by a pre-approved fallback is REFUSED with the registry's typed
 * `UNAVAILABLE` — never silently downgraded (NN-INV-001). The capability id
 * must be a known {@link CapabilityRegistry} id; an unknown id is refused.
 *
 * This function performs no risky probe: it reads the descriptive registry
 * truth only (the registry itself never spawns/reads credentials).
 */
export function checkRouteCapability(
  registry: CapabilityRegistry,
  request: RouteRequest,
): RouteDecision {
  const candidates = [request.capabilityId, ...(request.preApprovedFallbacks ?? [])];
  let lastError: ErrorEnvelope | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const capabilityId = candidates[i];
    // The registry query returns a typed UNAVAILABLE for unknown/absent cells.
    const result = registry.query(
      // Cast is safe: an unknown id yields a synthesized UNAVAILABLE, not a
      // throw — the registry treats absence as fail-closed (NN-INV-001).
      capabilityId as never,
      request.platform as never,
      request.architecture as never,
      request.correlationId,
    );
    if (result.ok) {
      return { ok: true, capabilityId, usedFallback: i > 0 };
    }
    lastError = result.error;
  }
  return {
    ok: false,
    error: lastError as ErrorEnvelope,
  };
}
