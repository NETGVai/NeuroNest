/**
 * NeuroNest Update Checker — checks versions.json on startup and
 * forces upgrade when a newer version is available.
 *
 * Flow:
 * 1. Fetch https://neuronest.cc/versions.json
 * 2. Compare neuronest-ide.version against app version
 * 3. If remote is newer, show a blocking modal with download link
 * 4. User clicks Download → opens platform-specific DMG URL in browser
 * 5. App quits so user can install the new version
 */

import { app, BrowserWindow, shell } from 'electron';
import os from 'node:os';

const VERSIONS_URL = 'https://neuronest.cc/versions.json';
const DOWNLOAD_PAGE = 'https://neuronest.cc/download';

export interface PlatformEntry {
  /** Human-readable label for the platform */
  label: string;
  /** Direct download URL for the installer */
  download: string;
  /** Optional per-platform version (overrides top-level version) */
  version?: string;
}

export interface ProductEntry {
  /** Current version (semver) */
  version: string;
  /** ISO date of release */
  released: string;
  /** Changelog summary or URL */
  changelog: string;
  /** Platform-keyed download entries */
  platforms: Record<string, PlatformEntry>;
}

export interface VersionManifest {
  'neuronest-ide': ProductEntry;
}

/**
 * Compare two semver strings. Returns:
 *  1 if a > b
 *  0 if a === b
 * -1 if a < b
 */
