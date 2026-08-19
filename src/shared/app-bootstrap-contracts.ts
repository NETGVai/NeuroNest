import { z } from 'zod';

/** Persisted graphical application modes. Process GUI/CLI launch kind is separate. */
export const LaunchModeSchema = z.enum(['classic', 'advanced']);
export type LaunchMode = z.infer<typeof LaunchModeSchema>;

export const LaunchModeSourceSchema = z.enum([
  'saved',
  'legacy-default',
  'corrupt-fallback',
]);
export type LaunchModeSource = z.infer<typeof LaunchModeSourceSchema>;

export const InstallationClassSchema = z.enum(['new', 'existing']);
export type InstallationClass = z.infer<typeof InstallationClassSchema>;

const RevisionSchema = z.number().int().positive().finite();
const TimestampSchema = z.string().datetime();
const NullableTimestampSchema = TimestampSchema.nullable();

export const LaunchModeResolutionSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('selection-required'),
    installationClass: z.literal('new'),
  }),
  z.strictObject({
    state: z.literal('resolved'),
    mode: LaunchModeSchema,
    source: LaunchModeSourceSchema,
  }),
]);
export type LaunchModeResolution = z.infer<typeof LaunchModeResolutionSchema>;

export const LaunchModeSettingsSchema = z.strictObject({
  mode: LaunchModeSchema.nullable(),
  revision: RevisionSchema,
  updatedAt: NullableTimestampSchema,
});
export type LaunchModeSettings = z.infer<typeof LaunchModeSettingsSchema>;

export const InspectorLayoutStateSchema = z.strictObject({
  widthDip: z.number().finite().positive(),
  collapsed: z.boolean(),
  revision: RevisionSchema,
});
export type InspectorLayoutState = z.infer<typeof InspectorLayoutStateSchema>;

export const AppEditionSchema = z.enum([
  'community',
  'professional',
  'enterprise',
]);
export type AppEdition = z.infer<typeof AppEditionSchema>;

const BootstrapBaseShape = {
  launchModeSource: LaunchModeSourceSchema,
  edition: AppEditionSchema,
  themeRevision: z.number().int().nonnegative().finite(),
  activeProjectId: z.string().trim().min(1).max(512).optional(),
};

/**
 * Non-secret renderer bootstrap snapshot. The discriminated shape prevents a
 * Classic bootstrap from carrying or mutating Advanced Inspector state.
 */
export const AppBootstrapSnapshotSchema = z.discriminatedUnion('launchMode', [
  z.strictObject({
    launchMode: z.literal('classic'),
    ...BootstrapBaseShape,
  }),
  z.strictObject({
    launchMode: z.literal('advanced'),
    ...BootstrapBaseShape,
    inspector: InspectorLayoutStateSchema.optional(),
  }),
]);
export type AppBootstrapSnapshot = z.infer<typeof AppBootstrapSnapshotSchema>;

export const UI_LAUNCH_MODE_CONFIG_KEY = 'ui:launch-mode:v1' as const;
export const UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY =
  'ui:launch-mode-installation-class:v1' as const;
export const UI_INSPECTOR_LAYOUT_CONFIG_KEY = 'ui:inspector-layout:v1' as const;
export const CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY =
  'migration:cloud-provider-keys:v1' as const;

export const ENHANCED_CHAT_UI_CONFIG_KEYS = {
  launchMode: UI_LAUNCH_MODE_CONFIG_KEY,
  launchModeInstallationClass: UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY,
  inspectorLayout: UI_INSPECTOR_LAYOUT_CONFIG_KEY,
  cloudProviderKeysMigration: CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY,
} as const;

export const EnhancedChatUiConfigKeySchema = z.enum([
  UI_LAUNCH_MODE_CONFIG_KEY,
  UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY,
  UI_INSPECTOR_LAYOUT_CONFIG_KEY,
  CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY,
]);
export type EnhancedChatUiConfigKey = z.infer<
  typeof EnhancedChatUiConfigKeySchema
>;

/** Payload stored under `ui:launch-mode:v1`. */
export const LaunchModeConfigPayloadSchema = LaunchModeSettingsSchema;
export type LaunchModeConfigPayload = LaunchModeSettings;

/** Payload stored under `ui:launch-mode-installation-class:v1`. */
export const LaunchModeInstallationClassConfigPayloadSchema = z.strictObject({
  installationClass: InstallationClassSchema,
  revision: RevisionSchema,
});
export type LaunchModeInstallationClassConfigPayload = z.infer<
  typeof LaunchModeInstallationClassConfigPayloadSchema
>;

/** Payload stored under `ui:inspector-layout:v1`. */
export const InspectorLayoutConfigPayloadSchema = InspectorLayoutStateSchema;
export type InspectorLayoutConfigPayload = InspectorLayoutState;

export const CloudProviderKeyMigrationStatusSchema = z.enum([
  'not-started',
  'complete',
  'partial',
  'failed',
]);
export type CloudProviderKeyMigrationStatus = z.infer<
  typeof CloudProviderKeyMigrationStatusSchema
