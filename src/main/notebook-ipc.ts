/**
 * Notebook IPC Handler — Wires renderer notebook panel to NotebookService.
 *
 * Registers IPC channels:
 *   notebook:create   — Create a new .ipynb notebook
 *   notebook:open     — Open an existing .ipynb file
 *   notebook:close    — Close notebook and shut down kernel
 *   notebook:add-cell — Add a code or markdown cell
 *   notebook:edit-cell — Edit cell source
 *   notebook:delete-cell — Delete a cell
 *   notebook:run-cell — Execute a code cell
 *   notebook:get-output — Get cell output
 *   notebook:get-cells — Get all cells
 *   notebook:kernel-status — Get kernel status
 *
 * Gated behind `notebook_integration` feature flag.
 *
 * Requirements: 20.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { NotebookService } from '../notebook/notebook-service';
import { KernelManager, type KernelLanguage } from '../notebook/kernel-manager';

export interface NotebookIPCDeps {
  mainWindow: BrowserWindow;
  isFeatureEnabled: () => boolean;
  getProjectDir: () => string | null;
}

export function registerNotebookIPC(deps: NotebookIPCDeps): void {
  const { mainWindow, isFeatureEnabled, getProjectDir } = deps;

  function gateCheck(): string | null {
    if (!isFeatureEnabled()) {
      return 'Notebook integration is not enabled. Enable the notebook_integration feature flag.';
    }
    return null;
  }

  // ── notebook:create ─────────────────────────────────────────────
  ipcMain.handle('notebook:create', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const name = args?.name || 'Untitled';
      const language = (args?.language || 'python') as KernelLanguage;
      const directory = args?.directory || getProjectDir() || process.cwd();

      const info = service.createNotebook(name, directory, language);
      return { success: true, notebook: info };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:open ───────────────────────────────────────────────
  ipcMain.handle('notebook:open', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const filePath = args?.filePath || args?.path;
      if (!filePath) return { success: false, error: 'filePath is required' };

      const info = service.openNotebook(filePath);
      return { success: true, notebook: info };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:close ──────────────────────────────────────────────
  ipcMain.handle('notebook:close', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const notebookId = args?.notebookId || args?.id;
      if (!notebookId) return { success: false, error: 'notebookId is required' };

      await service.closeNotebook(notebookId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:add-cell ───────────────────────────────────────────
  ipcMain.handle('notebook:add-cell', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const { notebookId, type, source, position } = args || {};
      if (!notebookId) return { success: false, error: 'notebookId is required' };
      if (!type) return { success: false, error: 'type is required (code or markdown)' };
      if (source === undefined) return { success: false, error: 'source is required' };

      const cell = service.addCell(notebookId, type, source, position);
      return { success: true, cell };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:edit-cell ──────────────────────────────────────────
  ipcMain.handle('notebook:edit-cell', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const { notebookId, cellId, source } = args || {};
      if (!notebookId || !cellId) return { success: false, error: 'notebookId and cellId are required' };
      if (source === undefined) return { success: false, error: 'source is required' };

      const cell = service.editCell(notebookId, cellId, source);
      return { success: true, cell };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:delete-cell ────────────────────────────────────────
  ipcMain.handle('notebook:delete-cell', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const { notebookId, cellId } = args || {};
      if (!notebookId || !cellId) return { success: false, error: 'notebookId and cellId are required' };

      const deleted = service.deleteCell(notebookId, cellId);
      return { success: deleted };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:run-cell ───────────────────────────────────────────
  ipcMain.handle('notebook:run-cell', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const { notebookId, cellId } = args || {};
      if (!notebookId || !cellId) return { success: false, error: 'notebookId and cellId are required' };

      // Notify renderer that cell is executing
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notebook:cell-executing', { notebookId, cellId });
      }

      const result = await service.runCell(notebookId, cellId);

      // Notify renderer of completion
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notebook:cell-executed', { notebookId, cellId, result });
      }

      return { success: result.success, result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:get-output ─────────────────────────────────────────
  ipcMain.handle('notebook:get-output', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const { notebookId, cellId } = args || {};
      if (!notebookId || !cellId) return { success: false, error: 'notebookId and cellId are required' };

      const outputs = service.getCellOutput(notebookId, cellId);
      return { success: true, outputs };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:get-cells ──────────────────────────────────────────
  ipcMain.handle('notebook:get-cells', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const service = NotebookService.getInstance();
      const notebookId = args?.notebookId || args?.id;
      if (!notebookId) return { success: false, error: 'notebookId is required' };

      const cells = service.getCells(notebookId);
      return { success: true, cells };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:kernel-status ──────────────────────────────────────
  ipcMain.handle('notebook:kernel-status', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const kernelManager = KernelManager.getInstance();
      const notebookId = args?.notebookId || args?.id;
      if (!notebookId) return { success: false, error: 'notebookId is required' };

      const info = kernelManager.getKernelInfo(notebookId);
      return { success: true, kernel: info };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── notebook:restart-kernel ─────────────────────────────────────
  ipcMain.handle('notebook:restart-kernel', async (_ev, args: any) => {
    const err = gateCheck();
    if (err) return { success: false, error: err };

    try {
      const kernelManager = KernelManager.getInstance();
      const notebookId = args?.notebookId || args?.id;
      if (!notebookId) return { success: false, error: 'notebookId is required' };

      const info = await kernelManager.restartKernel(notebookId);
      return { success: true, kernel: info };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Forward kernel events to renderer
  const kernelManager = KernelManager.getInstance();
  kernelManager.on('kernel:started', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notebook:kernel-event', { event: 'started', ...data });
    }
  });
  kernelManager.on('kernel:crashed', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notebook:kernel-event', { event: 'crashed', ...data });
    }
  });
  kernelManager.on('kernel:restarting', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notebook:kernel-event', { event: 'restarting', ...data });
    }
  });
  kernelManager.on('kernel:shutdown', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notebook:kernel-event', { event: 'shutdown', ...data });
    }
  });

  console.log('[IPC] Notebook IPC handlers registered');
}
