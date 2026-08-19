import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  CredentialService,
  type SecretProvider,
} from '../harness/credentials/credential-service.js';
import type { CredentialRef } from '../harness/credentials/schemas.js';
import type { KeyProvider } from '../storage/encrypted-blob-store.js';
import {
  ProxyCredentialStatusV1Schema,
  type ProxyCredentialStatusV1,
} from '../shared/app-bootstrap-ipc-contracts.js';
import { AppEditionSchema, type AppEdition } from '../shared/app-bootstrap-contracts.js';

export const PROXY_CREDENTIAL_REF_CONFIG_KEY = 'proxy-credential:ref:v1';
export const PROXY_CREDENTIAL_REF_ID = 'neuronest-llm-proxy';

const SafeStorageEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protection: z.literal('os-keychain'),
  ciphertext: z.string().min(1),
});

const AesEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protection: z.literal('aes-256-gcm'),
  keyId: z.string().min(1),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  authTag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().min(1),
});

const ProtectedSecretEnvelopeSchema = z.discriminatedUnion('protection', [
  SafeStorageEnvelopeSchema,
  AesEnvelopeSchema,
]);

const ProxyCredentialRefSchema = z.strictObject({
  refId: z.literal(PROXY_CREDENTIAL_REF_ID),
  providerType: z.literal('os-keychain'),
  providerKey: z.string().min(1),
  label: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  edition: AppEditionSchema,
  validationStatus: z.enum(['valid', 'invalid']),
  schemaVersion: z.literal(1),
});

export type ProxyCredentialRef = z.infer<typeof ProxyCredentialRefSchema>;

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ManagedSecretProvider extends SecretProvider {
  store(providerKey: string, value: string): void;
  remove(providerKey: string): boolean;
}

/**
 * Secret provider backed by `secrets_v2`.
 *
 * Electron safeStorage is preferred because it delegates protection to the OS
 * keychain/credential manager. If it is unavailable, the same row uses an
 * AES-256-GCM envelope protected by the supplied secure KeyProvider. Plaintext
 * is never written to SQLite in either mode.
 */
