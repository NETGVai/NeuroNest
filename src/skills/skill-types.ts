/**
 * Skill contracts — `SkillManifest@1`, Markdown+YAML frontmatter parsing,
 * content hashing, metadata validation, and lossless round-trip
 * (FUT-PKG-06-EXECUTION/T-005).
 *
 * D-04 splits skill ownership: "Markdown file for body" is the canonical
 * SOURCE of skill content, and `SkillCatalog` is the sole write authority for
 * installation/enablement/version/routing/assignment/evaluation/provenance
 * STATE. The canonical identity is `skillId`, `semver`, `content hash`, and
 * `catalog revision`; a SQLite-authored skill body is a forbidden competing
 * owner (CD-008).
 *
 * D-07 pins `SkillManifest@1`:
 *
 *   `{schemaVersion, skillId, skillVersion, name, description, source, scope,
 *     entrypoints[], contentRef, contentHash, capabilities[], toolRefs[],
 *     compatibility, evaluationRefs[], provenance, status}`
 *
 * with the invariant that "Markdown owns content and Skill Catalog owns
 * installation/enablement state. Invalid metadata, traversal, unresolved
 * references, or ambiguous duplicates block registration."
 *
 * This module owns the versioned contract, the deterministic Markdown/YAML
 * frontmatter parser + printer (whose round trip is EQUIVALENT — NN-SKILL-003,
 * NN-DATA-010), the fail-closed metadata rules (kebab-case id, ≤100-char name,
 * ≤500-char description, valid source/scope enums, traversal-free entrypoints),
 * and the content hash that — with the catalog revision — is the reconciliation
 * OBSERVER (NN-SKILL-001). It is additive over
 * {@link ../shared/contract-primitives} (canonical serializer, `computeDigest`,
 * opaque IDs, redaction ladder).
 *
 * Design anchors: D-04, D-05, D-07 (`SkillManifest@1`), D-11, D-20.
 * Requirements: NN-SKILL-001/003, NN-DATA-001/010/011, NN-INV-001/011, CD-008.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  RedactionClassSchema,
  RevisionSchema,
  TimestampSchema,
  canonicalSerialize,
  computeDigest,
} from '../shared/contract-primitives';

// ─── Enumerations (NN-SKILL-003) ────────────────────────────────────────────

/**
 * A skill's SOURCE class (NN-SKILL-004: installed, available, custom, learned,
 * and pack sources are displayed distinctly). `bundled` is a first-party asset
 * shipped with the app; `custom` is a user/derived skill; `pack` came from an
 * installed pack; `learned` was proposed from a successful execution; `project`
 * is explicit project content (NN-SKILL-002).
 */
export const SKILL_SOURCES = Object.freeze([
  'bundled',
  'custom',
  'pack',
  'learned',
  'project',
] as const);
export type SkillSource = (typeof SKILL_SOURCES)[number];
export const SkillSourceSchema = z.enum(SKILL_SOURCES);

/**
 * A skill's SCOPE (NN-SKILL-002). `global` skills/packs live under the DataRoot
 * (`~/.neuronest/skills/`, `~/.neuronest/skill-packs/`); `project` skills remain
 * explicit project content.
 */
export const SKILL_SCOPES = Object.freeze(['global', 'project'] as const);
export type SkillScope = (typeof SKILL_SCOPES)[number];
export const SkillScopeSchema = z.enum(SKILL_SCOPES);

/**
 * The kind of executable an entrypoint names (NN-SKILL-008). Pure-instruction,
 * shell, Node, and workspace-action skills all run THROUGH the Tool Execution
 * Pipeline (D-11); this module only records the declared kind and its
 * traversal-free relative reference.
 */
export const ENTRYPOINT_KINDS = Object.freeze([
  'instruction',
  'shell',
  'node',
  'workspace-action',
] as const);
export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number];
export const EntrypointKindSchema = z.enum(ENTRYPOINT_KINDS);

