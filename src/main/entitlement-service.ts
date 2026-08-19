import { z } from 'zod';

import {
  AppEditionSchema,
  type AppEdition,
} from '../shared/app-bootstrap-contracts.js';
import {
  EntitlementStatusV1Schema,
  type EntitlementStatusV1,
  type ProxyCredentialStatusV1,
} from '../shared/app-bootstrap-ipc-contracts.js';

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), 'Identifier must be normalized');
const DisplayNameSchema = z.string().trim().min(1).max(256);
const RevisionSchema = z.number().int().nonnegative().finite();
const TimestampSchema = z.string().datetime();

export const EntitledModelV1Schema = z.strictObject({
  modelId: IdentifierSchema,
  displayName: DisplayNameSchema.optional(),
});
export type EntitledModelV1 = z.infer<typeof EntitledModelV1Schema>;

export const EntitledProviderV1Schema = z
  .strictObject({
    providerId: IdentifierSchema,
    displayName: DisplayNameSchema.optional(),
    models: z.array(EntitledModelV1Schema).min(1),
  })
  .superRefine((provider, context) => {
    const seen = new Set<string>();
    provider.models.forEach((model, index) => {
      if (seen.has(model.modelId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate modelId '${model.modelId}'`,
          path: ['models', index, 'modelId'],
        });
      }
      seen.add(model.modelId);
    });
  });
export type EntitledProviderV1 = z.infer<typeof EntitledProviderV1Schema>;

/**
 * Quota information is advisory client metadata. Enforcement remains on the
 * NeuroNest service for every edition; the client must never infer entitlement
 * from a locally decremented value.
 */
export const EntitlementQuotaV1Schema = z.strictObject({
  enforcement: z.literal('server').default('server'),
  remaining: z.number().nonnegative().finite().optional(),
  resetAt: TimestampSchema.optional(),
});
export type EntitlementQuotaV1 = z.infer<typeof EntitlementQuotaV1Schema>;

/** Strict, versioned catalog returned by NeuroNest entitlement services. */
export const EntitlementSnapshotV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    edition: AppEditionSchema,
    revision: RevisionSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    providers: z.array(EntitledProviderV1Schema),
    quota: EntitlementQuotaV1Schema.optional(),
  })
  .superRefine((snapshot, context) => {
    if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.issuedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'expiresAt must be later than issuedAt',
        path: ['expiresAt'],
      });
    }

    const seen = new Set<string>();
    snapshot.providers.forEach((provider, index) => {
      if (seen.has(provider.providerId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate providerId '${provider.providerId}'`,
          path: ['providers', index, 'providerId'],
        });
      }
      seen.add(provider.providerId);
    });
  });
export type EntitlementSnapshotV1 = z.infer<typeof EntitlementSnapshotV1Schema>;

export const ProviderModelSelectionSchema = z.strictObject({
  providerId: IdentifierSchema,
  modelId: IdentifierSchema,
});
export type ProviderModelSelection = z.infer<typeof ProviderModelSelectionSchema>;

export const EntitlementRejectionCodeSchema = z.enum([
  'catalog_unavailable',
  'catalog_stale',
  'edition_changed',
  'provider_not_entitled',
  'model_not_entitled',
  'proxy_credential_unavailable',
]);
export type EntitlementRejectionCode = z.infer<
  typeof EntitlementRejectionCodeSchema
>;

export interface EntitlementPreflightAllowed {
  readonly allowed: true;
  readonly edition: AppEdition;
  readonly providerId: string;
  readonly modelId: string;
  readonly entitlementRevision: number;
  readonly quota?: EntitlementQuotaV1;
}

export interface EntitlementPreflightRejected {
  readonly allowed: false;
  readonly edition: AppEdition;
  readonly providerId: string;
  readonly modelId: string;
  readonly code: EntitlementRejectionCode;
  readonly explanation: string;
  readonly entitlementRevision: number | null;
  readonly suggestedSelections: readonly ProviderModelSelection[];
}

export type EntitlementPreflightResult =
  | EntitlementPreflightAllowed
  | EntitlementPreflightRejected;

export interface EntitlementSelectionExplanation {
  readonly available: boolean;
  readonly explanation: string;
  readonly code?: EntitlementRejectionCode;
  readonly suggestedSelections: readonly ProviderModelSelection[];
}

export interface EntitlementSnapshotLoader {
  loadSnapshot(input: {
    edition: AppEdition;
    currentRevision: number | null;
  }): Promise<unknown>;
}

