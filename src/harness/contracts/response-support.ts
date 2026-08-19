import { z } from 'zod';

/**
 * Supporting contracts for structured responses.
 *
 * These contracts are intentionally strict: unlike durable forward-compatible
 * event envelopes, renderer-facing values must not preserve unknown fields.
 * This keeps raw paths, URLs, prompts, commands, and other private values from
 * crossing into presentation or diagnostic channels.
 *
 * Requirements: 7.4, 10.9, 12.4–12.8, 14.4, 20.3–20.7, 22.6
 */

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_PATH_PATTERN =
  /(?:^|[\s"'`([{=:])(?:~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/][^\s]+|\.{1,2}[\\/]|(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+))/i;
const UNRESTRICTED_URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|vbscript|file|ftp|ftps|mailto|ssh|git|ws|wss):|www\.)/i;
const NAMED_SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|password|secret|authorization|bearer|private[_-]?key)\s*[:=]\s*\S+/i;
const SECRET_VALUE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/;
const PROTECTED_TEXT_PATTERN = /(?:protected\s+prompt|system\s+prompt|hidden\s+reasoning|chain[- ]of[- ]thought)/i;
const EXECUTABLE_COMMAND_PATTERN =
  /(?:^|[\s"'`([{=:])(?:rm\s+-rf|sudo\s+|curl\s+[^\n]*\|\s*(?:sh|bash)|powershell(?:\.exe)?\s+-|cmd(?:\.exe)?\s+\/c)/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const OpaqueResponseIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ID_PATTERN, 'must be an opaque identifier')
  .refine((value) => !SECRET_VALUE_PATTERN.test(value), 'secret-like identifiers are not permitted');

export const ResponseDigestSchema = z
  .string()
  .regex(DIGEST_PATTERN, 'must be a versioned SHA-256 digest');

/** Presentation text may be displayed, copied, or announced verbatim. */
export const AuthorizedPresentationTextSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), 'control characters are not permitted')
  .refine((value) => !PRIVATE_PATH_PATTERN.test(value), 'private paths are not permitted')
  .refine((value) => !UNRESTRICTED_URL_PATTERN.test(value), 'URLs and protocols are not permitted')
  .refine(
    (value) => !NAMED_SECRET_PATTERN.test(value) && !SECRET_VALUE_PATTERN.test(value),
    'secret-like values are not permitted',
  )
  .refine((value) => !PROTECTED_TEXT_PATTERN.test(value), 'protected text is not permitted')
  .refine((value) => !EXECUTABLE_COMMAND_PATTERN.test(value), 'executable commands are not permitted');

export const AuthorityKindV1Schema = z.enum([
  'mcp_server_manager',
  'provider_registry',
  'session_store',
  'plugin_registry',
  'orchestration_engine',
  'skill_catalog',
  'security_authority',
  'filesystem_authority',
  'process_authority',
  'terminal_authority',
  'language_service_authority',
  'tool_system',
  'projection_service',
  'web_retrieval_service',
  'attachment_service',
  'session_query_service',
  'draft_authority',
  'collaboration_authority',
  'external_navigation_authority',
]);

export const AuthorityRefV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    authorityKind: AuthorityKindV1Schema,
    authorityId: OpaqueResponseIdSchema,
  })
  .strict();

export type AuthorityKindV1 = z.infer<typeof AuthorityKindV1Schema>;
export type AuthorityRefV1 = z.infer<typeof AuthorityRefV1Schema>;
/** Design-level compatibility alias used by response block contracts. */
export type AuthorityRef = AuthorityRefV1;
export const AuthorityRefSchema = AuthorityRefV1Schema;

export const DetailKindV1Schema = z.enum([
  'tool',
  'source',
  'diff',
  'data',
  'trajectory',
  'insight',
  'attachment',
  'provenance',
]);

/**
 * An authority-issued detail identity. It deliberately has no path, URL, or
 * free-form locator field.
 */
export const OpaqueDetailLocatorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    locatorId: OpaqueResponseIdSchema,
    kind: DetailKindV1Schema,
    authority: AuthorityRefV1Schema,
    sourceRevision: z.number().int().nonnegative(),
  })
  .strict();

export type DetailKindV1 = z.infer<typeof DetailKindV1Schema>;
export type OpaqueDetailLocatorV1 = z.infer<typeof OpaqueDetailLocatorV1Schema>;

export const ActionKindV1Schema = z.enum([
  'insert_prompt',
  'submit_prompt',
  'navigate',
  'authority_command',
]);

export const ActionRiskV1Schema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
]);

/**
 * A renderer action describes authority routing; it never contains a command
 * string, dynamic IPC channel, arbitrary URL, or model-authored payload.
 */
