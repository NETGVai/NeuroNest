import type { IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

import {
  LegacyProviderKeyDeleteRequestV1Schema,
  type AppBootstrapSnapshot,
  type CloudProviderKeysMigrationConfigPayload,
  type InspectorLayoutState,
  type LaunchModeSettings,
  type LegacyProviderKeyDeleteRequestV1,
  type LegacyProviderKeyDeleteResultV1,
  type LegacyProviderKeyListV1,
} from '../shared/app-bootstrap-contracts.js';
import {
  APP_BOOTSTRAP_GET_CHANNEL,
  APP_BOOTSTRAP_IPC_CHANNELS,
  AppBootstrapIPCResponseSchemas,
  CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL,
  ENTITLEMENT_STATUS_GET_CHANNEL,
  INSPECTOR_LAYOUT_GET_CHANNEL,
  INSPECTOR_LAYOUT_UPDATE_CHANNEL,
  InspectorLayoutUpdateRequestV1Schema,
  LAUNCH_MODE_SETTINGS_GET_CHANNEL,
  LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL,
  LaunchModeUpdateRequestV1Schema,
  LEGACY_PROVIDER_KEYS_DELETE_CHANNEL,
  LEGACY_PROVIDER_KEYS_LIST_CHANNEL,
  PROXY_CREDENTIAL_STATUS_GET_CHANNEL,
  type EntitlementStatusV1,
  type InspectorLayoutUpdateRequestV1,
  type LaunchModeUpdateRequestV1,
  type ProxyCredentialStatusV1,
} from '../shared/app-bootstrap-ipc-contracts.js';

export interface AppBootstrapIPCMain {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, request?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

/** Main-owned service ports. Implementations may read config or credentials; IPC cannot. */
export interface AppBootstrapIPCServices {
  readBootstrap(): Promise<AppBootstrapSnapshot> | AppBootstrapSnapshot;
  readLaunchModeSettings(): Promise<LaunchModeSettings> | LaunchModeSettings;
  updateLaunchMode(
    request: LaunchModeUpdateRequestV1,
  ): Promise<LaunchModeSettings> | LaunchModeSettings;
  readProxyCredentialStatus():
    | Promise<ProxyCredentialStatusV1>
    | ProxyCredentialStatusV1;
  readEntitlementStatus(): Promise<EntitlementStatusV1> | EntitlementStatusV1;
  readCloudProviderKeyMigrationStatus():
    | Promise<CloudProviderKeysMigrationConfigPayload>
    | CloudProviderKeysMigrationConfigPayload;
  /**
   * List saved legacy provider records without echoing `apiKey` values. Every
   * returned record must be schema-valid; malformed rows must be filtered out
   * by the underlying service so the IPC boundary never leaks raw config.
   */
  listLegacyProviderKeys():
    | Promise<LegacyProviderKeyListV1>
    | LegacyProviderKeyListV1;
  /**
   * Idempotent, transactional deletion of a single legacy provider key. The
   * IPC layer strips credential values; only aggregate migration audit and
   * deleted/alreadyRemoved flags cross back to the renderer.
   */
  deleteLegacyProviderKey(
    request: LegacyProviderKeyDeleteRequestV1,
  ):
    | Promise<LegacyProviderKeyDeleteResultV1>
    | LegacyProviderKeyDeleteResultV1;
  /**
   * Read the persisted Advanced Inspector layout. Callable in either launch
   * mode; the service repairs corrupt rows in place and returns the clamped
   * default when no row exists yet. Classic renderers should not call this
   * because they never mount the Inspector, but the service is safe.
   */
  readInspectorLayout(): Promise<InspectorLayoutState> | InspectorLayoutState;
  /**
   * Persist a proposed width/collapse pair. Only accepted while the resolved
   * launch mode is Advanced; Classic requests are refused before touching
   * config so Classic startup cannot overwrite the persisted Advanced state.
   */
  updateInspectorLayout(
    request: InspectorLayoutUpdateRequestV1,
  ): Promise<InspectorLayoutState> | InspectorLayoutState;
}

export interface AppBootstrapIPCDependencies extends AppBootstrapIPCServices {
  ipcMain: AppBootstrapIPCMain;
}

export interface AppBootstrapIPCRegistration {
  readonly channels: typeof APP_BOOTSTRAP_IPC_CHANNELS;
  dispose(): void;
}

const registrations = new WeakMap<object, AppBootstrapIPCRegistration>();

async function readStrict<TSchema extends z.ZodType>(
  schema: TSchema,
  operation: () => Promise<unknown> | unknown,
  failureMessage: string,
): Promise<z.output<TSchema>> {
  try {
    return schema.parse(await operation());
  } catch {
    // Never forward service errors: they can contain credential material or raw config.
    throw new Error(failureMessage);
  }
}

/**
 * Registers the closed V1 bootstrap/settings boundary. Every response is parsed
 * through a strict non-secret schema before it can cross into the renderer.
 */
export function registerAppBootstrapIPC(
  dependencies: AppBootstrapIPCDependencies,
): AppBootstrapIPCRegistration {
  registrations.get(dependencies.ipcMain as object)?.dispose();

  let disposed = false;
  let registration: AppBootstrapIPCRegistration;

  const install = (
    channel: (typeof APP_BOOTSTRAP_IPC_CHANNELS)[number],
    handler: (event: IpcMainInvokeEvent, request?: unknown) => unknown,
  ): void => {
    try {
      dependencies.ipcMain.removeHandler(channel);
    } catch {}
    dependencies.ipcMain.handle(channel, handler);
  };

  install(APP_BOOTSTRAP_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[APP_BOOTSTRAP_GET_CHANNEL],
      () => dependencies.readBootstrap(),
      'Application bootstrap is unavailable',
    ),
  );

  install(LAUNCH_MODE_SETTINGS_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[LAUNCH_MODE_SETTINGS_GET_CHANNEL],
      () => dependencies.readLaunchModeSettings(),
      'Launch-mode settings are unavailable',
    ),
  );

  install(LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL, (_event, rawRequest) => {
    const request = LaunchModeUpdateRequestV1Schema.safeParse(rawRequest);
    if (!request.success) {
      throw new Error('Invalid launch-mode update request');
    }
    return readStrict(
      AppBootstrapIPCResponseSchemas[LAUNCH_MODE_SETTINGS_UPDATE_CHANNEL],
      () => dependencies.updateLaunchMode(request.data),
      'Unable to update launch-mode settings',
    );
  });

  install(PROXY_CREDENTIAL_STATUS_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[PROXY_CREDENTIAL_STATUS_GET_CHANNEL],
      () => dependencies.readProxyCredentialStatus(),
      'Proxy credential status is unavailable',
    ),
  );

  install(ENTITLEMENT_STATUS_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[ENTITLEMENT_STATUS_GET_CHANNEL],
      () => dependencies.readEntitlementStatus(),
      'Entitlement status is unavailable',
    ),
  );

  install(CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[
        CLOUD_PROVIDER_KEY_MIGRATION_STATUS_GET_CHANNEL
      ],
      () => dependencies.readCloudProviderKeyMigrationStatus(),
      'Cloud provider key migration status is unavailable',
    ),
  );

  install(LEGACY_PROVIDER_KEYS_LIST_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[LEGACY_PROVIDER_KEYS_LIST_CHANNEL],
      () => dependencies.listLegacyProviderKeys(),
      'Legacy provider key inventory is unavailable',
    ),
  );

  install(LEGACY_PROVIDER_KEYS_DELETE_CHANNEL, (_event, rawRequest) => {
    const request = LegacyProviderKeyDeleteRequestV1Schema.safeParse(rawRequest);
    if (!request.success) {
      // Do not echo the received payload — it may include user-supplied text.
      throw new Error('Invalid legacy provider key delete request');
    }
    return readStrict(
      AppBootstrapIPCResponseSchemas[LEGACY_PROVIDER_KEYS_DELETE_CHANNEL],
      () => dependencies.deleteLegacyProviderKey(request.data),
      'Unable to delete legacy provider key',
    );
  });

  install(INSPECTOR_LAYOUT_GET_CHANNEL, () =>
    readStrict(
      AppBootstrapIPCResponseSchemas[INSPECTOR_LAYOUT_GET_CHANNEL],
      () => dependencies.readInspectorLayout(),
      'Inspector layout is unavailable',
    ),
  );

  install(INSPECTOR_LAYOUT_UPDATE_CHANNEL, (_event, rawRequest) => {
    const request = InspectorLayoutUpdateRequestV1Schema.safeParse(rawRequest);
    if (!request.success) {
      // Do not echo the payload — proposed width/collapse values are user-supplied.
      throw new Error('Invalid Inspector layout update request');
    }
    return readStrict(
      AppBootstrapIPCResponseSchemas[INSPECTOR_LAYOUT_UPDATE_CHANNEL],
      () => dependencies.updateInspectorLayout(request.data),
      'Unable to update Inspector layout',
    );
  });

  registration = {
    channels: APP_BOOTSTRAP_IPC_CHANNELS,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (registrations.get(dependencies.ipcMain as object) !== registration) {
        return;
      }
      for (const channel of APP_BOOTSTRAP_IPC_CHANNELS) {
        try {
          dependencies.ipcMain.removeHandler(channel);
        } catch {}
      }
      registrations.delete(dependencies.ipcMain as object);
    },
  };

  registrations.set(dependencies.ipcMain as object, registration);
  return registration;
}
