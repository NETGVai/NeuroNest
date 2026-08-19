import { randomUUID } from 'node:crypto';
import {
  CommandEnvelopeV1Schema,
  CommandTransportReceiptV1Schema,
  OpaqueResponseIdSchema,
  type CommandEnvelopeForV1,
  type CommandEnvelopeV1,
  type CommandTransportReceiptV1,
  type RendererAuthorityActionKindV1,
} from '../../harness/contracts';

/** Exact invoke channel for structured response authority commands. */
export const STRUCTURED_COMMAND_SUBMIT_CHANNEL = 'chat-command:submit-v1' as const;

export type CommandTransportRejectionCodeV1 = NonNullable<
  CommandTransportReceiptV1['rejectionCode']
>;

export interface StructuredCommandScopeSnapshotV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly branchId: string;
  readonly targetIdentity: string;
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly scopeDigest?: string;
}

/**
 * Projection-owned scope lookup. The IPC boundary compares this authoritative
 * snapshot with the submitted envelope before any command reaches an authority.
 */
export interface StructuredCommandScopeAuthorityV1 {
  getCurrentScope(
    command: Readonly<CommandEnvelopeV1>,
  ): Promise<StructuredCommandScopeSnapshotV1 | null>;
}

export type StructuredAuthorityDispatchResultV1 =
  | { readonly delivered: true }
  | {
      readonly delivered: false;
      readonly rejectionCode: CommandTransportRejectionCodeV1;
    };

type AuthorityMethod<K extends RendererAuthorityActionKindV1> = (
  command: Readonly<CommandEnvelopeForV1<K>>,
) => Promise<StructuredAuthorityDispatchResultV1 | void>;

/**
 * Closed authority port. A new action kind cannot become executable until an
 * explicit method is added here and to the exhaustive switch below.
 */
export interface StructuredCommandAuthorityV1 {
  submitPrompt: AuthorityMethod<'submit_prompt'>;
  navigate: AuthorityMethod<'navigate'>;
  open: AuthorityMethod<'open'>;
  apply: AuthorityMethod<'apply'>;
  approve: AuthorityMethod<'approve'>;
  retry: AuthorityMethod<'retry'>;
  cancel: AuthorityMethod<'cancel'>;
  resume: AuthorityMethod<'resume'>;
  branch: AuthorityMethod<'branch'>;
  edit: AuthorityMethod<'edit'>;
}