export const ActionDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    actionId: OpaqueResponseIdSchema,
    kind: ActionKindV1Schema,
    label: AuthorizedPresentationTextSchema.max(160),
    owner: AuthorityRefV1Schema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    expectedSourceRevision: z.number().int().nonnegative().optional(),
    target: OpaqueDetailLocatorV1Schema.optional(),
    idempotencyKey: OpaqueResponseIdSchema.optional(),
    disabledReason: AuthorizedPresentationTextSchema.max(512).optional(),
    risk: ActionRiskV1Schema.optional(),
    scopeDigest: ResponseDigestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target === undefined) return;

    if (
      value.owner.authorityKind !== value.target.authority.authorityKind ||
      value.owner.authorityId !== value.target.authority.authorityId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['target', 'authority'],
        message: 'action target must be issued by the owning authority',
      });
    }
    if (
      value.expectedSourceRevision !== undefined &&
      value.expectedSourceRevision !== value.target.sourceRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedSourceRevision'],
        message: 'action and target source revisions must match',
      });
    }
  });

export type ActionKindV1 = z.infer<typeof ActionKindV1Schema>;
export type ActionRiskV1 = z.infer<typeof ActionRiskV1Schema>;
export type ActionDescriptorV1 = z.infer<typeof ActionDescriptorV1Schema>;

export const CommandConfirmationStateV1Schema = z.enum([
  'pending',
  'confirmed',
  'completed',
  'rejected',
  'expired',
  'superseded',
]);

export const CommandConfirmationRefV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: OpaqueResponseIdSchema,
    actionId: OpaqueResponseIdSchema,
    owner: AuthorityRefV1Schema,
    state: CommandConfirmationStateV1Schema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    observedProjectionRevision: z.number().int().nonnegative().optional(),
    observedSourceRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state !== 'pending' &&
      (value.observedProjectionRevision === undefined || value.observedSourceRevision === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'terminal command confirmation requires observed revisions',
      });
    }
    if (
      value.observedProjectionRevision !== undefined &&
      value.observedProjectionRevision < value.expectedProjectionRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observedProjectionRevision'],
        message: 'command confirmation cannot precede its expected projection revision',
      });
    }
  });

export type CommandConfirmationStateV1 = z.infer<typeof CommandConfirmationStateV1Schema>;
export type CommandConfirmationRefV1 = z.infer<typeof CommandConfirmationRefV1Schema>;

export const SourceStateV1Schema = z.enum([
  'available',
  'stale',
  'unavailable',
  'redacted',
  'unverified',
  'no_longer_authorized',
]);

export const SourceTypeV1Schema = z.enum([
  'web',
  'file',
  'attachment',
  'session',
  'artifact',
  'tool',
  'provider',
]);

/**
 * Source metadata contains citation identity and an opaque detail locator, not
 * an unrestricted URL or file path. Protected presentation content is allowed
 * only while the source is authority-projected as available.
 */
export const SourceReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    citationId: OpaqueResponseIdSchema,
    sourceType: SourceTypeV1Schema,
    state: SourceStateV1Schema,
    sourceRevision: z.number().int().nonnegative(),
    authority: AuthorityRefV1Schema,
    detail: OpaqueDetailLocatorV1Schema.optional(),
    contentDigest: ResponseDigestSchema.optional(),
    retrievedAt: z.string().datetime().optional(),
    permittedTitle: AuthorizedPresentationTextSchema.max(512).optional(),
    permittedExcerpt: AuthorizedPresentationTextSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state !== 'available' &&
      (value.permittedTitle !== undefined || value.permittedExcerpt !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'protected source presentation fields require an available source',
      });
    }
    if (value.state === 'no_longer_authorized' && value.detail !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['detail'],
        message: 'unauthorized sources cannot retain a detail locator',
      });
    }
    if (value.detail !== undefined) {
      if (value.detail.kind !== 'source') {
        context.addIssue({
          code: 'custom',
          path: ['detail', 'kind'],
          message: 'source references require a source detail locator',
        });
      }
      if (
        value.detail.authority.authorityKind !== value.authority.authorityKind ||
        value.detail.authority.authorityId !== value.authority.authorityId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['detail', 'authority'],
          message: 'source detail must be issued by the source authority',
        });
      }
      if (value.detail.sourceRevision !== value.sourceRevision) {
        context.addIssue({
          code: 'custom',
          path: ['detail', 'sourceRevision'],
          message: 'source and detail revisions must match',
        });
      }
    }
  });

export type SourceStateV1 = z.infer<typeof SourceStateV1Schema>;
export type SourceTypeV1 = z.infer<typeof SourceTypeV1Schema>;
export type SourceReferenceV1 = z.infer<typeof SourceReferenceV1Schema>;