export interface EntitlementServiceDependencies {
  readonly edition: AppEdition;
  readonly loader?: EntitlementSnapshotLoader;
  readonly readProxyCredentialStatus?: () =>
    | ProxyCredentialStatusV1
    | undefined;
  readonly now?: () => Date;
}

function cloneSnapshot(snapshot: EntitlementSnapshotV1): EntitlementSnapshotV1 {
  return EntitlementSnapshotV1Schema.parse(snapshot);
}

function snapshotFingerprint(snapshot: EntitlementSnapshotV1): string {
  return JSON.stringify(snapshot);
}

/**
 * Main-process authority for the active edition's entitlement catalog.
 *
 * Catalog replacement is revision-monotonic, edition changes invalidate the
 * cache immediately, and every invocation preflight checks the current clock,
 * edition, credential status (when supplied), and provider/model membership.
 * Provider/model catalogs intentionally have no renderer IPC representation.
 */
export class EntitlementService {
  private activeEdition: AppEdition;
  private snapshot: EntitlementSnapshotV1 | undefined;
  private readonly loader: EntitlementSnapshotLoader | undefined;
  private readonly readProxyCredentialStatus:
    | (() => ProxyCredentialStatusV1 | undefined)
    | undefined;
  private readonly now: () => Date;

  constructor(dependencies: EntitlementServiceDependencies) {
    this.activeEdition = AppEditionSchema.parse(dependencies.edition);
    this.loader = dependencies.loader;
    this.readProxyCredentialStatus = dependencies.readProxyCredentialStatus;
    this.now = dependencies.now ?? (() => new Date());
  }

  getEdition(): AppEdition {
    return this.activeEdition;
  }

  /** Invalidates the catalog only when the commercial edition actually changes. */
  setEdition(edition: AppEdition): boolean {
    const parsed = AppEditionSchema.parse(edition);
    if (parsed === this.activeEdition) return false;
    this.activeEdition = parsed;
    this.snapshot = undefined;
    return true;
  }

  /**
   * Installs a validated catalog without allowing revision rollback or
   * same-revision content replacement.
   */
  acceptSnapshot(rawSnapshot: unknown): EntitlementSnapshotV1 {
    const next = EntitlementSnapshotV1Schema.parse(rawSnapshot);
    if (next.edition !== this.activeEdition) {
      throw new Error(
        `Entitlement catalog edition '${next.edition}' does not match active edition '${this.activeEdition}'`,
      );
    }

    const current = this.snapshot;
    if (current && next.revision < current.revision) {
      throw new Error('Entitlement catalog revision cannot move backwards');
    }
    if (
      current &&
      next.revision === current.revision &&
      snapshotFingerprint(next) !== snapshotFingerprint(current)
    ) {
      throw new Error('Entitlement catalog revision conflicts with cached content');
    }

    this.snapshot = cloneSnapshot(next);
    return cloneSnapshot(this.snapshot);
  }

  /** Loads the active edition through the same protocol for every edition. */
  async refresh(): Promise<EntitlementSnapshotV1> {
    if (!this.loader) {
      throw new Error('Entitlement catalog loader is not configured');
    }

    const requestedEdition = this.activeEdition;
    const rawSnapshot = await this.loader.loadSnapshot({
      edition: requestedEdition,
      currentRevision:
        this.snapshot?.edition === requestedEdition ? this.snapshot.revision : null,
    });

    if (requestedEdition !== this.activeEdition) {
      throw new Error('Active edition changed while entitlement catalog was loading');
    }
    return this.acceptSnapshot(rawSnapshot);
  }

  getSnapshot(): EntitlementSnapshotV1 | undefined {
    return this.snapshot ? cloneSnapshot(this.snapshot) : undefined;
  }

  getRendererStatus(): EntitlementStatusV1 {
    const snapshot = this.snapshot;
    const status = snapshot
      ? this.isSnapshotCurrent(snapshot)
        ? 'available'
        : 'stale'
      : 'unavailable';

    return EntitlementStatusV1Schema.parse({
      schemaVersion: 1,
      status,
      edition: this.activeEdition,
      revision: snapshot?.revision ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
    });
  }

  /** Returns only currently usable provider/model choices. */
  listEntitledProviders(): readonly EntitledProviderV1[] {
    if (!this.snapshot || !this.isSnapshotCurrent(this.snapshot)) return [];
    return cloneSnapshot(this.snapshot).providers;
  }

