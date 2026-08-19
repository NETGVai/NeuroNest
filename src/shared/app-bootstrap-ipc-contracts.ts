import { z } from 'zod';

import {
  AppBootstrapSnapshotSchema,
  AppEditionSchema,
  CloudProviderKeysMigrationConfigPayloadSchema,
  InspectorLayoutStateSchema,
  LaunchModeSchema,
  LaunchModeSettingsSchema,
  LegacyProviderKeyDeleteRequestV1Schema,
  LegacyProviderKeyDeleteResultV1Schema,
  LegacyProviderKeyListV1Schema,
} from './app-bootstrap-contracts.js';

export const APP_BOOTSTRAP_GET_CHANNEL = 'app-bootstrap:get-v1' as const;
export const LAUNCH_MODE_SETTINGS_GET_CHANNEL =
  'launch-settings:get-mode-v1' as const;
export const LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL =
  'launch-settings:update-mode-v1' as const;
export const PROXY_CREDENTIAL_STATUS_GET_CHANNEL =
  'proxy-credential:get-status-v1' as const;
export const ENTITLEMENT_STATUS_GET_CHANNEL =
  'entitlements:get-status-v1' as const;
export const CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL =
  'cloud-provider-keys:get-migration-status-v1' as const;
export const LEGACY_PROVIDER_KEYS_LIST_CHANNEL =
  'legacy-provider-keys:list-records-v1' as const;
export const LEGACY_PROVIDER_KEYS_DELETE_CHANNEL =
  'legacy-provider-keys:delete-record-v1' as const;
export const INSPECTOR_LAYOUT_GET_CHANNEL =
  'inspector-layout:get-v1' as const;
export const INSPECTOR_LAYOUT_UPDATE_CHANNEL =
  'inspector-layout:update-v1' as const;

export const APP_BOOTSTRAP_IPC_CHANNELS = [
  APP_BOOTSTRAP_GET_CHANNEL,
  LAUNCH_MODE_SETTINGS_GET_CHANNEL,
  LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL,
  PROXY_CREDENTIAL_STATUS_GET_CHANNEL,
  ENTITLEMENT_STATUS_GET_CHANNEL,
  CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL,
  LEGACY_PROVIDER_KEYS_LIST_CHANNEL,
  LEGACY_PROVIDER_KEYS_DELETE_CHANNEL,
  INSPECTOR_LAYOUT_GET_CHANNEL,
  INSPECTOR_LAYOUT_UPDATE_CHANNEL,
] as const;
export type AppBootstrapIPCChannel = (typeof APP_BOOTSTRAP_IPC_CHANNELS)[number];

/** Optimistic, versioned launch-mode update accepted by the fixed IPC method. */
export const LaunchModeUpdateRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: LaunchModeSchema,
  expectedRevision: z.number().int().positive().finite(),
});
export type LaunchModeUpdateRequestV1 = z.infer<
  typeof LaunchModeUpdateRequestV1Schema
>;

/**
 * Optimistic, versioned Advanced Inspector layout update accepted by the
 * fixed IPC method. The renderer never crosses raw config payloads; it may
 * only propose the width/collapse pair for its currently mounted snapshot
 * revision. The main-process service clamps width to supported bounds and
 * rejects updates while the resolved launch mode is Classic.
 */
export const InspectorLayoutUpdateRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  widthDip: z.number().finite().positive(),
  collapsed: z.boolean(),
  expectedRevision: z.number().int().positive().finite(),
});
export type InspectorLayoutUpdateRequestV1 = z.infer<
  typeof InspectorLayoutUpdateRequestV1Schema
>;

export const ProxyCredentialAvailabilitySchema = z.enum([
  'available',
  'invalid',
  'expired',
]);
export type ProxyCredentialAvailability = z.infer<
  typeof ProxyCredentialAvailabilitySchema
>;

/** Renderer-safe credential metadata. It can never carry a credential or reference. */
export const ProxyCredentialStatusV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  status: ProxyCredentialAvailabilitySchema,
  checkedAt: z.string().datetime().nullable(),
});
export type ProxyCredentialStatusV1 = z.infer<
  typeof ProxyCredentialStatusV1Schema
>;

export const EntitlementAvailabilitySchema = z.enum([
  'available',
  'stale',
  'unavailable',
]);
export type EntitlementAvailability = z.infer<
  typeof EntitlementAvailabilitySchema
>;

/** Non-secret entitlement health only; provider/model catalogs remain main-owned. */
export const EntitlementStatusV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  status: EntitlementAvailabilitySchema,
  edition: AppEditionSchema.nullable(),
  revision: z.number().int().nonnegative().finite().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type EntitlementStatusV1 = z.infer<typeof EntitlementStatusV1Schema>;

/** Strict response schemas enforced before values cross into the renderer. */
export const AppBootstrapIPCResponseSchemas = {
  [APP_BOOTSTRAP_GET_CHANNEL]: AppBootstrapSnapshotSchema,
  [LAUNCH_MODE_SETTINGS_GET_CHANNEL]: LaunchModeSettingsSchema,
  [LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL]: LaunchModeSettingsSchema,
  [PROXY_CREDENTIAL_STATUS_GET_CHANNEL]: ProxyCredentialStatusV1Schema,
  [ENTITLEMENT_STATUS_GET_CHANNEL]: EntitlementStatusV1Schema,
  [CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL]:
    CloudProviderKeysMigrationConfigPayloadSchema,
  [LEGACY_PROVIDER_KEYS_LIST_CHANNEL]: LegacyProviderKeyListV1Schema,
  [LEGACY_PROVIDER_KEYS_DELETE_CHANNEL]: LegacyProviderKeyDeleteResultV1Schema,
  [INSPECTOR_LAYOUT_GET_CHANNEL]: InspectorLayoutStateSchema,
  [INSPECTOR_LAYOUT_UPDATE_CHANNEL]: InspectorLayoutStateSchema,
} as const;

/**
 * Strict request schemas enforced BEFORE the main-process service receives
 * anything from the renderer for channels that accept payloads.
 */
export const AppBootstrapIPCRequestSchemas = {
  [LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL]: LaunchModeUpdateRequestV1Schema,
  [LEGACY_PROVIDER_KEYS_DELETE_CHANNEL]: LegacyProviderKeyDeleteRequestV1Schema,
  [INSPECTOR_LAYOUT_UPDATE_CHANNEL]: InspectorLayoutUpdateRequestV1Schema,
} as const;