export function compareSemver(a: string, b: string): number {
  // Strip any non-numeric prefix/suffix (e.g., "v0.1.88" → "0.1.88")
  const cleanA = a.replace(/^[^0-9]*/, '').replace(/[^0-9.].*$/, '');
  const cleanB = b.replace(/^[^0-9]*/, '').replace(/[^0-9.].*$/, '');
  const pa = cleanA.split('.').map(s => parseInt(s, 10) || 0);
  const pb = cleanB.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Resolve the platform key for the current machine.
 * Returns unified keys first ("macos", "windows"), falls back to legacy
 * architecture-specific keys if the unified key is not present in the manifest.
 */
export function getPlatformKey(platforms: Record<string, PlatformEntry>): string {
  const platform = process.platform; // 'darwin', 'win32', 'linux'
  const arch = os.arch();            // 'arm64' or 'x64'

  if (platform === 'darwin') {
    if (platforms['macos']) return 'macos';
    // Legacy fallback
    return arch === 'arm64' ? 'macos-arm64' : 'macos-intel';
  }
  if (platform === 'win32') {
    if (platforms['windows']) return 'windows';
    return `windows-${arch}`;
  }
  // Linux remains arch-specific
  return `linux-${arch}`;
}

/**
 * Check for updates and show a blocking modal if an update is required.
 * Call this after the main window is created and ready.
 */
export async function checkForUpdates(mainWindow: BrowserWindow): Promise<void> {
  const currentVersion = app.getVersion();
  console.log(`[UpdateChecker] Current version: ${currentVersion}`);

  let manifest: VersionManifest;
  try {
    const response = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      console.warn(`[UpdateChecker] Failed to fetch versions.json: ${response.status}`);
      return;
    }
    manifest = await response.json() as VersionManifest;
  } catch (e: any) {
    console.warn(`[UpdateChecker] Could not check for updates: ${e.message}`);
    return; // Network error — don't block the app
  }

  const remoteEntry = manifest['neuronest-ide'];
  if (!remoteEntry) {
    console.warn('[UpdateChecker] No neuronest-ide entry in versions.json');
    return;
  }

  const platformKey = getPlatformKey(remoteEntry.platforms || {});
  const platformInfo = remoteEntry.platforms?.[platformKey];
  let remoteVersion: string;

  if (platformInfo?.version) {
    remoteVersion = platformInfo.version;
  } else {
    if (remoteEntry.version) {
      console.warn(`[UpdateChecker] No platform-specific version for ${platformKey}, using common version`);
      remoteVersion = remoteEntry.version;
    } else {
      console.warn('[UpdateChecker] No version found in manifest');
      return;
    }
  }

  console.log(`[UpdateChecker] Remote version: ${remoteVersion}`);

  const cmp = compareSemver(remoteVersion, currentVersion);
  console.log(`[UpdateChecker] compareSemver("${remoteVersion}", "${currentVersion}") = ${cmp}`);

  if (cmp <= 0) {
    console.log('[UpdateChecker] App is up to date');
    return;
  }

  // Newer version available — get the download URL for this platform
  const downloadUrl = (platformInfo?.download && platformInfo.download.trim() !== '')
    ? platformInfo.download
    : DOWNLOAD_PAGE;
  const changelog = remoteEntry.changelog || '';

  console.log(`[UpdateChecker] Update available: ${currentVersion} → ${remoteVersion}`);
  console.log(`[UpdateChecker] Download URL: ${downloadUrl}`);

  // Escape values for safe injection into JS string
  const safeCurrentVersion = currentVersion.replace(/['"\\]/g, '');
  const safeRemoteVersion = remoteVersion.replace(/['"\\]/g, '');
  const safeChangelog = changelog.replace(/['"\\<>]/g, '');

  // Show blocking update modal in the renderer
  mainWindow.webContents.executeJavaScript(`
    (function() {
      var existing = document.getElementById('nn-update-overlay');
      if (existing) existing.remove();

      var overlay = document.createElement('div');
      overlay.id = 'nn-update-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:999999;';

      var card = document.createElement('div');
      card.style.cssText = 'background:var(--bg-sidebar,#1e1e2e);border:1px solid var(--border-color,#45475a);border-radius:16px;padding:32px;max-width:460px;width:90%;color:var(--text-primary,#cdd6f4);text-align:center;';

      var refProfile = {};
      try { refProfile = JSON.parse(localStorage.getItem('neuronest-user-profile') || '{}'); } catch(_e) {}
      var refParam = refProfile.referralCode ? '?ref=' + encodeURIComponent(refProfile.referralCode) : '';
      var downloadPageUrl = 'https://neuronest.cc/download/' + refParam;

      card.innerHTML =
        '<div style="font-size:48px;margin-bottom:16px;">\\uD83D\\uDE80</div>' +
        '<h2 style="margin:0 0 8px;font-size:22px;color:var(--text-primary,#cdd6f4);">Update Required</h2>' +
        '<p style="margin:0 0 16px;font-size:14px;color:var(--text-secondary,#a6adc8);">A new version of NeuroNest is available.</p>' +
        '<div style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;">' +
          '<div style="text-align:center;">' +
            '<div style="font-size:11px;color:var(--text-dim,#6c7086);margin-bottom:4px;">Current</div>' +
            '<div style="font-size:18px;font-weight:700;color:var(--red,#f38ba8);">${safeCurrentVersion}</div>' +
          '</div>' +
          '<div style="font-size:24px;color:var(--text-dim,#6c7086);align-self:center;">\\u2192</div>' +
          '<div style="text-align:center;">' +
            '<div style="font-size:11px;color:var(--text-dim,#6c7086);margin-bottom:4px;">Latest</div>' +
            '<div style="font-size:18px;font-weight:700;color:var(--green,#a6e3a1);">${safeRemoteVersion}</div>' +
          '</div>' +
        '</div>' +
        '<a id="nn-update-download-btn" href="#" style="display:block;width:100%;padding:12px;border:none;border-radius:8px;background:var(--accent,#89b4fa);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;text-decoration:none;text-align:center;">UPDATE NOW</a>' +
        '<div style="font-size:11px;color:var(--text-dim,#6c7086);">You must update to continue using NeuroNest.</div>';

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      document.getElementById('nn-update-download-btn').addEventListener('click', function(e) {
        e.preventDefault();
        window.electronAPI.invoke('update:download', { refParam: refParam });
      });
    })();
  `).catch((e: any) => {
    console.error('[UpdateChecker] Failed to show update modal:', e);
  });

  // Register the download handler
  const { ipcMain } = require('electron');
  ipcMain.handle('update:download', async (_event: any, args: any) => {
    try {
      const refParam = args?.refParam || '';
      // Use the resolved platform download URL; append referral param only for download page
      let finalUrl: string;
      if (downloadUrl === DOWNLOAD_PAGE) {
        finalUrl = DOWNLOAD_PAGE + (refParam ? '/' + refParam : '');
      } else {
        finalUrl = downloadUrl;
      }
      await shell.openExternal(finalUrl);
      // Give the browser a moment to open, then quit
      setTimeout(() => { app.quit(); }, 1500);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
