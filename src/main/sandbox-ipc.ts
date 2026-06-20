/**
 * IPC handler registration for the WebContainer Sandbox System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, pipeline-ipc.ts).
 *
 * Channels:
 *   sandbox:boot        — boot a new isolated WebContainer sandbox instance
 *   sandbox:write       — write files to a running sandbox instance
 *   sandbox:run         — execute a command in a running sandbox
 *   sandbox:preview-url — start dev server and return the live preview URL
 *   sandbox:terminate   — terminate a running sandbox instance
 *
 * Requirements: 9.3, 10.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { WebContainerSandbox, type WebContainerRuntime } from '../sandbox/web-container-sandbox.js';
import type { WebContainerInstance } from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface SandboxIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let sandboxInstance: WebContainerSandbox | null = null;

function getSandbox(runtime?: WebContainerRuntime | null): WebContainerSandbox {
  if (!sandboxInstance) {
    sandboxInstance = new WebContainerSandbox(runtime ?? null);
  }
  return sandboxInstance;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): SandboxIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

export interface SandboxIPCOptions {
  /** Optional WebContainer runtime instance for dependency injection. */
  runtime?: WebContainerRuntime | null;
}

/**
 * Register sandbox IPC handlers with the main process.
 *
 * @param _mainWindow - The main BrowserWindow (for event forwarding if needed)
 * @param options - Configuration options including the optional WebContainer runtime
 */
export function registerSandboxIPC(
  _mainWindow: BrowserWindow,
  options?: SandboxIPCOptions,
): void {
  const sandbox = getSandbox(options?.runtime);

  // ── sandbox:boot ──
  // Requirement 9.1: Boot isolated environment with virtual file system
  // Requirement 9.3: Expose running application via local URL for preview
  ipcMain.handle(
    'sandbox:boot',
    async (): Promise<WebContainerInstance | SandboxIPCErrorResponse> => {
      try {
        const instance = await sandbox.boot();
        return instance;
      } catch (err) {
        return makeError('SANDBOX_BOOT_FAILED', err);
      }
    },
  );

  // ── sandbox:write ──
  // Requirement 9.1: Virtual file system support for writing application files
  ipcMain.handle(
    'sandbox:write',
    async (
      _event,
      args: { instanceId: string; files: Record<string, string> },
    ): Promise<{ success: true; written: number } | SandboxIPCErrorResponse> => {
      try {
        await sandbox.writeFiles(args.instanceId, args.files);
        return { success: true, written: Object.keys(args.files).length };
      } catch (err) {
        return makeError('SANDBOX_WRITE_FAILED', err);
      }
    },
  );

  // ── sandbox:run ──
  // Requirement 9.2: Support executing commands within the isolated environment
  ipcMain.handle(
    'sandbox:run',
    async (
      _event,
      args: { instanceId: string; command: string },
    ): Promise<{ stdout: string; stderr: string; exitCode: number } | SandboxIPCErrorResponse> => {
      try {
        const result = await sandbox.runCommand(args.instanceId, args.command);
        return result;
      } catch (err) {
        return makeError('SANDBOX_RUN_FAILED', err);
      }
    },
  );

  // ── sandbox:preview-url ──
  // Requirement 9.3: Expose the running application via a local URL for live preview
  // Requirement 10.3: Launch app in WebContainer and display live preview
  ipcMain.handle(
    'sandbox:preview-url',
    async (
      _event,
      args: { instanceId: string },
    ): Promise<{ previewUrl: string } | SandboxIPCErrorResponse> => {
      try {
        // Install dependencies first, then start dev server
        await sandbox.install(args.instanceId);
        const previewUrl = await sandbox.startDevServer(args.instanceId);
        return { previewUrl };
      } catch (err) {
        return makeError('SANDBOX_PREVIEW_FAILED', err);
      }
    },
  );

  // ── sandbox:terminate ──
  // Terminate a running sandbox instance and release all resources
  ipcMain.handle(
    'sandbox:terminate',
    async (
      _event,
      args: { instanceId: string },
    ): Promise<{ success: true } | SandboxIPCErrorResponse> => {
      try {
        await sandbox.terminate(args.instanceId);
        return { success: true };
      } catch (err) {
        return makeError('SANDBOX_TERMINATE_FAILED', err);
      }
    },
  );
}
