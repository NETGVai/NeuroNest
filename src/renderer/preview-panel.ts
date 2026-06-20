/**
 * LivePreviewPanel — renders a live app preview adjacent to the chat interface.
 *
 * Uses an iframe (webview) to display the user's web application, with:
 * - Automatic refresh on file changes (HTML/CSS/JS)
 * - Dev server detection (ports 3000, 5173, 8080)
 * - Static file serving fallback when no dev server is running
 * - WebContainer sandbox preview URL connection (sandbox:preview-url IPC)
 *
 * Communicates with the main process via window.electronAPI IPC bridge
 * for file watching, static server management, and sandbox lifecycle.
 *
 * Requirements: 9.3, 10.3, 17.1, 17.2, 17.3, 17.4
 */

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export interface PreviewState {
  /** Whether the preview panel is currently open. */
  isOpen: boolean;
  /** The URL currently loaded in the preview. */
  currentUrl: string | null;
  /** Whether a dev server was detected. */
  devServerDetected: boolean;
  /** The project directory being previewed. */
  projectDir: string | null;
  /** The active WebContainer sandbox instance ID, if connected. */
  sandboxInstanceId: string | null;
  /** Whether the preview is connected to a WebContainer sandbox. */
  isSandboxPreview: boolean;
}

// ─── Panel Class ────────────────────────────────────────────────

export class LivePreviewPanel {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private state: PreviewState = {
    isOpen: false,
    currentUrl: null,
    devServerDetected: false,
    projectDir: null,
    sandboxInstanceId: null,
    isSandboxPreview: false,
  };
  private fileChangeHandler: ((...args: unknown[]) => void) | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Open the preview panel and start watching for changes. */
  async open(projectDir: string): Promise<void> {
    this.state.projectDir = projectDir;
    this.state.isOpen = true;

    this.render();

    // Start file watching via main process
    this.setupFileWatcher();

    // Detect dev server or start static server
    await this.detectAndNavigate();
  }

  /** Close the preview panel and clean up resources. */
  close(): void {
    this.state.isOpen = false;
    this.state.currentUrl = null;
    this.state.projectDir = null;
    this.state.devServerDetected = false;

    // Terminate sandbox instance if connected
    if (this.state.sandboxInstanceId) {
      eapi().invoke('sandbox:terminate', { instanceId: this.state.sandboxInstanceId }).catch(() => {});
      this.state.sandboxInstanceId = null;
      this.state.isSandboxPreview = false;
    }

    this.cleanupFileWatcher();
    this.stopRefreshInterval();

    // Tell main process to stop watching and serving
    eapi().invoke('preview:stop').catch(() => {});

    this.container.innerHTML = '';
    this.iframe = null;
    this.toolbarEl = null;
    this.statusEl = null;
  }

  /** Refresh the preview content. */
  refresh(): void {
    if (!this.iframe || !this.state.currentUrl) return;

    // Force refresh by appending timestamp to bypass cache
    const url = new URL(this.state.currentUrl);
    url.searchParams.set('_t', String(Date.now()));
    this.iframe.src = url.toString();

    this.updateStatus('Refreshed');
  }

  /** Get the current panel state. */
  getState(): PreviewState {
    return { ...this.state };
  }

  // ─── WebContainer Sandbox Connection ──────────────────────────

