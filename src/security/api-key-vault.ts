/**
 * API Key Vault — Secure credential storage via macOS Keychain.
 *
 * Uses the `keytar` npm package to interact with macOS Keychain.
 * Keys are never written to disk in plaintext.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

// ─── Types ──────────────────────────────────────────────────────

export interface VaultEntry {
  providerId: string;
  maskedKey: string; // e.g. "sk-...abc123"
  createdAt: Date;
  lastUsed: Date;
}

export interface CredentialSet {
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  [providerId: string]: string | undefined;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ─── Key format patterns per provider ───────────────────────────

const KEY_FORMAT_RULES: Record<string, (key: string) => ValidationResult> = {
  openai: (key) =>
    key.startsWith('sk-')
      ? { valid: true }
      : { valid: false, error: 'OpenAI keys must start with "sk-"' },
  anthropic: (key) =>
    key.startsWith('sk-ant-')
      ? { valid: true }
      : { valid: false, error: 'Anthropic keys must start with "sk-ant-"' },
  gemini: (key) =>
    key.length > 0
      ? { valid: true }
      : { valid: false, error: 'Gemini key must be a non-empty string' },
};

const defaultValidator = (key: string): ValidationResult =>
  key.length > 0
    ? { valid: true }
    : { valid: false, error: 'API key must be a non-empty string' };

// ─── Helpers ────────────────────────────────────────────────────

export function maskKey(key: string): string {
  if (key.length <= 6) return '***';
  const prefix = key.slice(0, 3);
  const suffix = key.slice(-6);
  return `${prefix}...${suffix}`;
}

export function validateKeyFormat(
  providerId: string,
  apiKey: string,
): ValidationResult {
  const validator = Object.hasOwn(KEY_FORMAT_RULES, providerId)
    ? KEY_FORMAT_RULES[providerId]
    : defaultValidator;
  return validator(apiKey);
}

// ─── Keychain backend interface ─────────────────────────────────

export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

// ─── ApiKeyVault ────────────────────────────────────────────────

const SERVICE_NAME = 'ai-coding-superagent';
const META_SUFFIX = ':meta';

interface EntryMeta {
  createdAt: string;
  lastUsed: string;
}

export class ApiKeyVault {
  private keychain: KeychainBackend;

  constructor(keychain: KeychainBackend) {
    this.keychain = keychain;
  }

  /** Store an API key for a provider after validating its format. */
  async store(providerId: string, apiKey: string): Promise<void> {
    const validation = validateKeyFormat(providerId, apiKey);
    if (!validation.valid) {
      throw new Error(validation.error ?? 'Invalid API key format');
    }

    await this.keychain.setPassword(SERVICE_NAME, providerId, apiKey);

    // Persist metadata (created / last-used timestamps)
    const existingMeta = await this.getMeta(providerId);
    const meta: EntryMeta = {
      createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    await this.keychain.setPassword(
      SERVICE_NAME,
      `${providerId}${META_SUFFIX}`,
      JSON.stringify(meta),
    );
  }

  /** Retrieve the raw API key for a provider, or null if not stored. */
  async retrieve(providerId: string): Promise<string | null> {
    const key = await this.keychain.getPassword(SERVICE_NAME, providerId);
    if (key !== null) {
      // Update lastUsed
      const meta = await this.getMeta(providerId);
      if (meta) {
        meta.lastUsed = new Date().toISOString();
        await this.keychain.setPassword(
          SERVICE_NAME,
          `${providerId}${META_SUFFIX}`,
          JSON.stringify(meta),
        );
      }
    }
    return key;
  }

  /** Delete the stored API key for a provider. */
  async delete(providerId: string): Promise<void> {
    await this.keychain.deletePassword(SERVICE_NAME, providerId);
    await this.keychain.deletePassword(SERVICE_NAME, `${providerId}${META_SUFFIX}`);
  }

  /** List all stored vault entries (with masked keys). */
  async list(): Promise<VaultEntry[]> {
    const creds = await this.keychain.findCredentials(SERVICE_NAME);
    const entries: VaultEntry[] = [];

    for (const cred of creds) {
      // Skip metadata entries
      if (cred.account.endsWith(META_SUFFIX)) continue;

      const meta = await this.getMeta(cred.account);
      entries.push({
        providerId: cred.account,
        maskedKey: maskKey(cred.password),
        createdAt: meta ? new Date(meta.createdAt) : new Date(),
        lastUsed: meta ? new Date(meta.lastUsed) : new Date(),
      });
    }

    return entries;
  }

  /** Validate an API key format for a given provider (does not store). */
  validate(providerId: string, apiKey: string): ValidationResult {
    return validateKeyFormat(providerId, apiKey);
  }

  /** Get a unified credential set for cross-subsystem sharing. */
  async getUnifiedCredentials(): Promise<CredentialSet> {
    const creds = await this.keychain.findCredentials(SERVICE_NAME);
    const result: CredentialSet = {};

    for (const cred of creds) {
      if (cred.account.endsWith(META_SUFFIX)) continue;

      // Map well-known providers to named fields
      switch (cred.account) {
        case 'openai':
          result.openaiKey = cred.password;
          break;
        case 'anthropic':
          result.anthropicKey = cred.password;
          break;
        case 'gemini':
          result.geminiKey = cred.password;
          break;
        default:
          result[cred.account] = cred.password;
          break;
      }
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async getMeta(providerId: string): Promise<EntryMeta | null> {
    const raw = await this.keychain.getPassword(
      SERVICE_NAME,
      `${providerId}${META_SUFFIX}`,
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EntryMeta;
    } catch {
      return null;
    }
  }
}
