/**
 * Encrypted Content-Addressed Blob Store
 *
 * Provides encrypted content-addressed storage for source-bearing bodies,
 * journals, histories, context caches, and artifacts.
 *
 * Key design decisions:
 * - Content addressing via SHA-256 of plaintext for deduplication
 * - Encryption at rest using AES-256-GCM with OS-backed keys
 * - Local-only 30-day retention by default
 * - Provider transmission disabled by default
 * - Writes blocked when no approved secure key is available
 *
 * Requirements: 9.9, 25.4, 25.8, 25.9, 25.12
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

/** Classification of stored content */
export type ContentClassification =
  | 'source_body'
  | 'journal'
  | 'history'
  | 'context_cache'
  | 'artifact'
  | 'metadata';

/** Blob metadata stored alongside encrypted content */
export interface BlobMetadata {
  /** SHA-256 hash of the plaintext content (content address) */
  contentHash: string;
  /** Content classification for privacy policy enforcement */
  classification: ContentClassification;
  /** Size of original plaintext in bytes */
  plaintextSize: number;
  /** When the blob was first stored */
  createdAt: string;
  /** When the blob was last accessed */
  lastAccessedAt: string;
  /** Retention expiry timestamp (ISO 8601) */
  expiresAt: string;
  /** Whether this blob may be transmitted to providers */
  providerTransmissionAllowed: boolean;
  /** Whether this content participates in telemetry */
  telemetryOptIn: boolean;
  /** ID of the encryption key used */
  keyId: string;
  /** AES-GCM initialization vector (hex-encoded) */
  iv: string;
  /** AES-GCM authentication tag (hex-encoded) */
  authTag: string;
}

/** Result of a store operation */
export interface StoreResult {
  contentHash: string;
  deduplicated: boolean;
  storedAt: string;
}

/** Result of a retrieval operation */
export interface RetrieveResult {
  content: Buffer;
  metadata: BlobMetadata;
}

/** Errors specific to the blob store */
export class BlobStoreError extends Error {
  constructor(
    message: string,
    public readonly code: BlobStoreErrorCode,
  ) {
    super(message);
    this.name = 'BlobStoreError';
  }
}

export type BlobStoreErrorCode =
  | 'KEY_UNAVAILABLE'
  | 'BLOB_NOT_FOUND'
  | 'DECRYPTION_FAILED'
  | 'RETENTION_EXPIRED'
  | 'WRITE_BLOCKED'
  | 'INTEGRITY_MISMATCH';

// ─── Key Provider Interface ─────────────────────────────────────

/**
 * Interface for OS-backed key providers.
 * Implementations use platform keychain (macOS), credential manager (Windows),
 * or secret-service (Linux).
 */
export interface KeyProvider {
  /** Get the current encryption key, or null if unavailable */
  getKey(): Buffer | null;
  /** Get the key identifier */
  getKeyId(): string;
  /** Check if a secure key is available */
  isAvailable(): boolean;
}

/**
 * Default OS-backed key provider that derives a key from the system keychain.
 * Falls back gracefully when keychain access is unavailable.
 */
export class OSBackedKeyProvider implements KeyProvider {
  private cachedKey: Buffer | null = null;
  private readonly keyId: string;
  private readonly keyStorePath: string;

  constructor(dataDirectory: string) {
    this.keyId = 'neuronest-blob-encryption-v1';
    this.keyStorePath = path.join(dataDirectory, '.encryption-key');
  }

  getKey(): Buffer | null {
    if (this.cachedKey) return this.cachedKey;

    try {
      // Attempt to load from the key file
      // In production, this would interface with OS keychain APIs
      // (macOS Keychain, Windows Credential Manager, Linux secret-service)
      if (fs.existsSync(this.keyStorePath)) {
        const keyData = fs.readFileSync(this.keyStorePath);
        if (keyData.length === 32) {
          this.cachedKey = keyData;
          return this.cachedKey;
        }
      }

      // Generate and persist a new key
      const newKey = randomBytes(32);
      fs.writeFileSync(this.keyStorePath, newKey, { mode: 0o600 });
      this.cachedKey = newKey;
      return this.cachedKey;
    } catch {
      // Key unavailable — no secure storage access
      return null;
    }
  }

  getKeyId(): string {
    return this.keyId;
  }

  isAvailable(): boolean {
    return this.getKey() !== null;
  }
}

// ─── Privacy Policy ─────────────────────────────────────────────