export const RedactedDiagnosticReasonCodeV1Schema = z.enum([
  'INVALID_CONTRACT',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_KIND',
  'MISSING_REQUIRED_FIELD',
  'MALFORMED_NESTED_CONTENT',
  'DUPLICATE_STABLE_KEY',
  'INCOMPATIBLE_RENDER_INTENT',
  'UNAUTHORIZED_SOURCE',
  'STALE_SOURCE',
  'SENSITIVE_VALUE_REJECTED',
  'UNSAFE_PROTOCOL_REJECTED',
  'EXECUTABLE_CONTENT_REJECTED',
  'AUTHORITY_MISMATCH',
  'STALE_PROJECTION',
  'DUPLICATE_COMMAND',
  'RENDERER_FAILURE',
]);

export const DiagnosticScopeV1Schema = z.enum([
  'action',
  'authority',
  'block',
  'composition',
  'command_confirmation',
  'source',
  'renderer',
]);

export const DiagnosticEntityKindV1Schema = z.enum([
  'narrative',
  'reasoning',
  'turn_status',
  'tool_activity',
  'task_progress',
  'decision',
  'recommendation',
  'context',
  'code',
  'diff',
  'structured_data',
  'insight',
  'attachment',
  'error',
  'follow_up_actions',
  'action',
  'source',
  'renderer',
]);

/**
 * Telemetry-safe diagnostic. There is intentionally no message, stack, raw
 * issue list, path, URL, prompt, command, locator, arguments, or content field.
 */
export const RedactedDiagnosticV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    diagnosticId: OpaqueResponseIdSchema,
    correlationId: OpaqueResponseIdSchema,
    reasonCode: RedactedDiagnosticReasonCodeV1Schema,
    scope: DiagnosticScopeV1Schema,
    severity: z.enum(['info', 'warning', 'error']),
    contractVersion: z.number().int().positive().optional(),
    entityKind: DiagnosticEntityKindV1Schema.optional(),
    observedSize: z.number().int().nonnegative().max(10_000_000).optional(),
    contentDigest: ResponseDigestSchema.optional(),
    sourceRevision: z.number().int().nonnegative().optional(),
    authority: AuthorityRefV1Schema.optional(),
    occurrences: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export type RedactedDiagnosticReasonCodeV1 = z.infer<
  typeof RedactedDiagnosticReasonCodeV1Schema
>;
export type DiagnosticScopeV1 = z.infer<typeof DiagnosticScopeV1Schema>;
export type RedactedDiagnosticV1 = z.infer<typeof RedactedDiagnosticV1Schema>;
/** Design-level compatibility alias used by response composition parsers. */
export type RedactedDiagnostic = RedactedDiagnosticV1;
export const RedactedDiagnosticSchema = RedactedDiagnosticV1Schema;

export type ResponseSupportParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostic: RedactedDiagnosticV1 };

function collectBoundedStrings(value: unknown): string[] {
  const strings: string[] = [];
  const visited = new Set<object>();

  const visit = (candidate: unknown, depth: number): void => {
    if (strings.length >= 100 || depth > 5) return;
    if (typeof candidate === 'string') {
      strings.push(candidate.slice(0, 4_096));
      return;
    }
    if (typeof candidate !== 'object' || candidate === null || visited.has(candidate)) return;

    visited.add(candidate);
    try {
      for (const [key, nested] of Object.entries(candidate).slice(0, 100)) {
        strings.push(key.slice(0, 256));
        visit(nested, depth + 1);
      }
    } catch {
      // Hostile getters/proxies are classified as malformed without inspection.
    }
  };

  visit(value, 0);
  return strings;
}

function classifyBoundaryFailure(raw: unknown): RedactedDiagnosticReasonCodeV1 {
  try {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'schemaVersion' in raw &&
      (raw as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return 'UNSUPPORTED_VERSION';
    }
  } catch {
    return 'INVALID_CONTRACT';
  }

  const values = collectBoundedStrings(raw);
  if (values.some((value) => EXECUTABLE_COMMAND_PATTERN.test(value))) {
    return 'EXECUTABLE_CONTENT_REJECTED';
  }
  if (values.some((value) => UNRESTRICTED_URL_PATTERN.test(value))) {
    return 'UNSAFE_PROTOCOL_REJECTED';
  }
  if (
    values.some(
      (value) =>
        PRIVATE_PATH_PATTERN.test(value) ||
        NAMED_SECRET_PATTERN.test(value) ||
        SECRET_VALUE_PATTERN.test(value) ||
        PROTECTED_TEXT_PATTERN.test(value),
    )
  ) {
    return 'SENSITIVE_VALUE_REJECTED';
  }
  return 'INVALID_CONTRACT';
}

function boundedObservedSize(raw: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) return undefined;
    return Math.min(serialized.length, 10_000_000);
  } catch {
    return undefined;
  }
}

