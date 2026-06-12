import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  version: 1;
  method: 'safeStorage' | 'pbkdf2';
  ciphertext: string; // base64-encoded
  salt?: string;      // for pbkdf2 fallback
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// SafeStorage abstraction (allows mocking in tests and fallback detection)
// ---------------------------------------------------------------------------

export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Default backend that delegates to Electron's safeStorage.
 * Lazily loaded to avoid requiring Electron at import time (helps testing).
 */
function getElectronSafeStorage(): SafeStorageBackend | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require('electron');
    return safeStorage as SafeStorageBackend;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PBKDF2 fallback helpers
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32; // 256 bits
const PBKDF2_DIGEST = 'sha256';
const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Derives a 256-bit key from a passphrase using PBKDF2.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypts plaintext using AES-256-GCM with a derived key.
 * Returns base64-encoded ciphertext containing: IV + authTag + encrypted data.
 */
function pbkdf2Encrypt(plaintext: string, passphrase: string): { ciphertext: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV (12) + authTag (16) + encrypted data
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return {
    ciphertext: packed.toString('base64'),
    salt: salt.toString('base64'),
  };
}

/**
 * Decrypts ciphertext that was encrypted with pbkdf2Encrypt.
 */
function pbkdf2Decrypt(ciphertext: string, salt: string, passphrase: string): string {
  const packed = Buffer.from(ciphertext, 'base64');
  const saltBuffer = Buffer.from(salt, 'base64');
  const key = deriveKey(passphrase, saltBuffer);

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

export class SecretStore {
  private safeStorage: SafeStorageBackend | null;
  private passphrase: string | null;

  /**
   * @param safeStorageBackend - Override for the SafeStorage backend (for testing).
   *   If omitted, attempts to load Electron's safeStorage.
   * @param passphrase - Fallback passphrase for PBKDF2 when SafeStorage is unavailable.
   */
  constructor(options?: { safeStorageBackend?: SafeStorageBackend | null; passphrase?: string }) {
    this.safeStorage = options?.safeStorageBackend !== undefined
      ? options.safeStorageBackend
      : getElectronSafeStorage();
    this.passphrase = options?.passphrase ?? null;
  }

  /**
   * Returns true if OS-level SafeStorage is available.
   */
  isSafeStorageAvailable(): boolean {
    return this.safeStorage?.isEncryptionAvailable() === true;
  }

  /**
   * Encrypts a plaintext string into an EncryptedEnvelope.
   * Uses SafeStorage when available, falls back to PBKDF2.
   */
  encrypt(plaintext: string): EncryptedEnvelope {
    if (this.isSafeStorageAvailable()) {
      const encrypted = this.safeStorage!.encryptString(plaintext);
      return {
        version: 1,
        method: 'safeStorage',
        ciphertext: encrypted.toString('base64'),
      };
    }

    // PBKDF2 fallback
    if (!this.passphrase) {
      throw new Error('SafeStorage unavailable and no passphrase provided for PBKDF2 fallback');
    }

    const { ciphertext, salt } = pbkdf2Encrypt(plaintext, this.passphrase);
    return {
      version: 1,
      method: 'pbkdf2',
      ciphertext,
      salt,
    };
  }

  /**
   * Decrypts an EncryptedEnvelope back to plaintext.
   */
  decrypt(envelope: EncryptedEnvelope): string {
    if (!this.isValidEnvelope(envelope)) {
      throw new Error('Secret Store: invalid envelope — corruption detected');
    }

    if (envelope.method === 'safeStorage') {
      if (!this.safeStorage) {
        throw new Error('SafeStorage backend not available for decryption');
      }
      const buffer = Buffer.from(envelope.ciphertext, 'base64');
      return this.safeStorage.decryptString(buffer);
    }

    if (envelope.method === 'pbkdf2') {
      if (!this.passphrase) {
        throw new Error('No passphrase available for PBKDF2 decryption');
      }
      if (!envelope.salt) {
        throw new Error('Secret Store: PBKDF2 envelope missing salt — corruption detected');
      }
      return pbkdf2Decrypt(envelope.ciphertext, envelope.salt, this.passphrase);
    }

    throw new Error(`Secret Store: unknown encryption method "${(envelope as any).method}"`);
  }

  /**
   * Type guard that validates whether a value is a well-formed EncryptedEnvelope.
   */
  isValidEnvelope(value: unknown): value is EncryptedEnvelope {
    if (value === null || value === undefined || typeof value !== 'object') {
      return false;
    }

    const obj = value as Record<string, unknown>;

    // Check version
    if (obj.version !== 1) {
      return false;
    }

    // Check method
    if (obj.method !== 'safeStorage' && obj.method !== 'pbkdf2') {
      return false;
    }

    // Check ciphertext is a non-empty string that is valid base64
    if (typeof obj.ciphertext !== 'string' || obj.ciphertext.length === 0) {
      return false;
    }

    if (!isValidBase64(obj.ciphertext)) {
      return false;
    }

    // For pbkdf2 method, salt must be present and valid base64
    if (obj.method === 'pbkdf2') {
      if (typeof obj.salt !== 'string' || obj.salt.length === 0) {
        return false;
      }
      if (!isValidBase64(obj.salt)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Ensures the secrets_v2 table exists in the given database.
   */
  ensureTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets_v2 (
        key TEXT PRIMARY KEY,
        envelope TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Migrates plaintext secrets from the legacy "secrets" table (if it exists)
   * to the encrypted secrets_v2 table.
   */
  migrateIfNeeded(db: Database.Database): MigrationResult {
    const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] };

    // Ensure secrets_v2 exists
    this.ensureTable(db);

    // Check if legacy secrets table exists
    const legacyExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secrets'")
      .get();

    if (!legacyExists) {
      return result;
    }

    // Read all legacy secrets
    const legacyRows = db.prepare('SELECT key, value FROM secrets').all() as Array<{
      key: string;
      value: string;
    }>;

    for (const row of legacyRows) {
      try {
        // Check if already migrated
        const existing = db.prepare('SELECT key FROM secrets_v2 WHERE key = ?').get(row.key);
        if (existing) {
          result.skipped++;
          continue;
        }

        // Check if the value is already an encrypted envelope
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          parsed = null;
        }

        if (parsed && this.isValidEnvelope(parsed)) {
          // Already encrypted, just move it
          db.prepare(
            'INSERT INTO secrets_v2 (key, envelope, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
          ).run(row.key, row.value);
        } else {
          // Encrypt plaintext value
          const envelope = this.encrypt(row.value);
          db.prepare(
            'INSERT INTO secrets_v2 (key, envelope, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
          ).run(row.key, JSON.stringify(envelope));
        }

        result.migrated++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to migrate key "${row.key}": ${message}`);
      }
    }

    // Remove plaintext entries that were successfully migrated
    if (result.migrated > 0 && result.errors.length === 0) {
      db.exec('DROP TABLE IF EXISTS secrets');
    }

    return result;
  }

  /**
   * Store an encrypted secret by key.
   */
  set(db: Database.Database, key: string, plaintext: string): void {
    this.ensureTable(db);
    const envelope = this.encrypt(plaintext);
    const envelopeJson = JSON.stringify(envelope);

    db.prepare(`
      INSERT INTO secrets_v2 (key, envelope, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET envelope = excluded.envelope, updated_at = CURRENT_TIMESTAMP
    `).run(key, envelopeJson);
  }

  /**
   * Retrieve and decrypt a secret by key.
   * Returns null if key not found.
   * Throws on corruption/invalid envelope.
   */
  get(db: Database.Database, key: string): string | null {
    this.ensureTable(db);
    const row = db.prepare('SELECT envelope FROM secrets_v2 WHERE key = ?').get(key) as
      | { envelope: string }
      | undefined;

    if (!row) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.envelope);
    } catch {
      throw new Error(`Secret Store: corrupted envelope for key "${key}" — invalid JSON`);
    }

    if (!this.isValidEnvelope(parsed)) {
      throw new Error(`Secret Store: corrupted envelope for key "${key}" — invalid format`);
    }

    return this.decrypt(parsed);
  }

  /**
   * Delete a secret by key.
   */
  delete(db: Database.Database, key: string): boolean {
    this.ensureTable(db);
    const info = db.prepare('DELETE FROM secrets_v2 WHERE key = ?').run(key);
    return info.changes > 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates that a string is valid base64 encoding.
 */
function isValidBase64(str: string): boolean {
  // Standard base64 regex: only allows base64 characters and padding
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(str)) {
    return false;
  }
  // Additionally check that length is valid (must be multiple of 4 when padded)
  // But unpadded base64 is common from Buffer.toString('base64'), so we allow
  // strings whose length is compatible
  try {
    const decoded = Buffer.from(str, 'base64');
    // Re-encode to verify round-trip
    return decoded.toString('base64') === str;
  } catch {
    return false;
  }
}