/**
 * A skill's INSTALL/ENABLE status ladder (state owned by the catalog). A
 * `blocked` skill failed a fail-closed check (stale/cyclic/missing/duplicate/
 * budget) and can never be loaded/assigned (NN-SKILL-010).
 */
export const SKILL_STATUSES = Object.freeze([
  'available',
  'installed',
  'enabled',
  'disabled',
  'blocked',
] as const);
export type SkillStatus = (typeof SKILL_STATUSES)[number];
export const SkillStatusSchema = z.enum(SKILL_STATUSES);

/** Whether a status means the skill is enabled and loadable. */
export function isEnabledStatus(status: SkillStatus): boolean {
  return status === 'enabled';
}

// ─── Metadata bounds (NN-SKILL-003) ─────────────────────────────────────────

/** Maximum skill name length (NN-SKILL-003). */
export const MAX_NAME_LENGTH = 100 as const;
/** Maximum skill description length (NN-SKILL-003). */
export const MAX_DESCRIPTION_LENGTH = 500 as const;

/**
 * Non-empty kebab-case skill id (NN-SKILL-003). Lowercase alphanumerics with
 * single interior hyphens; no leading/trailing/double hyphen. This is stricter
 * than the general opaque-id pattern because a skill id is authored by a human
 * in Markdown frontmatter.
 */
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a string is a valid non-empty kebab-case skill id. */
export function isKebabCaseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    KEBAB_CASE_PATTERN.test(value)
  );
}

/** Zod schema for a kebab-case skill id. */
export const SkillIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(KEBAB_CASE_PATTERN, 'expected a non-empty kebab-case skill id');

/**
 * Whether a relative entrypoint reference is TRAVERSAL-FREE (NN-SKILL-003,
 * NN-SEC-012). This is a purely LOGICAL check performed before any filesystem
 * access: the reference must be a relative POSIX path with no `..` segment, no
 * absolute/root anchor, no drive letter, no leading `~`, no NUL byte, and no
 * Windows device namespace. The concrete on-disk containment against the skill
 * root is enforced separately by the Security Authority's `evaluatePath`
 * (symlink-resolving) at load time; this check fails a manifest CLOSED so a
 * traversal reference never even reaches the loader.
 */
export function isTraversalFreeRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 1024) {
    return false;
  }
  if (ref.includes('\u0000')) return false;
  // Reject any absolute anchor (POSIX root, Windows drive, UNC/device, home).
  if (ref.startsWith('/') || ref.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return false;
  if (ref.startsWith('~')) return false;
  // Normalize separators to POSIX and inspect each segment.
  const segments = ref.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (seg === '..') return false;
    // A bare `.` or empty segment (e.g. `a//b`, trailing slash) is not a valid
    // traversal-free file reference.
    if (seg === '' || seg === '.') return false;
  }
  return true;
}

// ─── SkillManifest@1 (D-07, NN-SKILL-003) ───────────────────────────────────

/** A single declared entrypoint: its kind and its traversal-free reference. */
export const SkillEntrypointSchema = z.strictObject({
  kind: EntrypointKindSchema,
  /** Relative, traversal-free reference to the entrypoint (validated). */
  ref: z.string().min(1).max(1024).refine(isTraversalFreeRef, {
    message: 'entrypoint ref must be a relative, traversal-free path',
  }),
});
export type SkillEntrypoint = z.infer<typeof SkillEntrypointSchema>;

/**
 * Semantic version triple (NN-SKILL-001 uses semantic version, never
 * last-writer-wins). Stored as a structured triple so ordering is defined.
 */
export const SemverSchema = z.strictObject({
  major: z.number().int().nonnegative().finite(),
  minor: z.number().int().nonnegative().finite(),
  patch: z.number().int().nonnegative().finite(),
});
export type Semver = z.infer<typeof SemverSchema>;