  listEntitledSelections(): readonly ProviderModelSelection[] {
    return this.listEntitledProviders().flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
      })),
    );
  }

  /** Filters arbitrary provider/model options without changing caller metadata. */
  filterEntitledSelections<T extends ProviderModelSelection>(
    selections: readonly T[],
  ): T[] {
    const entitled = new Set(
      this.listEntitledSelections().map(
        (selection) => `${selection.providerId}\u0000${selection.modelId}`,
      ),
    );
    return selections.filter((selection) =>
      entitled.has(`${selection.providerId}\u0000${selection.modelId}`),
    );
  }

  explainSelection(
    rawSelection: ProviderModelSelection,
  ): EntitlementSelectionExplanation {
    const selection = ProviderModelSelectionSchema.parse(rawSelection);
    const snapshot = this.snapshot;
    const suggestions = this.listEntitledSelections();

    if (!snapshot) {
      return {
        available: false,
        code: 'catalog_unavailable',
        explanation: `Cloud model access for the ${this.activeEdition} edition is unavailable. Refresh entitlements and try again.`,
        suggestedSelections: [],
      };
    }
    if (!this.isSnapshotCurrent(snapshot)) {
      return {
        available: false,
        code: 'catalog_stale',
        explanation: `Cloud model access for the ${this.activeEdition} edition must be refreshed before this selection can be used.`,
        suggestedSelections: [],
      };
    }

    const provider = snapshot.providers.find(
      (candidate) => candidate.providerId === selection.providerId,
    );
    if (!provider) {
      return {
        available: false,
        code: 'provider_not_entitled',
        explanation: `Provider '${selection.providerId}' is not available for the ${this.activeEdition} edition. Select an available provider and model.`,
        suggestedSelections: suggestions,
      };
    }
    if (!provider.models.some((model) => model.modelId === selection.modelId)) {
      return {
        available: false,
        code: 'model_not_entitled',
        explanation: `Model '${selection.modelId}' is no longer available for provider '${selection.providerId}' on the ${this.activeEdition} edition. Select an available model.`,
        suggestedSelections: suggestions.filter(
          (candidate) => candidate.providerId === selection.providerId,
        ),
      };
    }

    return {
      available: true,
      explanation: `Provider '${selection.providerId}' and model '${selection.modelId}' are available for the ${this.activeEdition} edition.`,
      suggestedSelections: [],
    };
  }

  /**
   * Request-time authority check. A caller-provided edition mismatch first
   * invalidates the cached catalog, ensuring edition changes affect the next
   * cloud request and can never reuse prior-edition grants.
   */
  preflight(input: ProviderModelSelection & {
    edition: AppEdition;
  }): EntitlementPreflightResult {
    const edition = AppEditionSchema.parse(input.edition);
    const selection = ProviderModelSelectionSchema.parse({
      providerId: input.providerId,
      modelId: input.modelId,
    });
    if (edition !== this.activeEdition) {
      this.setEdition(edition);
      return this.rejected(
        selection,
        'edition_changed',
        `The active edition changed to ${edition}. Refresh entitlements before retrying this cloud request.`,
      );
    }

    const explanation = this.explainSelection(selection);
    if (!explanation.available) {
      return this.rejected(
        selection,
        explanation.code ?? 'catalog_unavailable',
        explanation.explanation,
        explanation.suggestedSelections,
      );
    }

    const credentialStatus = this.readProxyCredentialStatus?.();
    if (credentialStatus && credentialStatus.status !== 'available') {
      return this.rejected(
        selection,
        'proxy_credential_unavailable',
        'NeuroNest cloud access is unavailable. Restore authentication and try again.',
      );
    }

    const snapshot = this.snapshot!;
    const allowed: EntitlementPreflightAllowed = {
      allowed: true,
      edition: this.activeEdition,
      providerId: selection.providerId,
      modelId: selection.modelId,
      entitlementRevision: snapshot.revision,
      ...(snapshot.quota ? { quota: { ...snapshot.quota } } : {}),
    };
    return allowed;
  }

  private isSnapshotCurrent(snapshot: EntitlementSnapshotV1): boolean {
    return (
      snapshot.edition === this.activeEdition &&
      Date.parse(snapshot.expiresAt) > this.now().getTime()
    );
  }

  private rejected(
    selection: ProviderModelSelection,
    code: EntitlementRejectionCode,
    explanation: string,
    suggestedSelections: readonly ProviderModelSelection[] = [],
  ): EntitlementPreflightRejected {
    return {
      allowed: false,
      edition: this.activeEdition,
      providerId: selection.providerId,
      modelId: selection.modelId,
      code,
      explanation,
      entitlementRevision: this.snapshot?.revision ?? null,
      suggestedSelections: suggestedSelections.map((candidate) => ({ ...candidate })),
    };
  }
}

/** Descriptive alias for callers that treat this authority as a catalog cache. */
export { EntitlementService as EntitlementCatalogService };