>;

/**
 * Non-secret sentinel for a legacy provider record that has been disabled for
 * cloud routing. Cloud adapter construction must ignore any record whose
 * `legacyKeyStatus` equals this sentinel even if a subsequent migration run
 * fails. Kept in sync with `src/main/legacy-provider-key-migration-service.ts`.
 */
export const LEGACY_KEY_STATUS_UNUSED_VALUE = 'legacy-unused' as const;
export const LegacyProviderKeyStatusSchema = z.enum([
  LEGACY_KEY_STATUS_UNUSED_VALUE,
]);
export type LegacyProviderKeyStatusValue = z.infer<
  typeof LegacyProviderKeyStatusSchema
>;

/**
 * Aggregate-only payload stored under `migration:cloud-provider-keys:v1`.
 * It deliberately contains no credential references, provider keys, or values.
 */
export const CloudProviderKeysMigrationConfigPayloadSchema = z
  .strictObject({
    status: CloudProviderKeyMigrationStatusSchema,
    revision: RevisionSchema,
    recordsExamined: z.number().int().nonnegative().finite(),
    recordsDisabled: z.number().int().nonnegative().finite(),
    selectionsPreserved: z.number().int().nonnegative().finite(),
    recordsRemoved: z.number().int().nonnegative().finite(),
    failureCount: z.number().int().nonnegative().finite(),
    startedAt: NullableTimestampSchema,
    completedAt: NullableTimestampSchema,
  })
  .superRefine((payload, context) => {
    const boundedCounts = [
      ['recordsDisabled', payload.recordsDisabled],
      ['selectionsPreserved', payload.selectionsPreserved],
      ['recordsRemoved', payload.recordsRemoved],
      ['failureCount', payload.failureCount],
    ] as const;

    for (const [field, value] of boundedCounts) {
      if (value > payload.recordsExamined) {
        context.addIssue({
          code: 'custom',
          message: `${field} cannot exceed recordsExamined`,
          path: [field],
        });
      }
    }
  });
export type CloudProviderKeysMigrationConfigPayload = z.infer<
  typeof CloudProviderKeysMigrationConfigPayloadSchema
>;

/** Closed key-to-payload mapping for main-process config access. */
export interface EnhancedChatUiConfigPayloadByKey {
  readonly 'ui:launch-mode:v1': LaunchModeConfigPayload;
  readonly 'ui:launch-mode-installation-class:v1': LaunchModeInstallationClassConfigPayload;
  readonly 'ui:inspector-layout:v1': InspectorLayoutConfigPayload;
  readonly 'migration:cloud-provider-keys:v1': CloudProviderKeysMigrationConfigPayload;
}

export const EnhancedChatUiConfigPayloadSchemas = {
  [UI_LAUNCH_MODE_CONFIG_KEY]: LaunchModeConfigPayloadSchema,
  [UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY]:
    LaunchModeInstallationClassConfigPayloadSchema,
  [UI_INSPECTOR_LAYOUT_CONFIG_KEY]: InspectorLayoutConfigPayloadSchema,
  [CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY]:
    CloudProviderKeysMigrationConfigPayloadSchema,
} as const;

/**
 * Renderer-safe legacy provider inventory record. Contains only display
 * metadata and a fixed-length mask, never the actual `apiKey` value.
 * Emitted by the fixed `legacy-provider-keys:list-records-v1` IPC channel.
 */
export const LegacyProviderKeyRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  providerId: z.string().min(1).max(256),
  providerType: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  hasApiKey: z.boolean(),
  apiKeyMask: z.string().max(16).nullable(),
  legacyKeyStatus: LegacyProviderKeyStatusSchema.nullable(),
  preservedSelection: z.strictObject({
    providerId: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256).nullable(),
  }),
});
export type LegacyProviderKeyRecordV1 = z.infer<
  typeof LegacyProviderKeyRecordV1Schema
>;

/** Fixed non-secret listing envelope returned to the renderer. */
export const LegacyProviderKeyListV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.array(LegacyProviderKeyRecordV1Schema).max(64),
});
export type LegacyProviderKeyListV1 = z.infer<
  typeof LegacyProviderKeyListV1Schema
>;

/**
 * Delete-request payload the renderer may submit. Only carries a stable
 * provider identifier; no credential material or references may be included.
 */
export const LegacyProviderKeyDeleteRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  providerId: z.string().trim().min(1).max(256),
});
export type LegacyProviderKeyDeleteRequestV1 = z.infer<
  typeof LegacyProviderKeyDeleteRequestV1Schema
>;

/**
 * Renderer-safe outcome. `payload` is the aggregate migration audit record
 * with non-secret counts only. The deleted `apiKey` value is never echoed.
 */
export const LegacyProviderKeyDeleteResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  deleted: z.boolean(),
  alreadyRemoved: z.boolean(),
  payload: CloudProviderKeysMigrationConfigPayloadSchema,
});
export type LegacyProviderKeyDeleteResultV1 = z.infer<
  typeof LegacyProviderKeyDeleteResultV1Schema
>;
