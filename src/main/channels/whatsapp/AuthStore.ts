/**
 * WhatsApp Auth Store — persists Baileys credentials to disk.
 * Uses Electron's app.getPath('userData') for crash-safe storage.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const AUTH_DIR_NAME = 'whatsapp-auth';

export function getAuthDir(): string {
  // Use Electron's userData path if available, fallback to ~/.neuronest
  let base: string;
  try {
    const { app } = require('electron');
    base = app.getPath('userData');
  } catch {
    base = path.join(os.homedir(), '.neuronest');
  }
  const dir = path.join(base, AUTH_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function clearAuth(): void {
  const dir = getAuthDir();
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (e: any) {
    console.error('[WhatsApp:Auth] Failed to clear auth:', e?.message);
  }
}

export function hasAuth(): boolean {
  const dir = getAuthDir();
  try {
    const files = fs.readdirSync(dir);
    return files.some(f => f.includes('creds'));
  } catch {
    return false;
  }
}
