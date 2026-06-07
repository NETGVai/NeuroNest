/**
 * SQLite-backed implementation of the CredentialStore interface.
 *
 * Runs an idempotent migration on construction to add the `rp_id` column
 * to the existing `webauthn_credentials` table. Existing rows default to
 * `rp_id = 'localhost'`.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import type Database from 'better-sqlite3';
import type { CredentialStore, StoredCredential, UserProfile } from './credential-store.js';

export class SQLiteCredentialStore implements CredentialStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.runMigration();
  }

  /**
   * Idempotent migration: adds `rp_id TEXT DEFAULT 'localhost'` to
   * `webauthn_credentials` if the column does not already exist.
   * Safe to call multiple times.
   */
  private runMigration(): void {
    // Check if the rp_id column already exists
    const columns = this.db
      .prepare("PRAGMA table_info(webauthn_credentials)")
      .all() as { name: string }[];

    const hasRpId = columns.some((col) => col.name === 'rp_id');

    if (!hasRpId) {
      this.db.exec(
        "ALTER TABLE webauthn_credentials ADD COLUMN rp_id TEXT DEFAULT 'localhost'"
      );
    }

    // Create user_profiles table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        email TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  getCredentialsByUserId(userId: string, rpId?: string): StoredCredential[] {
    if (rpId) {
      return this.db
        .prepare(
          'SELECT id, user_id, credential_id, public_key, counter, device_name, transports, rp_id, created_at FROM webauthn_credentials WHERE user_id = ? AND rp_id = ?'
        )
        .all(userId, rpId)
        .map(rowToCredential);
    }
    return this.db
      .prepare(
        'SELECT id, user_id, credential_id, public_key, counter, device_name, transports, rp_id, created_at FROM webauthn_credentials WHERE user_id = ?'
      )
      .all(userId)
      .map(rowToCredential);
  }

  getCredentialsByRpId(rpId: string): StoredCredential[] {
    return this.db
      .prepare(
        'SELECT id, user_id, credential_id, public_key, counter, device_name, transports, rp_id, created_at FROM webauthn_credentials WHERE rp_id = ?'
      )
      .all(rpId)
      .map(rowToCredential);
  }

  saveCredential(credential: StoredCredential): void {
    this.db
      .prepare(
        'INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, device_name, transports, rp_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        credential.id,
        credential.userId,
        credential.credentialId,
        credential.publicKey,
        credential.counter,
        credential.deviceName,
        credential.transports,
        credential.rpId,
        credential.createdAt,
      );
  }

  updateCounter(credentialId: string, newCounter: number): void {
    this.db
      .prepare('UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?')
      .run(newCounter, credentialId);
  }

  storeChallenge(userId: string, challenge: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO webauthn_challenges (user_id, challenge) VALUES (?, ?)'
      )
      .run(userId, challenge);
  }

  getChallenge(userId: string): string | null {
    const row = this.db
      .prepare('SELECT challenge FROM webauthn_challenges WHERE user_id = ?')
      .get(userId) as { challenge: string } | undefined;

    if (!row) return null;

    this.db
      .prepare('DELETE FROM webauthn_challenges WHERE user_id = ?')
      .run(userId);

    return row.challenge;
  }

  saveUserProfile(profile: UserProfile): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO user_profiles (email, first_name, last_name, app_id, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        profile.email,
        profile.firstName,
        profile.lastName,
        profile.appId,
        profile.deviceId,
        profile.createdAt,
      );
  }

  getUserProfile(email: string): UserProfile | null {
    const row = this.db
      .prepare('SELECT email, first_name, last_name, app_id, device_id, created_at FROM user_profiles WHERE email = ?')
      .get(email) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      email: row.email as string,
      firstName: row.first_name as string,
      lastName: row.last_name as string,
      appId: row.app_id as string,
      deviceId: row.device_id as string,
      createdAt: row.created_at as string,
    };
  }
}

/** Map a raw SQLite row to a StoredCredential. */
function rowToCredential(row: unknown): StoredCredential {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    userId: r.user_id as string,
    credentialId: r.credential_id as string,
    publicKey: r.public_key as string,
    counter: r.counter as number,
    deviceName: (r.device_name as string) ?? null,
    transports: (r.transports as string) ?? null,
    rpId: (r.rp_id as string) ?? 'localhost',
    createdAt: r.created_at as string,
  };
}
