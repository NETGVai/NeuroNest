/**
 * Non-secret contracts that may cross the main/preload/renderer boundary.
 * Runtime schemas remain owned by shared modules; preload APIs expose only
 * these data shapes and never credential-bearing configuration.
 */
import type {
  AppBootstrapSnapshot,
  CloudProviderKeysMigrationConfigPayload,
  InspectorLayoutState,
  LaunchModeSettings,
  LegacyProviderKeyDeleteRequestV1,
  LegacyProviderKeyDeleteResultV1,
  LegacyProviderKeyListV1,
} from '../../shared/app-bootstrap-contracts.js';
import type {
  EntitlementStatusV1,
  InspectorLayoutUpdateRequestV1,
  LaunchModeUpdateRequestV1,
  ProxyCredentialStatusV1,
} from '../../shared/app-bootstrap-ipc-contracts.js';

export type {
  AppBootstrapSnapshot,
  AppEdition,
  CloudProviderKeyMigrationStatus,
  CloudProviderKeysMigrationConfigPayload,
  InspectorLayoutConfigPayload,
  InspectorLayoutState,
  InstallationClass,
  LaunchMode,
  LaunchModeConfigPayload,
  LaunchModeInstallationClassConfigPayload,
  LaunchModeResolution,
  LaunchModeSettings,
  LaunchModeSource,
  LegacyProviderKeyDeleteRequestV1,
  LegacyProviderKeyDeleteResultV1,
  LegacyProviderKeyListV1,
  LegacyProviderKeyRecordV1,
  LegacyProviderKeyStatusValue,
} from '../../shared/app-bootstrap-contracts.js';
export type {
  EntitlementAvailability,
  EntitlementStatusV1,
  InspectorLayoutUpdateRequestV1,
  LaunchModeUpdateRequestV1,
  ProxyCredentialAvailability,
  ProxyCredentialStatusV1,
} from '../../shared/app-bootstrap-ipc-contracts.js';

/** Renderer-visible, fixed-channel application bootstrap/settings methods. */
export interface AppBootstrapPreloadBridge {
  getAppBootstrap(): Promise<AppBootstrapSnapshot>;
  getLaunchModeSettings(): Promise<LaunchModeSettings>;
  updateLaunchMode(
    request: LaunchModeUpdateRequestV1,
  ): Promise<LaunchModeSettings>;
  getProxyCredentialStatus(): Promise<ProxyCredentialStatusV1>;
  getEntitlementStatus(): Promise<EntitlementStatusV1>;
  getCloudProviderKeyMigrationStatus(): Promise<CloudProviderKeysMigrationConfigPayload>;
  /**
   * Read the non-secret legacy provider inventory. The renderer receives only
   * masked presence and non-credential metadata — never the underlying key.
   */
  listLegacyProviderKeys(): Promise<LegacyProviderKeyListV1>;
  /**
   * Idempotent deletion of the legacy `apiKey` value from a saved provider
   * record. The renderer never observes the resolved credential value; only
   * an aggregate audit-count summary and success flags return.
   */
  deleteLegacyProviderKey(
    request: LegacyProviderKeyDeleteRequestV1,
  ): Promise<LegacyProviderKeyDeleteResultV1>;
  /**
   * Read the persisted Advanced Inspector layout. Callers are responsible for
   * ignoring the result in Classic mode (the shell never mounts the panel),
   * but the main-process service tolerates the call and repairs corrupt rows
   * without side effects on unrelated state.
   */
  getInspectorLayout(): Promise<InspectorLayoutState>;
  /**
   * Persist a proposed width/collapse pair for the Advanced Inspector. The
   * main-process service refuses the update while the resolved launch mode
   * is Classic (Requirement 2.8) and always clamps width to supported bounds
   * (Requirement 3.3).
   */
  updateInspectorLayout(
    request: InspectorLayoutUpdateRequestV1,
  ): Promise<InspectorLayoutState>;
}