export class ProtectedSecretsV2Provider implements ManagedSecretProvider {
  readonly type = 'os-keychain' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly fallbackKeyProvider: KeyProvider,
  ) {}

  store(providerKey: string, value: string): void {
    if (value.length === 0) {
      throw new Error('Proxy credential cannot be empty');
    }

    const envelope = this.safeStorage.isEncryptionAvailable()
      ? this.encryptWithSafeStorage(value)
      : this.encryptWithFallback(value);

    this.db.prepare(`
      INSERT INTO secrets_v2 (key, envelope, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        envelope = excluded.envelope,
        updated_at = CURRENT_TIMESTAMP
    `).run(providerKey, JSON.stringify(envelope));
  }

  resolve(providerKey: string): string | undefined {
    const row = this.db
      .prepare('SELECT envelope FROM secrets_v2 WHERE key = ?')
      .get(providerKey) as { envelope: string } | undefined;
    if (!row) return undefined;

    try {
      const envelope = ProtectedSecretEnvelopeSchema.parse(JSON.parse(row.envelope));
      if (envelope.protection === 'os-keychain') {
        if (!this.safeStorage.isEncryptionAvailable()) return undefined;
        return this.safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
      }

      const key = this.fallbackKeyProvider.getKey();
      if (!key || key.length !== 32 || this.fallbackKeyProvider.getKeyId() !== envelope.keyId) {
        return undefined;
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  isAvailable(providerKey: string): boolean {
    return this.resolve(providerKey) !== undefined;
  }

  remove(providerKey: string): boolean {
    return this.db
      .prepare('DELETE FROM secrets_v2 WHERE key = ?')
      .run(providerKey).changes > 0;
  }

  private encryptWithSafeStorage(value: string): z.infer<typeof SafeStorageEnvelopeSchema> {
    return {
      schemaVersion: 1,
      protection: 'os-keychain',
      ciphertext: this.safeStorage.encryptString(value).toString('base64'),
    };
  }

  private encryptWithFallback(value: string): z.infer<typeof AesEnvelopeSchema> {
    const key = this.fallbackKeyProvider.getKey();
    if (!key || key.length !== 32) {
      throw new Error('Protected credential storage is unavailable');
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      schemaVersion: 1,
      protection: 'aes-256-gcm',
      keyId: this.fallbackKeyProvider.getKeyId(),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
}

export interface IssuedProxyCredential {
  credential: string;
  expiresAt?: string | null;
}

export interface ProxyCredentialIssuer {
  issueForAuthentication(input: {
    authEvidence: string;
    subjectId: string;
    edition: AppEdition;
  }): Promise<IssuedProxyCredential>;
  issueForActivation(input: {
    activationEvidence: string;
    installationId: string;
    edition: AppEdition;
  }): Promise<IssuedProxyCredential>;
  refresh(input: {
    currentCredential: string;
    edition: AppEdition;
  }): Promise<IssuedProxyCredential>;
}

export interface ProxyCredentialServiceDependencies {
  db: Database.Database;
  credentialService: CredentialService;
  secretProvider: ManagedSecretProvider;
  issuer?: ProxyCredentialIssuer;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Main-process authority for the edition-neutral NeuroNest Proxy Credential.
 * Public inspection returns only the closed renderer-safe status contract.
 */
export class ProxyCredentialService {
  private readonly db: Database.Database;
  private readonly credentialService: CredentialService;
  private readonly secretProvider: ManagedSecretProvider;
  private readonly issuer?: ProxyCredentialIssuer;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private activeRef: ProxyCredentialRef | undefined;

  constructor(dependencies: ProxyCredentialServiceDependencies) {
    this.db = dependencies.db;
    this.credentialService = dependencies.credentialService;
    this.secretProvider = dependencies.secretProvider;
    this.issuer = dependencies.issuer;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;

    this.credentialService.registerProvider(this.secretProvider);
    this.loadPersistedRef();
  }

  async provisionFromAuthentication(input: {
    authEvidence: string;
    subjectId: string;
    edition: AppEdition;
  }): Promise<ProxyCredentialStatusV1> {
    const issuer = this.requireIssuer();
    const issued = await issuer.issueForAuthentication({
      ...input,
      edition: AppEditionSchema.parse(input.edition),
    });
    return this.provision({ ...issued, edition: input.edition });
  }

  async provisionFromActivation(input: {
    activationEvidence: string;
    installationId: string;
    edition: AppEdition;
  }): Promise<ProxyCredentialStatusV1> {
    const issuer = this.requireIssuer();
    const issued = await issuer.issueForActivation({
      ...input,
      edition: AppEditionSchema.parse(input.edition),
    });
    return this.provision({ ...issued, edition: input.edition });
  }

  async refresh(): Promise<ProxyCredentialStatusV1> {
    const issuer = this.requireIssuer();
    const ref = this.activeRef;
    const resolved = ref
      ? this.credentialService.resolveAtBoundary(ref.refId)
      : undefined;
    if (!ref || !resolved) return this.status('invalid');

    const issued = await issuer.refresh({
      currentCredential: resolved.value,
      edition: ref.edition,
    });
    return this.provision({ ...issued, edition: ref.edition });
  }

  provision(input: IssuedProxyCredential & { edition: AppEdition }): ProxyCredentialStatusV1 {
    const edition = AppEditionSchema.parse(input.edition);
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null) z.string().datetime().parse(expiresAt);
    if (!input.credential) throw new Error('Proxy credential cannot be empty');

    const now = this.now().toISOString();
    const previousRef = this.activeRef;
    const providerKey = `proxy-credential-${this.createId()}`;
    const nextRef = ProxyCredentialRefSchema.parse({
      refId: PROXY_CREDENTIAL_REF_ID,
      providerType: this.secretProvider.type,
      providerKey,
      label: 'NeuroNest LLM Proxy',
      createdAt: previousRef?.createdAt ?? now,
      updatedAt: now,
      expiresAt,
      edition,
      validationStatus: 'valid',
      schemaVersion: 1,
    });

    this.secretProvider.store(providerKey, input.credential);
    try {
      this.persistRef(nextRef);
      this.credentialService.storeRef(nextRef as CredentialRef);
      this.activeRef = nextRef;
    } catch (error) {
      this.secretProvider.remove(providerKey);
      throw error;
    }

    if (previousRef?.providerKey && previousRef.providerKey !== providerKey) {
      this.secretProvider.remove(previousRef.providerKey);
    }
    return this.getRendererStatus();
  }

  markInvalid(): ProxyCredentialStatusV1 {
    if (!this.activeRef) return this.status('invalid');
    const invalidRef = ProxyCredentialRefSchema.parse({
      ...this.activeRef,
      validationStatus: 'invalid',
      updatedAt: this.now().toISOString(),
    });
    this.persistRef(invalidRef);
    this.credentialService.storeRef(invalidRef as CredentialRef);
    this.activeRef = invalidRef;
    return this.status('invalid');
  }

  getRendererStatus(): ProxyCredentialStatusV1 {
    const ref = this.activeRef;
    if (!ref || ref.validationStatus === 'invalid') return this.status('invalid');
    if (ref.expiresAt !== null && Date.parse(ref.expiresAt) <= this.now().getTime()) {
      return this.status('expired');
    }
    const availability = this.credentialService.getAvailability(ref.refId);
    return this.status(availability?.available ? 'available' : 'invalid');
  }

  /** Resolve only for a main-process network operation. Never expose via IPC. */
  resolveAtBoundary(): string | undefined {
    if (this.getRendererStatus().status !== 'available' || !this.activeRef) {
      return undefined;
    }
    return this.credentialService.resolveAtBoundary(this.activeRef.refId)?.value;
  }

  private loadPersistedRef(): void {
    const row = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(PROXY_CREDENTIAL_REF_CONFIG_KEY) as { value: string } | undefined;
    if (!row) return;

    try {
      const ref = ProxyCredentialRefSchema.parse(JSON.parse(row.value));
      this.credentialService.storeRef(ref as CredentialRef);
      this.activeRef = ref;
    } catch {
      // Corrupt references fail closed and are never forwarded to the renderer.
      this.activeRef = undefined;
    }
  }

  private persistRef(ref: ProxyCredentialRef): void {
    this.db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(PROXY_CREDENTIAL_REF_CONFIG_KEY, JSON.stringify(ref));
  }

  private status(status: 'available' | 'invalid' | 'expired'): ProxyCredentialStatusV1 {
    return ProxyCredentialStatusV1Schema.parse({
      schemaVersion: 1,
      status,
      checkedAt: this.now().toISOString(),
    });
  }

  private requireIssuer(): ProxyCredentialIssuer {
    if (!this.issuer) {
      throw new Error('Proxy credential issuer is not configured');
    }
    return this.issuer;
  }
}
