import type { BrowserWindow } from 'electron';

import {
  AppBootstrapSnapshotSchema,
  type AppBootstrapSnapshot,
  type InspectorLayoutState,
  type LaunchMode,
  type LaunchModeResolution,
} from '../shared/app-bootstrap-contracts.js';
import type {
  InspectorLayoutUpdateRequestV1,
  LaunchModeUpdateRequestV1,
} from '../shared/app-bootstrap-ipc-contracts.js';
import type { AppBootstrapIPCServices } from './app-bootstrap-ipc.js';
import type { InspectorLayoutService } from './inspector-layout-service.js';
import type { LaunchModeService } from './launch-mode-service.js';

type ResolvedLaunchMode = Extract<LaunchModeResolution, { state: 'resolved' }>;
type LaunchModeBootstrapServices = Pick<
  AppBootstrapIPCServices,
  | 'readBootstrap'
  | 'readLaunchModeSettings'
  | 'updateLaunchMode'
  | 'readInspectorLayout'
  | 'updateInspectorLayout'
>;

export type LaunchModeWindowRoute = 'mode-selector' | 'workspace';

export interface LaunchModeWindowGateOptions {
  launchModeService: Pick<
    LaunchModeService,
    'resolve' | 'getSettings' | 'updateMode'
  >;
  /**
   * Optional Advanced Inspector layout authority. When provided, the gate
   * reads the persisted layout for Advanced bootstraps and forwards the
   * fixed-boundary `readInspectorLayout`/`updateInspectorLayout` services.
   * When absent, the bootstrap omits the `inspector` field and the layout
   * IPC methods report the layout as unavailable.
   */
  inspectorLayoutService?: Pick<
    InspectorLayoutService,
    'getLayout' | 'updateLayout'
  >;
  selectorFile: string;
  workspaceFile: string;
  createBootstrapSnapshot(
    resolution: ResolvedLaunchMode,
    context: { inspector?: InspectorLayoutState },
  ): AppBootstrapSnapshot;
  schedule?: (work: () => void) => void;
  onWorkspaceLoaded?: (window: BrowserWindow) => Promise<void> | void;
  onWorkspaceLoadError?: (error: unknown) => void;
}

/**
 * Main-process authority for choosing which renderer document a BrowserWindow
 * may load. The restricted selector receives only fixed IPC methods; the
 * production workspace is not loaded until a persisted mode resolves.
 */
export class LaunchModeWindowGate {
  readonly appBootstrapServices: LaunchModeBootstrapServices;

  private bootstrapSnapshot: AppBootstrapSnapshot | null = null;
  private selectionWindow: BrowserWindow | null = null;
  private workspaceLoadScheduled = false;
  private readonly schedule: (work: () => void) => void;

  constructor(private readonly options: LaunchModeWindowGateOptions) {
    this.schedule = options.schedule ?? ((work) => setTimeout(work, 0));
    this.appBootstrapServices = {
      readBootstrap: () => this.readBootstrap(),
      readLaunchModeSettings: () => this.options.launchModeService.getSettings(),
      updateLaunchMode: (request) => this.updateLaunchMode(request),
      readInspectorLayout: () => this.readInspectorLayout(),
      updateInspectorLayout: (request) => this.updateInspectorLayout(request),
    };
  }

  /**
   * Reports the last resolved launch mode. `null` before the first workspace
   * bootstrap resolves. Consumed by dependents (e.g. the Inspector layout
   * service) that must refuse writes while a Classic mode is active.
   */
  getCurrentLaunchMode(): LaunchMode | null {
    return this.bootstrapSnapshot ? this.bootstrapSnapshot.launchMode : null;
  }

  /** Resolve mode after IPC registration, then load only the permitted surface. */
  async resolveAndLoad(window: BrowserWindow): Promise<LaunchModeWindowRoute> {
    const resolution = this.options.launchModeService.resolve();
    if (resolution.state === 'selection-required') {
      this.bootstrapSnapshot = null;
      this.selectionWindow = window;
      await window.loadFile(this.options.selectorFile);
      return 'mode-selector';
    }

    this.selectionWindow = null;
    this.bootstrapSnapshot = this.createSnapshot(resolution);
    await window.loadFile(this.options.workspaceFile);
    await this.options.onWorkspaceLoaded?.(window);
    return 'workspace';
  }

  private readBootstrap(): AppBootstrapSnapshot {
    if (this.bootstrapSnapshot) return this.bootstrapSnapshot;

    const resolution = this.options.launchModeService.resolve();
    if (resolution.state === 'selection-required') {
      throw new Error('Launch mode selection is required before workspace bootstrap');
    }

    this.bootstrapSnapshot = this.createSnapshot(resolution);
    return this.bootstrapSnapshot;
  }

  private updateLaunchMode(request: LaunchModeUpdateRequestV1) {
    const settings = this.options.launchModeService.updateMode(
      request.mode,
      request.expectedRevision,
    );

    // If a first-run selector window is open, transition to workspace.
    if (this.selectionWindow && !this.selectionWindow.isDestroyed()) {
      this.scheduleWorkspaceLoad(this.selectionWindow);
    }

    // Hot-swap: notify the running workspace window so it can apply the mode
    // change immediately without requiring a restart.
    if (this.bootstrapSnapshot && settings.mode) {
      this.bootstrapSnapshot = {
        ...this.bootstrapSnapshot,
        launchMode: settings.mode,
      } as AppBootstrapSnapshot;

      // Find the workspace window (any non-selector window that has loaded)
      const { BrowserWindow } = require('electron') as typeof import('electron');
      const allWindows = BrowserWindow.getAllWindows();
      for (const win of allWindows) {
        if (!win.isDestroyed() && win !== this.selectionWindow) {
          win.webContents.send('launch-mode:changed', settings.mode);
        }
      }
    }

    return settings;
  }

  private scheduleWorkspaceLoad(window: BrowserWindow): void {
    if (this.workspaceLoadScheduled) return;
    this.workspaceLoadScheduled = true;
    this.schedule(() => {
      this.workspaceLoadScheduled = false;
      if (window.isDestroyed() || this.selectionWindow !== window) return;
      void this.resolveAndLoad(window).catch((error) => {
        this.options.onWorkspaceLoadError?.(error);
      });
    });
  }

  private createSnapshot(resolution: ResolvedLaunchMode): AppBootstrapSnapshot {
    const inspector =
      resolution.mode === 'advanced' && this.options.inspectorLayoutService
        ? this.options.inspectorLayoutService.getLayout()
        : undefined;
    return AppBootstrapSnapshotSchema.parse(
      this.options.createBootstrapSnapshot(resolution, { inspector }),
    );
  }

  private readInspectorLayout(): InspectorLayoutState {
    if (!this.options.inspectorLayoutService) {
      throw new Error('Inspector layout is unavailable');
    }
    return this.options.inspectorLayoutService.getLayout();
  }

  private updateInspectorLayout(
    request: InspectorLayoutUpdateRequestV1,
  ): InspectorLayoutState {
    if (!this.options.inspectorLayoutService) {
      throw new Error('Inspector layout is unavailable');
    }
    return this.options.inspectorLayoutService.updateLayout({
      widthDip: request.widthDip,
      collapsed: request.collapsed,
      expectedRevision: request.expectedRevision,
    });
  }
}
