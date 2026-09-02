/**
 * Foundation Contract Catalog (FUT-PKG-02-FOUNDATION/T-002).
 *
 * Registers the concrete, already-migrated typed `*-v1` IPC facades into a
 * {@link ContractRegistry}, mapping each to the legacy string channel it
 * coexists with. This is the "run the typed facade beside measured ingress
 * adapters with one main-process writer" step (NN-COMPAT-001/002): the typed
 * registry is the *authority* while the preload string allowlists in
 * `src/renderer/preload.ts` remain *bounded compatibility adapters* that never
 * authorize (CD-029, NN-COMPAT-017).
 *
 * The catalog is deliberately scoped to the fixed, fully-typed facades that the
 * P0 inventory (Task 0.4) already found beside the preload allowlists — the
 * bootstrap/settings boundary, the external-link boundary, and the structured
 * chat boundary. It does not attempt to type every legacy channel in one step;
 * unmapped legacy channels remain bounded adapters until later packages migrate
 * them (NN-COMPAT-001 additive-first).
 *
 * Design anchors: D-05, D-07, D-16, D-20.
 * Requirements: NN-EVENT-007/008/009, NN-COMPAT-001/002/017, NN-SEC-009, CD-029.
 */

import {
  ContractRegistry,
  type ContractDescriptor,
} from './contract-registry';

// ─── Lightweight structural validators ──────────────────────────────────────
//
// The catalog keeps validators as narrow structural predicates so the registry
// stays decoupled from each feature's zod schema module. The concrete zod
// schemas remain the primary validators at the live handler boundary; these
// predicates enforce the envelope shape the registry needs to make a no-effect
// dispatch decision. A real payload is an object carrying `schemaVersion: 1`.

function isV1Object(value: unknown): value is { schemaVersion: number } {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  );
}

function hasStringField(
  value: unknown,
  field: string,
): value is Record<string, string> {
  return (
    isV1Object(value) &&
    typeof (value as Record<string, unknown>)[field] === 'string' &&
    ((value as Record<string, unknown>)[field] as string).length > 0
  );
}

// ─── Owners ──────────────────────────────────────────────────────────────────

const OWNER_BOOTSTRAP = 'authority-app-bootstrap';
const OWNER_SHELL = 'authority-shell';
const OWNER_CHAT = 'authority-chat-projection';

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * The concrete foundation contracts, in registration order. Each entry pins the
 * NN-EVENT-007 metadata set and maps the legacy alias channel that the preload
 * allowlist still exposes.
 */