/** Compare two semvers: negative if a<b, 0 if equal, positive if a>b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Format a semver as `major.minor.patch`. */
export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * App-major compatibility range (D-07 "incompatible ranges … block
 * registration"). A skill is compatible only when the current app major is
 * within `[minAppMajor, maxAppMajor]`.
 */
export const SkillCompatibilitySchema = z.strictObject({
  minAppMajor: z.number().int().nonnegative().finite(),
  maxAppMajor: z.number().int().nonnegative().finite(),
});
export type SkillCompatibility = z.infer<typeof SkillCompatibilitySchema>;

/** Provenance for a discovered skill (NN-SKILL-001/005; content-hash lineage). */
export const SkillProvenanceSchema = z.strictObject({
  /** The discovery source path/ref (never a private absolute path in exports). */
  source: z.string().min(1).max(1024),
  /** The actor/tool that produced/imported the skill. */
  producer: z.string().min(1).max(256),
  /** The source version/ref (e.g. a pack commit). */
  sourceVersion: z.string().min(1).max(256),
  importedAt: TimestampSchema,
  /**
   * For a `custom` skill DERIVED from a bundled asset, the bundled skill id it
   * was derived from — editing a bundled asset creates a derived custom version
   * rather than mutating bundle history (NN-SKILL-005).
   */
  derivedFrom: SkillIdSchema.optional(),
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

/**
 * `SkillManifest@1` (D-07). Markdown owns content; the Skill Catalog owns
 * installation/enablement state. `contentRef` is a traversal-free reference to
 * the Markdown body; `contentHash` is the lowercase SHA-256 of the Markdown
 * body and is a reconciliation OBSERVER together with the catalog revision
 * (NN-SKILL-001). Invalid metadata, traversal, unresolved references, or
 * ambiguous duplicates block registration (enforced here for shape/metadata and
 * by the catalog for duplicates/references, {@link ./skill-catalog}).
 */
export const SkillManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  skillId: SkillIdSchema,
  skillVersion: SemverSchema,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  source: SkillSourceSchema,
  scope: SkillScopeSchema,
  entrypoints: z.array(SkillEntrypointSchema).min(1),
  /** Traversal-free reference to the Markdown body. */
  contentRef: z.string().min(1).max(1024).refine(isTraversalFreeRef, {
    message: 'contentRef must be a relative, traversal-free path',
  }),
  /** Lowercase SHA-256 of the Markdown body (the reconciliation observer). */
  contentHash: DigestSchema,
  capabilities: z.array(z.string().min(1).max(128)),
  /** Tool manifest names this skill executes through the pipeline (NN-SKILL-008). */
  toolRefs: z.array(z.string().min(1).max(256)),
  compatibility: SkillCompatibilitySchema,
  /** References to versioned evaluation cases (NN-SKILL-012). */
  evaluationRefs: z.array(z.string().min(1).max(256)),
  provenance: SkillProvenanceSchema,
  status: SkillStatusSchema,
  redaction: RedactionClassSchema,
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ─── Markdown + YAML frontmatter parse / print (NN-SKILL-003) ───────────────

/**
 * The parsed pieces of a Markdown skill file: the YAML frontmatter (as a
 * validated manifest, minus content-derived fields) and the Markdown body. The
 * SOURCE is Markdown-with-YAML-frontmatter; SQLite never authors the body.
 */
export interface ParsedSkillFile {
  /** The validated manifest (contentHash is recomputed from `body`). */
  readonly manifest: SkillManifest;
  /** The Markdown body (the canonical skill content). */
  readonly body: string;
}

/** A parse defect (why a Markdown skill file is malformed). */
export type SkillParseDefect =
  | 'no-frontmatter'
  | 'malformed-frontmatter'
  | 'metadata-invalid'
  | 'content-hash-mismatch';

/** The outcome of parsing an untrusted Markdown skill file. */
export type SkillParseResult =
  | { readonly ok: true; readonly parsed: ParsedSkillFile }
  | { readonly ok: false; readonly defect: SkillParseDefect; readonly detail: string };

/**
 * The delimiter that opens/closes the YAML frontmatter block. A skill file is
 * `---\n<yaml>\n---\n<markdown body>`.
 */
const FRONTMATTER_FENCE = '---';

/**
 * Parse a minimal, deterministic YAML subset sufficient for skill frontmatter:
 * `key: scalar`, `key: [a, b]` inline arrays, nested `key:` blocks with two-space
 * indented children, and `- item` list entries for entrypoints. A full YAML
 * engine is intentionally avoided so parse+print round-trips are EXACTLY
 * equivalent and no ambiguous YAML feature (anchors, multi-doc, flow maps) can
 * smuggle unexpected structure past validation. Anything outside this subset is
 * reported as malformed (fail-closed).
 *
 * This parser only produces a plain object; validation against
 * {@link SkillManifestSchema} happens in {@link parseSkillFile}.
 */
function parseFrontmatterYaml(yaml: string): Record<string, unknown> | undefined {
  const lines = yaml.split('\n');
  const root: Record<string, unknown> = {};
  let i = 0;

  const parseScalar = (raw: string): unknown => {
    const t = raw.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
    // Inline array: [a, b, c] or []
    if (t.startsWith('[') && t.endsWith(']')) {
      const inner = t.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((s) => parseScalar(s));
    }
    // Double-quoted string (supports \" and \\ escapes to round-trip exactly).
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      return unescapeDoubleQuoted(t.slice(1, -1));
    }
    // Single-quoted string (literal, no escapes).
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
      return t.slice(1, -1);
    }
    return t;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // Top-level `key:` or `key: value`.
    const m = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (!m || line.startsWith(' ')) {
      // Unexpected indentation or shape at the top level → malformed.
      return undefined;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest !== '') {
      root[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    // Block value: gather indented children (two-space) until dedent.
    const childLines: string[] = [];
    i += 1;
    while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
      if (lines[i].trim() !== '') childLines.push(lines[i].slice(2));
      i += 1;
    }
    if (childLines.length === 0) {
      root[key] = {};
      continue;
    }
    // List of `- ...` items (possibly each an inline `k: v` map).
    if (childLines.every((c) => c.startsWith('- '))) {
      const items = childLines.map((c) => {
        const itemBody = c.slice(2).trim();
        const mapEntries = itemBody.split(',').map((p) => p.trim());
        const asMap: Record<string, unknown> = {};
        let isMap = true;
        for (const entry of mapEntries) {
          const em = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(entry);
          if (!em) {
            isMap = false;
            break;
          }
          asMap[em[1]] = parseScalar(em[2]);
        }
        return isMap ? asMap : parseScalar(itemBody);
      });
      root[key] = items;
      continue;
    }
    // Nested `k: v` map.
    const nested: Record<string, unknown> = {};
    let nestedOk = true;
    for (const c of childLines) {
      const cm = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(c);
      if (!cm) {
        nestedOk = false;
        break;
      }
      nested[cm[1]] = parseScalar(cm[2]);
    }
    if (!nestedOk) return undefined;
    root[key] = nested;
  }
  return root;
}

/**
 * Parse an untrusted Markdown skill file into a validated manifest + body
 * (NN-SKILL-003). Fail-closed: a file with no frontmatter fence, malformed
 * YAML, metadata that violates the manifest schema/bounds, or a frontmatter
 * `contentHash` that does not equal the SHA-256 of the body is rejected with a
 * typed defect and is NOT registered. The parser is deterministic and
 * side-effect free.
 *
 * The frontmatter carries every manifest field EXCEPT `contentHash`, which is
 * always recomputed from the body — the Markdown hash is the observer, so the
 * catalog never trusts a hash that a source author could desynchronize from the
 * body.
 */
export function parseSkillFile(raw: string): SkillParseResult {
  if (!raw.startsWith(FRONTMATTER_FENCE)) {
    return { ok: false, defect: 'no-frontmatter', detail: 'missing opening --- fence' };
  }
  const afterOpen = raw.slice(FRONTMATTER_FENCE.length);
  // Require a newline right after the opening fence.
  if (!afterOpen.startsWith('\n')) {
    return { ok: false, defect: 'no-frontmatter', detail: 'malformed opening fence' };
  }
  const rest = afterOpen.slice(1);
  const closeIdx = rest.indexOf(`\n${FRONTMATTER_FENCE}`);
  if (closeIdx < 0) {
    return { ok: false, defect: 'no-frontmatter', detail: 'missing closing --- fence' };
  }
  const yaml = rest.slice(0, closeIdx);
  // The body begins after the closing fence's line.
  const afterClose = rest.slice(closeIdx + 1 + FRONTMATTER_FENCE.length);
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  const frontmatter = parseFrontmatterYaml(yaml);
  if (frontmatter === undefined) {
    return {
      ok: false,
      defect: 'malformed-frontmatter',
      detail: 'frontmatter is not valid supported YAML',
    };
  }

  // Recompute the content hash from the body; ignore any author-supplied hash.
  const contentHash = hashSkillBody(body);
  const candidate = { ...frontmatter, contentHash, schemaVersion: CONTRACT_WRITE_VERSION };

  const parsed = SkillManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? first.path.join('.') : '<root>';
    return {
      ok: false,
      defect: 'metadata-invalid',
      detail: `${path}: ${first?.message ?? 'invalid'}`,
    };
  }

  return { ok: true, parsed: { manifest: parsed.data, body } };
}

/**
 * Print a validated manifest + body back to canonical Markdown-with-frontmatter
 * (NN-SKILL-003 "parser/printer round trips equivalent"). The printer emits the
 * manifest fields in a STABLE order using the same YAML subset the parser
 * accepts, so `parseSkillFile(printSkillFile(x)).parsed` is EQUIVALENT to `x`
 * (proved by {@link roundTripSkillFile}). `contentHash`/`schemaVersion` are
 * derived, so they are NOT written into the frontmatter — the printer relies on
 * the parser recomputing the hash from the body.
 */
export function printSkillFile(parsed: ParsedSkillFile): string {
  const m = parsed.manifest;
  const lines: string[] = [FRONTMATTER_FENCE];
  lines.push(`skillId: ${m.skillId}`);
  lines.push('skillVersion:');
  lines.push(`  major: ${m.skillVersion.major}`);
  lines.push(`  minor: ${m.skillVersion.minor}`);
  lines.push(`  patch: ${m.skillVersion.patch}`);
  lines.push(`name: ${quoteScalar(m.name)}`);
  lines.push(`description: ${quoteScalar(m.description)}`);
  lines.push(`source: ${m.source}`);
  lines.push(`scope: ${m.scope}`);
  lines.push('entrypoints:');
  for (const e of m.entrypoints) {
    lines.push(`  - kind: ${e.kind}, ref: ${quoteScalar(e.ref)}`);
  }
  lines.push(`contentRef: ${quoteScalar(m.contentRef)}`);
  lines.push(`capabilities: ${printInlineArray(m.capabilities)}`);
  lines.push(`toolRefs: ${printInlineArray(m.toolRefs)}`);
  lines.push('compatibility:');
  lines.push(`  minAppMajor: ${m.compatibility.minAppMajor}`);
  lines.push(`  maxAppMajor: ${m.compatibility.maxAppMajor}`);
  lines.push(`evaluationRefs: ${printInlineArray(m.evaluationRefs)}`);
  lines.push('provenance:');
  lines.push(`  source: ${quoteScalar(m.provenance.source)}`);
  lines.push(`  producer: ${quoteScalar(m.provenance.producer)}`);
  lines.push(`  sourceVersion: ${quoteScalar(m.provenance.sourceVersion)}`);
  lines.push(`  importedAt: ${quoteScalar(m.provenance.importedAt)}`);
  if (m.provenance.derivedFrom !== undefined) {
    lines.push(`  derivedFrom: ${m.provenance.derivedFrom}`);
  }
  lines.push(`status: ${m.status}`);
  lines.push(`redaction: ${m.redaction}`);
  lines.push(FRONTMATTER_FENCE);
  return `${lines.join('\n')}\n${parsed.body}`;
}

/** Quote a scalar so it round-trips through the frontmatter parser exactly. */
function quoteScalar(value: string): string {
  // Always double-quote to avoid ambiguity with commas, brackets, colons, and
  // reserved literals (true/false/numbers). Backslashes are escaped first, then
  // double-quotes, so `unescapeDoubleQuoted` reverses it exactly.
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Reverse {@link quoteScalar}'s escaping: `\\` → `\` and `\"` → `"`. */
function unescapeDoubleQuoted(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '\\' || next === '"') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Print an inline array using quoted scalars for exact round-trip. */
function printInlineArray(items: readonly string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map((s) => quoteScalar(s)).join(', ')}]`;
}

// ─── Content hash (the reconciliation observer, NN-SKILL-001) ───────────────

/**
 * Compute the canonical content hash of a Markdown skill body: the lowercase
 * SHA-256 of the exact body bytes. This — together with the Skill Catalog
 * revision — is the OBSERVER used for reconciliation; reconciliation uses the
 * content hash and semantic version, never last-writer-wins (NN-SKILL-001).
 */
export function hashSkillBody(body: string): string {
  return computeDigest({ body });
}

// ─── Round-trip (NN-DATA-010, NN-SKILL-003) ─────────────────────────────────

/** The outcome of a manifest/file round-trip check. */
export type RoundTripResult =
  | { readonly ok: true; readonly manifest: SkillManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Round-trip a validated manifest through canonical serialization: serialize
 * then re-parse+validate. Proves parse/serialize equivalence for the STATE
 * projection of a manifest (NN-DATA-010). The re-validated manifest must be
 * deeply equal to the input.
 */
export function roundTripManifest(manifest: SkillManifest): RoundTripResult {
  const bytes = canonicalSerialize(manifest);
  const reparsed = SkillManifestSchema.safeParse(JSON.parse(bytes));
  if (!reparsed.success) {
    return { ok: false, reason: 'manifest failed re-validation after serialize' };
  }
  if (canonicalSerialize(reparsed.data) !== bytes) {
    return { ok: false, reason: 'manifest is not byte-stable after round-trip' };
  }
  return { ok: true, manifest: reparsed.data };
}

/**
 * Round-trip a parsed skill FILE through the Markdown printer + parser
 * (NN-SKILL-003 "parser/printer round trips equivalent"). `printSkillFile` then
 * `parseSkillFile` must yield an EQUIVALENT manifest and the identical body.
 * Because the printer omits the derived `contentHash` and the parser recomputes
 * it from the body, the hash is preserved exactly when the body is preserved.
 */
export function roundTripSkillFile(parsed: ParsedSkillFile): RoundTripResult {
  const printed = printSkillFile(parsed);
  const result = parseSkillFile(printed);
  if (!result.ok) {
    return { ok: false, reason: `re-parse failed: ${result.defect} (${result.detail})` };
  }
  const before = canonicalSerialize(parsed.manifest);
  const after = canonicalSerialize(result.parsed.manifest);
  if (before !== after) {
    return { ok: false, reason: 'manifest changed across print/parse round-trip' };
  }
  if (result.parsed.body !== parsed.body) {
    return { ok: false, reason: 'body changed across print/parse round-trip' };
  }
  return { ok: true, manifest: result.parsed.manifest };
}

/**
 * The effective identity tokens a manifest occupies for duplicate detection:
 * its id and name, lower-cased. Two manifests sharing any token have an
 * ambiguous duplicate identity (D-07) and both are blocked by the catalog.
 */
export function skillIdentityTokens(
  manifest: Pick<SkillManifest, 'skillId' | 'name'>,
): string[] {
  return [manifest.skillId, manifest.name].map((t) => t.toLowerCase());
}

/** Whether the manifest's compatibility range admits `appMajor`. */
export function isSkillCompatible(
  manifest: Pick<SkillManifest, 'compatibility'>,
  appMajor: number,
): boolean {
  const { minAppMajor, maxAppMajor } = manifest.compatibility;
  return (
    minAppMajor <= maxAppMajor && appMajor >= minAppMajor && appMajor <= maxAppMajor
  );
}