  /**
   * Connect to a WebContainer sandbox preview URL.
   * Requirement 9.3: Expose running application via local URL for preview
   * Requirement 10.3: Launch app in WebContainer and display live preview
   *
   * Boots a sandbox instance (if no instanceId provided), installs dependencies,
   * starts the dev server, and navigates the iframe to the preview URL.
   *
   * @param instanceId - Optional existing sandbox instance ID. If omitted, boots a new instance.
   */
  async connectToSandbox(instanceId?: string): Promise<void> {
    this.state.isOpen = true;
    this.state.isSandboxPreview = true;

    this.render();
    this.updateStatus('Booting sandbox…');

    try {
      // Boot a new instance if none provided
      let activeInstanceId = instanceId;

      if (!activeInstanceId) {
        const bootResult = await eapi().invoke('sandbox:boot') as
          | { id: string; status: string }
          | { error: true; code: string; message: string };

        if ('error' in bootResult) {
          this.updateStatus(`Error: ${bootResult.message}`);
          return;
        }

        activeInstanceId = bootResult.id;
      }

      this.state.sandboxInstanceId = activeInstanceId;
      this.updateStatus('Installing dependencies & starting dev server…');

      // Get the preview URL (handles install + dev server start)
      const previewResult = await eapi().invoke('sandbox:preview-url', {
        instanceId: activeInstanceId,
      }) as { previewUrl: string } | { error: true; code: string; message: string };

      if ('error' in previewResult) {
        this.updateStatus(`Error: ${previewResult.message}`);
        return;
      }

      this.state.currentUrl = previewResult.previewUrl;
      this.state.devServerDetected = true;

      if (this.iframe) {
        this.iframe.src = previewResult.previewUrl;
      }

      this.updateStatus(`Connected to sandbox preview: ${previewResult.previewUrl}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(`Sandbox error: ${message}`);
    }
  }

  /**
   * Write files to the connected sandbox and trigger a refresh.
   * Requirement 10.4: Modify files in sandbox and preview updates automatically.
   *
   * @param files - Map of file path to content
   */
  async writeToSandbox(files: Record<string, string>): Promise<void> {
    if (!this.state.sandboxInstanceId) {
      this.updateStatus('No sandbox connected');
      return;
    }

    try {
      const result = await eapi().invoke('sandbox:write', {
        instanceId: this.state.sandboxInstanceId,
        files,
      }) as { success: true; written: number } | { error: true; code: string; message: string };

      if ('error' in result) {
        this.updateStatus(`Write error: ${result.message}`);
        return;
      }

      this.updateStatus(`Wrote ${result.written} file(s) — hot-reloading…`);

      // Give the dev server a moment to pick up changes, then refresh
      setTimeout(() => this.refresh(), 500);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(`Write error: ${message}`);
    }
  }

  /**
   * Execute a command in the connected sandbox.
   *
   * @param command - Shell command to run (e.g. "npm test")
   * @returns Command result with stdout, stderr, exitCode
   */
  async runInSandbox(command: string): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
    if (!this.state.sandboxInstanceId) {
      this.updateStatus('No sandbox connected');
      return null;
    }

    try {
      const result = await eapi().invoke('sandbox:run', {
        instanceId: this.state.sandboxInstanceId,
        command,
      }) as { stdout: string; stderr: string; exitCode: number } | { error: true; code: string; message: string };

      if ('error' in result) {
        this.updateStatus(`Run error: ${result.message}`);
        return null;
      }

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(`Run error: ${message}`);
      return null;
    }
  }

  /**
   * Terminate the connected sandbox and reset to non-sandbox state.
   */
  async terminateSandbox(): Promise<void> {
    if (!this.state.sandboxInstanceId) return;

    try {
      await eapi().invoke('sandbox:terminate', {
        instanceId: this.state.sandboxInstanceId,
      });
    } catch {
      // Best-effort termination
    }

    this.state.sandboxInstanceId = null;
    this.state.isSandboxPreview = false;
    this.state.currentUrl = null;
    this.state.devServerDetected = false;

    if (this.iframe) {
      this.iframe.src = 'about:blank';
    }

    this.updateStatus('Sandbox terminated');
  }

  // ─── Rendering ────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;border-left:1px solid var(--border-color);';

    // Toolbar
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-bottom:1px solid var(--border-color);min-height:36px;';

    const title = document.createElement('span');
    title.textContent = '🌐 Live Preview';
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:6px;';

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh preview';
    refreshBtn.style.cssText = 'font-size:14px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    refreshBtn.addEventListener('click', () => this.refresh());

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close preview';
    closeBtn.style.cssText = 'font-size:12px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    closeBtn.addEventListener('click', () => this.close());

    btnGroup.appendChild(refreshBtn);
    btnGroup.appendChild(closeBtn);
    this.toolbarEl.appendChild(title);
    this.toolbarEl.appendChild(btnGroup);
    this.container.appendChild(this.toolbarEl);

    // Status bar
    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'padding:4px 12px;font-size:11px;color:var(--text-dim);background:var(--bg-input);border-bottom:1px solid var(--border-color);';
    this.statusEl.textContent = 'Detecting server…';
    this.container.appendChild(this.statusEl);

    // Iframe container
    const iframeContainer = document.createElement('div');
    iframeContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;';

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:white;';
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    this.iframe.src = 'about:blank';

    iframeContainer.appendChild(this.iframe);
    this.container.appendChild(iframeContainer);
  }

  // ─── Server Detection & Navigation ────────────────────────────

  private async detectAndNavigate(): Promise<void> {
    try {
      // Ask main process to detect dev server
      const result = await eapi().invoke('preview:start', this.state.projectDir) as {
        url: string;
        devServer: boolean;
      };

      this.state.currentUrl = result.url;
      this.state.devServerDetected = result.devServer;

      if (this.iframe) {
        this.iframe.src = result.url;
      }

      if (result.devServer) {
        this.updateStatus(`Connected to dev server: ${result.url}`);
      } else {
        this.updateStatus(`Serving static files at ${result.url}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(`Error: ${message}`);
    }
  }

  // ─── File Watching ────────────────────────────────────────────

  private setupFileWatcher(): void {
    this.cleanupFileWatcher();

    this.fileChangeHandler = (...args: unknown[]) => {
      const data = args[0] as { filePath?: string } | undefined;
      if (data?.filePath) {
        this.updateStatus(`File changed: ${data.filePath}`);
      }
      this.refresh();
    };

    eapi().on('preview:file-changed', this.fileChangeHandler);
  }

  private cleanupFileWatcher(): void {
    if (this.fileChangeHandler) {
      eapi().removeListener('preview:file-changed', this.fileChangeHandler);
      this.fileChangeHandler = null;
    }
  }

  private stopRefreshInterval(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private updateStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = text;
    }
  }

  /** Clean up when panel is destroyed. */
  destroy(): void {
    this.close();
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the live preview panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderPreviewPanel(container: HTMLElement): LivePreviewPanel {
  const panel = new LivePreviewPanel(container);
  return panel;
}