export const FOUNDATION_CONTRACTS: readonly ContractDescriptor[] = Object.freeze(
  [
    {
      name: 'app-bootstrap.get',
      owner: OWNER_BOOTSTRAP,
      description: 'Fetch the renderer bootstrap snapshot.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [{ legacyChannel: 'app-bootstrap:get-v1', deprecated: false }],
    },
    {
      name: 'launch-settings.get-mode',
      owner: OWNER_BOOTSTRAP,
      description: 'Read the launch-mode settings.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'launch-settings:get-mode-v1', deprecated: false },
      ],
    },
    {
      name: 'launch-settings.update-mode',
      owner: OWNER_BOOTSTRAP,
      description: 'Update the launch-mode settings (durable mutation).',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'committed-revision',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: true,
      requiresIdempotencyKey: true,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'launch-settings:update-mode-v1', deprecated: false },
      ],
    },
    {
      name: 'inspector-layout.get',
      owner: OWNER_BOOTSTRAP,
      description: 'Read the inspector layout state.',
      direction: 'renderer-to-main',
      tier: 'public',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'public',
      aliases: [{ legacyChannel: 'inspector-layout:get-v1', deprecated: false }],
    },
    {
      name: 'inspector-layout.update',
      owner: OWNER_BOOTSTRAP,
      description: 'Update the inspector layout state (durable mutation).',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'committed-revision',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: true,
      requiresIdempotencyKey: true,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'inspector-layout:update-v1', deprecated: false },
      ],
    },
    {
      name: 'proxy-credential.get-status',
      owner: OWNER_BOOTSTRAP,
      description: 'Read the proxy-credential status (masked reference only).',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'sensitive',
      aliases: [
        { legacyChannel: 'proxy-credential:get-status-v1', deprecated: false },
      ],
    },
    {
      name: 'entitlements.get-status',
      owner: OWNER_BOOTSTRAP,
      description: 'Read the entitlement status.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'entitlements:get-status-v1', deprecated: false },
      ],
    },
    {
      name: 'shell.open-external',
      owner: OWNER_SHELL,
      description:
        'Open a validated external link in the OS default handler (privileged).',
      direction: 'renderer-to-main',
      tier: 'privileged',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => hasStringField(p, 'href'),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 10_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [{ legacyChannel: 'shell:open-external-v1', deprecated: false }],
    },
    {
      name: 'chat-projection.get-page',
      owner: OWNER_CHAT,
      description: 'Read a page of the chat projection.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: true,
      requiresCorrelationId: true,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'chat-projection:get-page-v1', deprecated: false },
      ],
    },
    {
      name: 'chat-projection.get-composition',
      owner: OWNER_CHAT,
      description: 'Read the chat projection composition.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: true,
      requiresCorrelationId: true,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        {
          legacyChannel: 'chat-projection:get-composition-v1',
          deprecated: false,
        },
      ],
    },
    {
      name: 'chat-command.submit',
      owner: OWNER_CHAT,
      description: 'Submit a chat command (durable mutation).',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'committed-revision',
      timeoutMs: 15_000,
      cancellable: true,
      requiresCorrelationId: true,
      requiresIdempotencyKey: true,
      redaction: 'internal',
      aliases: [{ legacyChannel: 'chat-command:submit-v1', deprecated: false }],
    },
    {
      name: 'chat-diagnostics.get-render-status',
      owner: OWNER_CHAT,
      description: 'Read the chat render-status diagnostics.',
      direction: 'renderer-to-main',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => p === undefined || isV1Object(p),
      validateResponse: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'response',
      timeoutMs: 5_000,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        {
          legacyChannel: 'chat-diagnostics:get-render-status-v1',
          deprecated: false,
        },
      ],
    },
    {
      name: 'chat-projection.delta',
      owner: OWNER_CHAT,
      description: 'Main → renderer chat projection delta (ordered event).',
      direction: 'main-to-renderer',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'fire-and-forget',
      timeoutMs: 0,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'chat-projection:delta-v1', deprecated: false },
      ],
    },
    {
      name: 'chat-projection.invalidated',
      owner: OWNER_CHAT,
      description: 'Main → renderer chat projection invalidation (event).',
      direction: 'main-to-renderer',
      tier: 'authenticated',
      schemaVersion: 1,
      validateRequest: (p: unknown): p is unknown => isV1Object(p),
      receipt: 'fire-and-forget',
      timeoutMs: 0,
      cancellable: false,
      requiresCorrelationId: false,
      requiresIdempotencyKey: false,
      redaction: 'internal',
      aliases: [
        { legacyChannel: 'chat-projection:invalidated-v1', deprecated: false },
      ],
    },
  ],
);

/**
 * The legacy alias channels the foundation catalog maps. Exported so parity
 * tests and the drift guard can mechanically compare the registry with the
 * preload allowlists (CD-029 generate/compare).
 */
export const FOUNDATION_ALIAS_CHANNELS: readonly string[] = Object.freeze(
  FOUNDATION_CONTRACTS.flatMap((c) => c.aliases.map((a) => a.legacyChannel)),
);

/**
 * Build a populated {@link ContractRegistry} from the foundation catalog. The
 * registry is the target IPC authority; it is constructed fresh so it stays a
 * pure, side-effect-free value with one owner (NN-COMPAT-002).
 */
export function buildFoundationContractRegistry(version = 1): ContractRegistry {
  const registry = new ContractRegistry(version);
  for (const contract of FOUNDATION_CONTRACTS) {
    registry.register(contract);
  }
  return registry;
}
