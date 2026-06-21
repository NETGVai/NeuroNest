/**
 * Credential Vault — AES-256-GCM encrypted credential storage with scoped access.
 *
 * Stores encrypted credentials on disk, derives encryption keys from either
 * the OS keychain or a user-provided master password (PBKDF2). Injects
 * credentials at request time via a proxy-header pattern so raw values never
 * appear in agent context or conversation history.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface VaultConfig {
  /** Directory path where encrypted credential files are stored */
  storePath: string;
  /** Key derivation strategy */
  keyDerivation: 'os-keychain' | 'master-password';
  /** Encryption algorithm (only AES-256-GCM supported) */
  encryption: 'aes-256-gcm';
}

export interface CredentialScope {
  /** The agent role identifier */
  agentRole: string;
  /** Credential names this role is allowed to access */
  allowedCredentials: string[];
}

export interface StoredCredential {
  /** AES-256-GCM encrypted value (base64) */
  ciphertext: string;
  /** Initialization vector (base64) */
  iv: string;
  /** GCM authentication tag (base64) */
  authTag: string;
  /** PBKDF2 salt used for key derivation (base64), present when using master-password */
  salt: string;
  /** Roles allowed to access this credential */
  scopes: string[];
  /** Timestamp when credential was stored */
  createdAt: string;
}

export interface VaultAccessDeniedEvent {
  credentialName: string;
  agentRole: string;
  timestamp: string;
}

// ─── Keychain Backend Interface ─────────────────────────────────

/**
 * Abstraction over OS keychain for key retrieval.
 * Implementations can wrap macOS Keychain, Windows Credential Manager, etc.
 */
export interface KeychainProvider {
  getKey(service: string, account: string): Promise<string | null>;
  setKey(service: string, account: string, value: string): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────

const VAULT_SERVICE_NAME = 'neuronest-credential-vault';
const VAULT_ACCOUNT_NAME = 'vault-master-key';
const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-SHA256
const KEY_LENGTH = 32; // 256 bits for AES-256
const IV_LENGTH = 12; // 96 bits recommended for GCM
const SALT_LENGTH = 32; // 256 bits

// ─── Credential Vault ───────────────────────────────────────────

export class CredentialVault {
  private config: VaultConfig;
  private scopes: Map<string, CredentialScope> = new Map();
  private keychainProvider: KeychainProvider | null = null;
  private masterPassword: string | null = null;
  private accessDeniedLog: VaultAccessDeniedEvent[] = [];