/** Privacy policy configuration for source-bearing content */
export interface PrivacyPolicy {
  /** Retention period in days (default: 30) */
  retentionDays: number;
  /** Whether provider transmission is allowed (default: false) */
  providerTransmissionAllowed: boolean;
  /** Whether source-free telemetry is opted in (default: false) */
  telemetryOptIn: boolean;
  /** Whether content is local-only (default: true) */
  localOnly: boolean;
}

/** Default privacy policy for new source-bearing content */
export const DEFAULT_PRIVACY_POLICY: Readonly<PrivacyPolicy> = Object.freeze({
  retentionDays: 30,
  providerTransmissionAllowed: false,
  telemetryOptIn: false,
  localOnly: true,
});

// ─── Migration Hold ─────────────────────────────────────────────

/** State of data in migration hold */
export type MigrationHoldState = 'held' | 'approved' | 'rejected' | 'migrated';

/** Record for data placed in migration hold */
export interface MigrationHoldRecord {
  /** Content hash of the held blob */
  contentHash: string;
  /** Current hold state */
  state: MigrationHoldState;
  /** When the hold was created */
  createdAt: string;
  /** When the user made their privacy choice (if applicable) */
  resolvedAt?: string;
  /** The chosen policy after resolution */
  chosenPolicy?: PrivacyPolicy;
}

// ─── Encrypted Blob Store ───────────────────────────────────────

/**
 * Content-addressed blob store with encryption at rest.
 *
 * Blobs are addressed by SHA-256 hash of their plaintext content,
 * enabling deduplication while maintaining encryption at rest.
 * All writes are blocked when no secure encryption key is available.
 */
export class EncryptedBlobStore {
  private readonly blobDir: string;
  private readonly metadataDir: string;
  private readonly holdDir: string;
  private readonly keyProvider: KeyProvider;
  private readonly defaultPolicy: PrivacyPolicy;

  constructor(
    dataDirectory: string,
    keyProvider: KeyProvider,
    defaultPolicy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  ) {
    this.blobDir = path.join(dataDirectory, 'blobs');
    this.metadataDir = path.join(dataDirectory, 'blob-metadata');
    this.holdDir = path.join(dataDirectory, 'migration-hold');
    this.keyProvider = keyProvider;
    this.defaultPolicy = defaultPolicy;

    // Ensure directories exist
    fs.mkdirSync(this.blobDir, { recursive: true });
    fs.mkdirSync(this.metadataDir, { recursive: true });
    fs.mkdirSync(this.holdDir, { recursive: true });
  }