/** Minimal ipcMain-shaped interface for registration and disposal. */
export interface StructuredCommandIPCMain {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface RegisterStructuredCommandIPCOptions {
  readonly ipcMain: StructuredCommandIPCMain;
  readonly authority?: StructuredCommandAuthorityV1;
  readonly scopeAuthority?: StructuredCommandScopeAuthorityV1;
  readonly createReceiptId?: () => string;
}

export interface StructuredCommandIPCRegistration {
  readonly channel: typeof STRUCTURED_COMMAND_SUBMIT_CHANNEL;
  dispose(): void;
}

const NON_IDEMPOTENT_ACTIONS = new Set<RendererAuthorityActionKindV1>([
  'submit_prompt',
  'apply',
  'approve',
  'retry',
  'cancel',
  'resume',
  'branch',
  'edit',
]);

const AUTHORITY_REJECTION_CODES = new Set<CommandTransportRejectionCodeV1>([
  'authority_unavailable',
  'invalid_command',
  'stale_command',
  'scope_mismatch',
  'policy_denied',
  'transport_failure',
]);

function safeRequestId(raw: unknown, key: 'commandId' | 'actionId', fallback: string): string {
  try {
    if (typeof raw !== 'object' || raw === null) return fallback;
    const result = OpaqueResponseIdSchema.safeParse((raw as Record<string, unknown>)[key]);
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

function receipt(
  raw: unknown,
  createReceiptId: () => string,
  transportStatus: CommandTransportReceiptV1['transportStatus'],
  rejectionCode?: CommandTransportRejectionCodeV1,
): CommandTransportReceiptV1 {
  const candidate = {
    schemaVersion: 1 as const,
    commandId: safeRequestId(raw, 'commandId', 'invalid-command'),
    actionId: safeRequestId(raw, 'actionId', 'invalid-action'),
    receiptId: createReceiptId(),
    transportStatus,
    ...(rejectionCode === undefined ? {} : { rejectionCode }),
  };

  const parsed = CommandTransportReceiptV1Schema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // A caller-provided receipt factory is never allowed to break the IPC schema.
  return {
    ...candidate,
    receiptId: `receipt-${randomUUID()}`,
  };
}

function validateScope(
  command: CommandEnvelopeV1,
  current: StructuredCommandScopeSnapshotV1 | null,
): CommandTransportRejectionCodeV1 | undefined {
  if (
    current === null
    || current.schemaVersion !== 1
    || current.sessionId !== command.sessionId
    || current.branchId !== command.branchId
    || current.targetIdentity !== command.targetIdentity
  ) {
    return 'scope_mismatch';
  }

  if (
    current.projectionRevision !== command.expectedProjectionRevision
    || current.sourceRevision !== command.expectedSourceRevision
    || current.scopeDigest !== command.scopeDigest
  ) {
    return 'stale_command';
  }

  return undefined;
}

async function dispatchToOwningAuthority(
  authority: StructuredCommandAuthorityV1,
  command: CommandEnvelopeV1,
): Promise<StructuredAuthorityDispatchResultV1 | void> {
  switch (command.payload.actionKind) {
    case 'submit_prompt':
      return authority.submitPrompt(command as CommandEnvelopeForV1<'submit_prompt'>);
    case 'navigate':
      return authority.navigate(command as CommandEnvelopeForV1<'navigate'>);
    case 'open':
      return authority.open(command as CommandEnvelopeForV1<'open'>);
    case 'apply':
      return authority.apply(command as CommandEnvelopeForV1<'apply'>);
    case 'approve':
      return authority.approve(command as CommandEnvelopeForV1<'approve'>);
    case 'retry':
      return authority.retry(command as CommandEnvelopeForV1<'retry'>);
    case 'cancel':
      return authority.cancel(command as CommandEnvelopeForV1<'cancel'>);
    case 'resume':
      return authority.resume(command as CommandEnvelopeForV1<'resume'>);
    case 'branch':
      return authority.branch(command as CommandEnvelopeForV1<'branch'>);
    case 'edit':
      return authority.edit(command as CommandEnvelopeForV1<'edit'>);
    default:
      return assertNever(command.payload);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable structured command kind: ${typeof value}`);
}

/**
 * Registers the typed structured-command transport boundary.
 *
 * A delivered receipt means only that the owning authority accepted transport.
 * Domain success remains projection-owned. This registrar intentionally keeps
 * no replay/idempotency ledger; the exact envelope is passed to the authority,
 * which owns durable duplicate protection and confirmation semantics.
 */
export function registerStructuredCommandIPC(
  options: RegisterStructuredCommandIPCOptions,
): StructuredCommandIPCRegistration {
  const { ipcMain } = options;
  const createReceiptId = options.createReceiptId ?? (() => `receipt-${randomUUID()}`);

  try { ipcMain.removeHandler(STRUCTURED_COMMAND_SUBMIT_CHANNEL); } catch { /* first install */ }
  ipcMain.handle(
    STRUCTURED_COMMAND_SUBMIT_CHANNEL,
    async (_event: unknown, raw: unknown): Promise<CommandTransportReceiptV1> => {
      const parsed = CommandEnvelopeV1Schema.safeParse(raw);
      if (!parsed.success) {
        return receipt(raw, createReceiptId, 'rejected', 'invalid_command');
      }

      const command = parsed.data;
      if (
        NON_IDEMPOTENT_ACTIONS.has(command.payload.actionKind)
        && command.idempotencyKey === undefined
      ) {
        return receipt(command, createReceiptId, 'rejected', 'invalid_command');
      }

      if (options.authority === undefined || options.scopeAuthority === undefined) {
        return receipt(command, createReceiptId, 'rejected', 'authority_unavailable');
      }

      try {
        const current = await options.scopeAuthority.getCurrentScope(command);
        const scopeFailure = validateScope(command, current);
        if (scopeFailure !== undefined) {
          return receipt(command, createReceiptId, 'rejected', scopeFailure);
        }

        const result = await dispatchToOwningAuthority(options.authority, command);
        if (result !== undefined && !result.delivered) {
          const rejectionCode = AUTHORITY_REJECTION_CODES.has(result.rejectionCode)
            ? result.rejectionCode
            : 'transport_failure';
          return receipt(command, createReceiptId, 'rejected', rejectionCode);
        }

        return receipt(command, createReceiptId, 'delivered');
      } catch {
        // Never serialize authority exceptions: they may contain paths, prompts,
        // command text, URLs, or secrets. The renderer receives only a typed code.
        return receipt(command, createReceiptId, 'rejected', 'transport_failure');
      }
    },
  );

  let disposed = false;
  const registration: StructuredCommandIPCRegistration = {
    channel: STRUCTURED_COMMAND_SUBMIT_CHANNEL,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try { ipcMain.removeHandler(STRUCTURED_COMMAND_SUBMIT_CHANNEL); } catch { /* already removed */ }
    },
  };
  return registration;
}