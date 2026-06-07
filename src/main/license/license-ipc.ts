/**
 * IPC handlers for license key management.
 *
 * Registers invoke channels:
 *   - license:fetch-by-code
 *   - license:validate
 *   - license:generate
 *   - license:mark-used
 *   - license:get-stored
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { ipcMain } from 'electron';
import Database from 'better-sqlite3';
import { LicenseManager } from './license-manager';

/**
 * Register all license-related IPC handlers.
 */
export function registerLicenseIPC(db: Database.Database): void {
  const manager = new LicenseManager({ db });

  // Remove any previously registered handlers to avoid "second handler" errors on re-init
  const channels = [
    'license:fetch-by-code', 'license:validate', 'license:generate',
    'license:mark-used', 'license:get-stored', 'license:update-features',
    'license:get-app-id', 'license:clear-llm-key',
    'referral:send-invite', 'referral:get-stats',
    'referral:delete-invite', 'referral:get-deleted-invites', 'referral:withdraw',
  ];
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch); } catch (_) { /* not registered yet */ }
  }

  // license:fetch-by-code
  // Requirement 9.1
  ipcMain.handle(
    'license:fetch-by-code',
    async (_event, args: { code: string }) => {
      try {
        const data = await manager.fetchByCode(args.code);
        return data;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[LicenseIPC] license:fetch-by-code error:', message);
        return { error: message };
      }
    },
  );

  // license:validate
  // Requirement 9.2
  ipcMain.handle('license:validate', async () => {
    try {
      const result = await manager.validate();
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[LicenseIPC] license:validate error:', message);
      return { error: message };
    }
  });

  // license:generate
  // Requirement 9.3
  ipcMain.handle(
    'license:generate',
    async (
      _event,
      args: { email: string; hwid: string; algorithm: string; features: string[] },
    ) => {
      try {
        const data = await manager.generate(
          args.email,
          args.hwid,
          args.algorithm,
          args.features,
        );
        return data;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[LicenseIPC] license:generate error:', message);
        return { error: message };
      }
    },
  );

  // license:mark-used
  // Requirement 9.4
  ipcMain.handle(
    'license:mark-used',
    async (_event, args: { code: string; hwid: string; appId?: string; email?: string; feature?: string }) => {
      try {
        const result = await manager.markUsed(args.code, args.hwid, args.appId, args.email, args.feature);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[LicenseIPC] license:mark-used error:', message);
        return { success: false };
      }
    },
  );

  // license:get-stored
  // Requirement 9.5
  ipcMain.handle('license:get-stored', () => {
    try {
      return manager.getStoredLicense();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[LicenseIPC] license:get-stored error:', message);
      return null;
    }
  });

  // license:update-features
  ipcMain.handle(
    'license:update-features',
    async (_event, args: { code: string; features: string[] }) => {
      try {
        const result = await manager.updateFeatures(args.code, args.features);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[LicenseIPC] license:update-features error:', message);
        return { success: false };
      }
    },
  );

  // license:get-app-id
  // Returns the persistent app instance ID (reads or creates ~/.neuronest/app-id)
  ipcMain.handle('license:get-app-id', () => {
    try {
      return { appId: LicenseManager.getOrCreateAppId() };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[LicenseIPC] license:get-app-id error:', message);
      return { appId: '' };
    }
  });

  // license:clear-llm-key
  // Clears the llm-license-key row in SQLite (sets to empty string).
  // Used by the renderer on subscription downgrade to remove a soon-to-be-revoked key.
  ipcMain.handle('license:clear-llm-key', () => {
    try {
      const upsert = db.prepare(
        'INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)',
      );
      upsert.run('license:llm-license-key', '', new Date().toISOString());
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[LicenseIPC] license:clear-llm-key error:', message);
      return { ok: false, error: message };
    }
  });

  // referral:send-invite
  // POST /api/invite/send
  ipcMain.handle('referral:send-invite', async (_event, args: {
    senderRefCode: string; senderEmail: string;
    recipientFirst: string; recipientLast?: string; recipientEmail: string;
  }) => {
    try {
      const response = await fetch('https://neuronest.cc/api/invite/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(manager as any).constructor.name ? 'nn_sk_NxZu2pUJ7AGbe5MOLEdf7yq0hYvie0aIeZfmxm7f' : ''}` },
        body: JSON.stringify({
          senderRefCode: args.senderRefCode,
          senderEmail: args.senderEmail,
          recipientFirst: args.recipientFirst,
          recipientLast: args.recipientLast || undefined,
          recipientEmail: args.recipientEmail,
        }),
      });
      const data = await response.json();
      if (!response.ok) return { error: data.error || `HTTP ${response.status}` };
      return data;
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // referral:get-stats
  // GET /api/referral/stats?code=<refCode>
  ipcMain.handle('referral:get-stats', async (_event, args: { code: string }) => {
    try {
      const response = await fetch(`https://neuronest.cc/api/referral/stats?code=${encodeURIComponent(args.code)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer nn_sk_NxZu2pUJ7AGbe5MOLEdf7yq0hYvie0aIeZfmxm7f` },
      });
      const data = await response.json();
      if (!response.ok) return { error: data.error || `HTTP ${response.status}` };
      return data;
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // referral:delete-invite
  // Stores deleted invite emails locally (server endpoint not available)
  ipcMain.handle('referral:delete-invite', async (_event, args: {
    senderRefCode: string; recipientEmail: string;
  }) => {
    try {
      // Store deletion in local config so it persists across sessions
      const key = `deleted-invites:${args.senderRefCode}`;
      let deleted: string[] = [];
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as any;
        if (row && row.value) deleted = JSON.parse(row.value);
      } catch (_) {}
      if (!deleted.includes(args.recipientEmail)) {
        deleted.push(args.recipientEmail);
      }
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)").run(
        key, JSON.stringify(deleted), new Date().toISOString()
      );
      return { ok: true, deleted: args.recipientEmail };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // referral:withdraw
  // DELETE /api/admin/referral/withdraw
  ipcMain.handle('referral:withdraw', async (_event, args: { email: string }) => {
    try {
      const response = await fetch('https://neuronest.cc/api/admin/referral/withdraw', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer nn_sk_NxZu2pUJ7AGbe5MOLEdf7yq0hYvie0aIeZfmxm7f`,
        },
        body: JSON.stringify({ email: args.email }),
      });
      const data = await response.json();
      if (!response.ok) return { error: data.error || `HTTP ${response.status}` };
      return data;
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // referral:get-deleted-invites
  // Returns locally deleted invite emails for filtering
  ipcMain.handle('referral:get-deleted-invites', async (_event, args: { code: string }) => {
    try {
      const key = `deleted-invites:${args.code}`;
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as any;
      if (row && row.value) return { deleted: JSON.parse(row.value) };
      return { deleted: [] };
    } catch (err: unknown) {
      return { deleted: [] };
    }
  });
}