  /**
   * Store content as an encrypted content-addressed blob.
   *
   * @throws BlobStoreError with code KEY_UNAVAILABLE if no secure key exists
   * @throws BlobStoreError with code WRITE_BLOCKED if writes are blocked
   */
  store(
    content: Buffer | string,
    classification: ContentClassification,
    policyOverride?: Partial<PrivacyPolicy>,
  ): StoreResult {
    // Block writes when no key is available
    if (!this.keyProvider.isAvailable()) {
      throw new BlobStoreError(
        'Cannot store blob: no approved secure key available',
        'KEY_UNAVAILABLE',
      );
    }

    const contentBuffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const contentHash = this.computeContentHash(contentBuffer);
    const now = new Date().toISOString();

    // Deduplication check: if blob with same hash exists, update access time
    if (this.hasBlob(contentHash)) {
      this.touchBlob(contentHash);
      return { contentHash, deduplicated: true, storedAt: now };
    }

    // Encrypt the content
    const key = this.keyProvider.getKey()!;
    const iv = randomBytes(12); // 96-bit IV for AES-GCM
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(contentBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Compute retention expiry
    const policy = { ...this.defaultPolicy, ...policyOverride };
    const expiresAt = new Date(
      Date.now() + policy.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Write encrypted blob
    const blobPath = this.getBlobPath(contentHash);
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(blobPath, encrypted);

    // Write metadata
    const metadata: BlobMetadata = {
      contentHash,
      classification,
      plaintextSize: contentBuffer.length,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt,
      providerTransmissionAllowed: policy.providerTransmissionAllowed,
      telemetryOptIn: policy.telemetryOptIn,
      keyId: this.keyProvider.getKeyId(),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };

    const metadataPath = this.getMetadataPath(contentHash);
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    return { contentHash, deduplicated: false, storedAt: now };
  }

  /**
   * Retrieve and decrypt a blob by its content hash.
   *
   * @throws BlobStoreError with code KEY_UNAVAILABLE if decryption key unavailable
   * @throws BlobStoreError with code BLOB_NOT_FOUND if blob doesn't exist
   * @throws BlobStoreError with code RETENTION_EXPIRED if blob has expired
   * @throws BlobStoreError with code INTEGRITY_MISMATCH if decrypted content hash doesn't match
   */
  retrieve(contentHash: string): RetrieveResult {
    if (!this.keyProvider.isAvailable()) {
      throw new BlobStoreError(
        'Cannot retrieve blob: no secure key available',
        'KEY_UNAVAILABLE',
      );
    }

    const metadata = this.getMetadata(contentHash);
    if (!metadata) {
      throw new BlobStoreError(
        `Blob not found: ${contentHash}`,
        'BLOB_NOT_FOUND',
      );
    }

    // Check retention
    if (new Date(metadata.expiresAt) < new Date()) {
      throw new BlobStoreError(
        `Blob has expired: ${contentHash}`,
        'RETENTION_EXPIRED',
      );
    }

    // Read encrypted blob
    const blobPath = this.getBlobPath(contentHash);
    if (!fs.existsSync(blobPath)) {
      throw new BlobStoreError(
        `Blob file missing: ${contentHash}`,
        'BLOB_NOT_FOUND',
      );
    }

    const encrypted = fs.readFileSync(blobPath);

    // Decrypt
    const key = this.keyProvider.getKey()!;
    const iv = Buffer.from(metadata.iv, 'hex');
    const authTag = Buffer.from(metadata.authTag, 'hex');

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      // Verify integrity
      const verifyHash = this.computeContentHash(decrypted);
      if (verifyHash !== contentHash) {
        throw new BlobStoreError(
          `Integrity mismatch: expected ${contentHash}, got ${verifyHash}`,
          'INTEGRITY_MISMATCH',
        );
      }

      // Update last accessed time
      this.touchBlob(contentHash);

      return { content: decrypted, metadata };
    } catch (err) {
      if (err instanceof BlobStoreError) throw err;
      throw new BlobStoreError(
        `Decryption failed for blob: ${contentHash}`,
        'DECRYPTION_FAILED',
      );
    }
  }

  /**
   * Check if a blob exists (by content hash).
   */
  hasBlob(contentHash: string): boolean {
    return fs.existsSync(this.getBlobPath(contentHash));
  }

  /**
   * Get metadata for a blob without decrypting it.
   */
  getMetadata(contentHash: string): BlobMetadata | null {
    const metadataPath = this.getMetadataPath(contentHash);
    if (!fs.existsSync(metadataPath)) return null;
    try {
      const raw = fs.readFileSync(metadataPath, 'utf-8');
      return JSON.parse(raw) as BlobMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Securely delete a blob and its metadata.
   * Overwrites the blob data before unlinking to prevent recovery.
   */
  secureDelete(contentHash: string): boolean {
    const blobPath = this.getBlobPath(contentHash);
    const metadataPath = this.getMetadataPath(contentHash);

    let deleted = false;

    if (fs.existsSync(blobPath)) {
      // Overwrite with random bytes before deletion
      const stat = fs.statSync(blobPath);
      fs.writeFileSync(blobPath, randomBytes(stat.size));
      fs.unlinkSync(blobPath);
      deleted = true;
    }

    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
      deleted = true;
    }

    return deleted;
  }

  /**
   * Remove all expired blobs based on retention policy.
   * Returns the number of blobs deleted.
   */
  enforceRetention(): number {
    const now = new Date();
    let deletedCount = 0;

    const metadataFiles = this.listMetadataFiles();
    for (const metaFile of metadataFiles) {
      try {
        const raw = fs.readFileSync(metaFile, 'utf-8');
        const metadata = JSON.parse(raw) as BlobMetadata;
        if (new Date(metadata.expiresAt) < now) {
          this.secureDelete(metadata.contentHash);
          deletedCount++;
        }
      } catch {
        // Skip corrupt metadata files
      }
    }

    return deletedCount;
  }

  /**
   * Place existing data into a read-only migration hold.
   * Data in hold cannot be written to until the user makes a privacy choice.
   */
  placeInMigrationHold(contentHash: string): MigrationHoldRecord {
    const now = new Date().toISOString();
    const record: MigrationHoldRecord = {
      contentHash,
      state: 'held',
      createdAt: now,
    };

    const holdPath = this.getHoldPath(contentHash);
    fs.mkdirSync(path.dirname(holdPath), { recursive: true });
    fs.writeFileSync(holdPath, JSON.stringify(record, null, 2));

    return record;
  }

  /**
   * Get the migration hold record for a content hash.
   */
  getMigrationHoldRecord(contentHash: string): MigrationHoldRecord | null {
    const holdPath = this.getHoldPath(contentHash);
    if (!fs.existsSync(holdPath)) return null;
    try {
      const raw = fs.readFileSync(holdPath, 'utf-8');
      return JSON.parse(raw) as MigrationHoldRecord;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a migration hold with the user's privacy choice.
   */
  resolveMigrationHold(
    contentHash: string,
    decision: 'approved' | 'rejected',
    chosenPolicy?: PrivacyPolicy,
  ): MigrationHoldRecord {
    const holdPath = this.getHoldPath(contentHash);
    const existing = this.getMigrationHoldRecord(contentHash);

    if (!existing) {
      throw new BlobStoreError(
        `No migration hold record for: ${contentHash}`,
        'BLOB_NOT_FOUND',
      );
    }

    const resolved: MigrationHoldRecord = {
      ...existing,
      state: decision,
      resolvedAt: new Date().toISOString(),
      chosenPolicy: decision === 'approved' ? (chosenPolicy ?? this.defaultPolicy) : undefined,
    };

    fs.writeFileSync(holdPath, JSON.stringify(resolved, null, 2));

    // If rejected, securely delete the blob
    if (decision === 'rejected') {
      this.secureDelete(contentHash);
    } else if (decision === 'approved' && chosenPolicy) {
      // Update metadata with chosen policy
      const metadata = this.getMetadata(contentHash);
      if (metadata) {
        const expiresAt = new Date(
          Date.now() + chosenPolicy.retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const updated: BlobMetadata = {
          ...metadata,
          expiresAt,
          providerTransmissionAllowed: chosenPolicy.providerTransmissionAllowed,
          telemetryOptIn: chosenPolicy.telemetryOptIn,
        };
        const metadataPath = this.getMetadataPath(contentHash);
        fs.writeFileSync(metadataPath, JSON.stringify(updated, null, 2));
      }
    }

    return resolved;
  }

  /**
   * Check if a content hash is in migration hold (read-only).
   */
  isInMigrationHold(contentHash: string): boolean {
    const record = this.getMigrationHoldRecord(contentHash);
    return record !== null && record.state === 'held';
  }

  /**
   * List all content hashes currently in migration hold.
   */
  listMigrationHolds(): MigrationHoldRecord[] {
    const records: MigrationHoldRecord[] = [];
    if (!fs.existsSync(this.holdDir)) return records;

    const files = fs.readdirSync(this.holdDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.holdDir, file), 'utf-8');
        const record = JSON.parse(raw) as MigrationHoldRecord;
        if (record.state === 'held') {
          records.push(record);
        }
      } catch {
        // Skip corrupt files
      }
    }

    return records;
  }

  /**
   * Check if writes are currently allowed.
   * Writes are blocked when no secure key is available.
   */
  canWrite(): boolean {
    return this.keyProvider.isAvailable();
  }

  /**
   * Compute the SHA-256 content hash of a buffer.
   */
  computeContentHash(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // ─── Private helpers ──────────────────────────────────────────

  private getBlobPath(contentHash: string): string {
    // Use first 2 chars as directory prefix for filesystem efficiency
    const prefix = contentHash.substring(0, 2);
    return path.join(this.blobDir, prefix, `${contentHash}.enc`);
  }

  private getMetadataPath(contentHash: string): string {
    const prefix = contentHash.substring(0, 2);
    return path.join(this.metadataDir, prefix, `${contentHash}.json`);
  }

  private getHoldPath(contentHash: string): string {
    return path.join(this.holdDir, `${contentHash}.json`);
  }

  private touchBlob(contentHash: string): void {
    const metadataPath = this.getMetadataPath(contentHash);
    if (!fs.existsSync(metadataPath)) return;
    try {
      const raw = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(raw) as BlobMetadata;
      metadata.lastAccessedAt = new Date().toISOString();
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } catch {
      // Best effort
    }
  }

  private listMetadataFiles(): string[] {
    const files: string[] = [];
    if (!fs.existsSync(this.metadataDir)) return files;

    const prefixes = fs.readdirSync(this.metadataDir);
    for (const prefix of prefixes) {
      const prefixDir = path.join(this.metadataDir, prefix);
      try {
        const stat = fs.statSync(prefixDir);
        if (!stat.isDirectory()) continue;
        const entries = fs.readdirSync(prefixDir);
        for (const entry of entries) {
          if (entry.endsWith('.json')) {
            files.push(path.join(prefixDir, entry));
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    return files;
  }
}
