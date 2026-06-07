/**
 * Auto-update integration via electron-updater.
 *
 * Checks for updates on app start and every 4 hours afterwards.
 * The update server is configured via `package.json` `build.publish` —
 * supports GitHub Releases, S3, generic HTTPS, and custom servers.
 *
 * Disabled in development (no app.isPackaged) to avoid noise.
 */

import { app, dialog } from 'electron';
import { logger } from '../utils/logger';

let updaterInitialized = false;
let updateCheckInterval: NodeJS.Timeout | null = null;

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export function initAutoUpdater(mainWindow: { webContents: { send: (channel: string, data: any) => void } } | null): void {
  if (updaterInitialized) return;
  if (!app.isPackaged) {
    logger.info('[AutoUpdate] Skipped — not a packaged build');
    return;
  }

  let autoUpdater: any;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err: any) {
    logger.warn('[AutoUpdate] electron-updater not available:', err.message);
    return;
  }

  // Configure update feed URL (generic provider — neuronest.cc/updates)
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://neuronest.cc/updates',
    channel: 'latest',
  });

  // Don't auto-download — let the user opt in
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err: Error) => {
    logger.error('[AutoUpdate] Error:', err.message);
    mainWindow?.webContents.send('auto-update:error', { message: err.message });
  });

  autoUpdater.on('checking-for-update', () => {
    logger.info('[AutoUpdate] Checking for updates...');
    mainWindow?.webContents.send('auto-update:checking', {});
  });

  autoUpdater.on('update-available', (info: any) => {
    logger.info('[AutoUpdate] Update available:', info.version);
    mainWindow?.webContents.send('auto-update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });

    // Prompt user
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `Version ${info.version} is available. Would you like to download it now?`,
        detail: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
        buttons: ['Download now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate().catch((err: any) => {
            logger.error('[AutoUpdate] Download failed:', err.message);
          });
        }
      });
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('[AutoUpdate] App is up to date');
    mainWindow?.webContents.send('auto-update:up-to-date', {});
  });

  autoUpdater.on('download-progress', (progress: any) => {
    mainWindow?.webContents.send('auto-update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: any) => {
    logger.info('[AutoUpdate] Update downloaded:', info.version);
    mainWindow?.webContents.send('auto-update:downloaded', { version: info.version });

    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: 'The update has been downloaded. Restart now to install?',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  // Initial check
  autoUpdater.checkForUpdates().catch((err: any) => {
    logger.warn('[AutoUpdate] Initial check failed:', err.message);
  });

  // Periodic check every 4 hours
  updateCheckInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err: any) => {
      logger.warn('[AutoUpdate] Periodic check failed:', err.message);
    });
  }, FOUR_HOURS_MS);

  updaterInitialized = true;
  logger.info('[AutoUpdate] Initialized');
}

export function stopAutoUpdater(): void {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}