function safeCorrelationId(value?: string): string {
  const parsed = OpaqueResponseIdSchema.safeParse(value);
  return parsed.success ? parsed.data : 'contract-boundary';
}

function makeBoundaryDiagnostic(
  scope: DiagnosticScopeV1,
  raw: unknown,
  correlationId?: string,
): RedactedDiagnosticV1 {
  return {
    schemaVersion: 1,
    diagnosticId: `invalid-${scope}`,
    correlationId: safeCorrelationId(correlationId),
    reasonCode: classifyBoundaryFailure(raw),
    scope,
    severity: 'error',
    observedSize: boundedObservedSize(raw),
    occurrences: 1,
  };
}

function parseStrictContract<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  scope: DiagnosticScopeV1,
  correlationId?: string,
): ResponseSupportParseResult<T> {
  try {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, value: result.data };
  } catch {
    // Boundary parsers are total even for hostile getters/proxies.
  }
  return { ok: false, diagnostic: makeBoundaryDiagnostic(scope, raw, correlationId) };
}

export function parseAuthorityRefV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<AuthorityRefV1> {
  return parseStrictContract(AuthorityRefV1Schema, raw, 'authority', correlationId);
}

export function parseOpaqueDetailLocatorV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<OpaqueDetailLocatorV1> {
  return parseStrictContract(OpaqueDetailLocatorV1Schema, raw, 'source', correlationId);
}

export function parseActionDescriptorV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<ActionDescriptorV1> {
  return parseStrictContract(ActionDescriptorV1Schema, raw, 'action', correlationId);
}

export function parseCommandConfirmationRefV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<CommandConfirmationRefV1> {
  return parseStrictContract(
    CommandConfirmationRefV1Schema,
    raw,
    'command_confirmation',
    correlationId,
  );
}

export function parseSourceReferenceV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<SourceReferenceV1> {
  return parseStrictContract(SourceReferenceV1Schema, raw, 'source', correlationId);
}

export function parseRedactedDiagnosticV1(
  raw: unknown,
  correlationId?: string,
): ResponseSupportParseResult<RedactedDiagnosticV1> {
  return parseStrictContract(RedactedDiagnosticV1Schema, raw, 'renderer', correlationId);
}

export const DomSafeActionDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    actionId: OpaqueResponseIdSchema,
    kind: ActionKindV1Schema,
    label: AuthorizedPresentationTextSchema.max(160),
    owner: AuthorityRefV1Schema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    disabledReason: AuthorizedPresentationTextSchema.max(512).optional(),
    risk: ActionRiskV1Schema.optional(),
  })
  .strict();

export type DomSafeActionDescriptorV1 = z.infer<typeof DomSafeActionDescriptorV1Schema>;

export function toDomSafeActionDescriptorV1(
  action: ActionDescriptorV1,
): DomSafeActionDescriptorV1 {
  return DomSafeActionDescriptorV1Schema.parse({
    schemaVersion: action.schemaVersion,
    actionId: action.actionId,
    kind: action.kind,
    label: action.label,
    owner: action.owner,
    expectedProjectionRevision: action.expectedProjectionRevision,
    ...(action.disabledReason === undefined
      ? {}
      : { disabledReason: action.disabledReason }),
    ...(action.risk === undefined ? {} : { risk: action.risk }),
  });
}

export const DomSafeSourceReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    citationId: OpaqueResponseIdSchema,
    sourceType: SourceTypeV1Schema,
    state: SourceStateV1Schema,
    sourceRevision: z.number().int().nonnegative(),
    permittedTitle: AuthorizedPresentationTextSchema.max(512).optional(),
    permittedExcerpt: AuthorizedPresentationTextSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state !== 'available' &&
      (value.permittedTitle !== undefined || value.permittedExcerpt !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'protected source presentation fields require an available source',
      });
    }
  });

export type DomSafeSourceReferenceV1 = z.infer<typeof DomSafeSourceReferenceV1Schema>;

export function toDomSafeSourceReferenceV1(
  source: SourceReferenceV1,
): DomSafeSourceReferenceV1 {
  return DomSafeSourceReferenceV1Schema.parse({
    schemaVersion: source.schemaVersion,
    citationId: source.citationId,
    sourceType: source.sourceType,
    state: source.state,
    sourceRevision: source.sourceRevision,
    permittedTitle: source.permittedTitle,
    permittedExcerpt: source.permittedExcerpt,
  });
}

/** Revalidates potentially forged runtime input before telemetry serialization. */
export function toTelemetrySafeDiagnosticV1(raw: unknown): RedactedDiagnosticV1 {
  const parsed = parseRedactedDiagnosticV1(raw);
  return parsed.ok ? parsed.value : parsed.diagnostic;
}