  constructor(config: VaultConfig, keychainProvider?: KeychainProvider) {
    this.config = config;
    this.keychainProvider = keychainProvider ?? null;
    this.ensureStoreDir();
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Register credential scopes for an agent role.
   */
  registerScope(scope: CredentialScope): void {
    this.scopes.set(scope.agentRole, scope);
  }

  /**
   * Set master password for PBKDF2 key derivation.
   * Used when keyDerivation is 'master-password'.
   */
  setMasterPassword(password: string): void {
    this.masterPassword = password;
  }

  /**
   * Store an encrypted credential with scoped access.
   *
   * Encrypts the value using AES-256-GCM with a key derived from
   * either the OS keychain or a master password via PBKDF2.
   */
  async store(name: string, value: string, scope: string[]): Promise<void> {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = await this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const entry: StoredCredential = {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      salt: salt.toString('base64'),
      scopes: scope,
      createdAt: new Date().toISOString(),
    };

    const filePath = this.credentialPath(name);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  }

  /**
   * Inject a credential for an agent role.
   *
   * Returns a proxy-safe reference header value rather than the raw credential,
   * preventing exposure of the secret in agent context. The raw value is
   * decrypted only at request time and injected via the local HTTPS proxy.
   *
   * Throws if the agent role does not have access to the credential.
   * Throws if the vault key is unavailable.
   */
  async inject(name: string, agentRole: string): Promise<string> {
    if (!this.checkScope(name, agentRole)) {
      this.logAccessDenied(name, agentRole);
      throw new VaultAccessDeniedError(
        `Agent role "${agentRole}" is not authorized to access credential "${name}"`,
      );
    }

    // Decrypt the credential to validate it exists and is accessible
    await this.decrypt(name);

    // Return a proxy header reference — the raw credential is injected
    // at request time by the local HTTPS proxy, never exposed to agent context
    return `X-Vault-Credential: ${name}`;
  }

  /**
   * Decrypt and retrieve a credential value.
   * This is used internally by the proxy layer — not exposed to agents.
   */
  async decrypt(name: string): Promise<string> {
    const filePath = this.credentialPath(name);

    if (!fs.existsSync(filePath)) {
      throw new VaultError(`Credential "${name}" not found in vault`);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: StoredCredential = JSON.parse(raw);

    const salt = Buffer.from(entry.salt, 'base64');
    const key = await this.deriveKey(salt);
    const iv = Buffer.from(entry.iv, 'base64');
    const authTag = Buffer.from(entry.authTag, 'base64');
    const ciphertext = Buffer.from(entry.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Check whether a credential exists in the vault.
   */
  exists(name: string): boolean {
    return fs.existsSync(this.credentialPath(name));
  }

  /**
   * Delete a credential from the vault.
   */
  delete(name: string): void {
    const filePath = this.credentialPath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * List all stored credential names.
   */
  list(): string[] {
    if (!fs.existsSync(this.config.storePath)) return [];
    return fs
      .readdirSync(this.config.storePath)
      .filter((f) => f.endsWith('.vault.json'))
      .map((f) => f.replace('.vault.json', ''));
  }

  /**
   * Get recorded access-denied events for auditing.
   */
  getAccessDeniedLog(): VaultAccessDeniedEvent[] {
    return [...this.accessDeniedLog];
  }

  // ── Scope Management ────────────────────────────────────────

  /**
   * Check if a given agent role has access to a credential.
   * Returns false if the role has no registered scope or the credential
   * is not in the role's allowedCredentials list.
   */
  private checkScope(name: string, agentRole: string): boolean {
    const scope = this.scopes.get(agentRole);
    if (!scope) return false;
    return scope.allowedCredentials.includes(name);
  }

  // ── Redaction ───────────────────────────────────────────────

  /**
   * Redact credential-like strings from trace log output.
   * Replaces long base64-like sequences with [VAULT:redacted] placeholders.
   */
  static redact(text: string): string {
    return text.replace(/[A-Za-z0-9+/=]{20,}/g, '[VAULT:redacted]');
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Derive a 256-bit encryption key from the configured source.
   */
  private async deriveKey(salt: Buffer): Promise<Buffer> {
    if (this.config.keyDerivation === 'os-keychain') {
      return this.deriveKeyFromKeychain(salt);
    }
    return this.deriveKeyFromMasterPassword(salt);
  }

  /**
   * Derive key from OS keychain.
   * Retrieves a stored secret from the system keychain and uses it
   * as the base material for PBKDF2 key derivation.
   */
  private async deriveKeyFromKeychain(salt: Buffer): Promise<Buffer> {
    if (!this.keychainProvider) {
      throw new VaultAuthenticationRequiredError(
        'OS keychain provider not available. Please configure a keychain provider or use master-password mode.',
      );
    }

    let keychainSecret = await this.keychainProvider.getKey(
      VAULT_SERVICE_NAME,
      VAULT_ACCOUNT_NAME,
    );

    if (!keychainSecret) {
      // Generate and store a new vault key in the keychain
      keychainSecret = crypto.randomBytes(32).toString('hex');
      await this.keychainProvider.setKey(
        VAULT_SERVICE_NAME,
        VAULT_ACCOUNT_NAME,
        keychainSecret,
      );
    }

    return new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(
        keychainSecret as string,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha256',
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        },
      );
    });
  }

  /**
   * Derive key from user-provided master password via PBKDF2.
   */
  private deriveKeyFromMasterPassword(salt: Buffer): Promise<Buffer> {
    if (!this.masterPassword) {
      throw new VaultAuthenticationRequiredError(
        'Vault master password not provided. Please authenticate to access the credential vault.',
      );
    }

    return new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(
        this.masterPassword as string,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha256',
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        },
      );
    });
  }

  /**
   * Get the file path for a named credential.
   */
  private credentialPath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.storePath, `${safeName}.vault.json`);
  }

  /**
   * Ensure the vault store directory exists.
   */
  private ensureStoreDir(): void {
    if (!fs.existsSync(this.config.storePath)) {
      fs.mkdirSync(this.config.storePath, { recursive: true });
    }
  }

  /**
   * Log an access-denied event for audit purposes.
   */
  private logAccessDenied(credentialName: string, agentRole: string): void {
    this.accessDeniedLog.push({
      credentialName,
      agentRole,
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Error Classes ──────────────────────────────────────────────

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export class VaultAccessDeniedError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAccessDeniedError';
  }
}

export class VaultAuthenticationRequiredError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAuthenticationRequiredError';
  }
}
