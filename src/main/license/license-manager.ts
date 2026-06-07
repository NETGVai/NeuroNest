/**
 * License key management core class and types.
 *
 * Encapsulates license API interactions, SQLite persistence, and plan derivation.
 * Integrates with the external SaaS API at https://neuronest.cc.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 1.2, 7.3
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type Plan = 'community' | 'professional' | 'enterprise';

export interface LicenseData {
  licenseKey: string;
  invitationCode: string;
  email: string;
  algorithm: string;
  features: string[];
  expiresAt: string;       // ISO 8601 date
  plan: Plan;              // derived from features
  hwid: string;
  markUsedPending: boolean;
  firstName: string;
  lastName: string;
  referralCode: string;
  referralUrl: string;
  /**
   * `NN_{32 lowercase hex}` bearer token used to authenticate against the
   * `llm.neuronest.cc` proxy. Issued by the `worker/www` `GET
   * /api/service/keys/:inviteCode` endpoint for PQC-activated paid users.
   * Empty string for community users and for paid users whose key has not
   * yet been issued (graceful fallback).
   */
  llmLicenseKey: string;
}

export interface ValidationResult {
  valid: boolean;
  offline: boolean;
}

export interface LicenseManagerDeps {
  db: Database.Database;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVITATION_CODE_REGEX = /^PQC-[A-Z0-9]{8}-[A-Z0-9]{8}$/;

const API_BASE_URL = 'https://neuronest.cc';
const API_BEARER_TOKEN = 'nn_sk_NxZu2pUJ7AGbe5MOLEdf7yq0hYvie0aIeZfmxm7f';

/**
 * Get the platform string for API requests.
 * Convention: macos-arm64, macos-intel, windows-x64, windows-arm64, linux-x64, linux-arm64
 */
function getPlatformString(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64' : 'macos-intel';
  } else if (platform === 'win32') {
    return arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  } else {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
}

/**
 * Get the app version string for API requests.
 */
function getAppVersion(): string {
  try {
    const { app } = require('electron');
    return app.getVersion() || '0.0.0';
  } catch {
    // Fallback: read from package.json
    try {
      const pkgPath = path.join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

// ---------------------------------------------------------------------------
// LicenseManager
// ---------------------------------------------------------------------------

export class LicenseManager {
  private db: Database.Database;

  constructor(deps: LicenseManagerDeps) {
    this.db = deps.db;
  }

  /**
   * Derive the subscription plan from a features array.
   *
   * Priority: enterprise > professional > community.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  static derivePlan(features: string[]): Plan {
    for (const f of features) {
      const lower = f.toLowerCase().trim();
      if (lower === 'enterprise' || lower === 'ent' || lower.startsWith('enterprise')) return 'enterprise';
    }
    for (const f of features) {
      const lower = f.toLowerCase().trim();
      if (lower === 'professional' || lower === 'pro' || lower.startsWith('professional')) return 'professional';
    }
    return 'community';
  }

  /**
   * Derive a hardware identifier (HWID) from the machine.
   *
   * Uses hostname + platform + arch + cpus as a stable fingerprint,
   * hashed with SHA-256.
   *
   * Requirement: 7.3
   */
  static getHWID(): string {
    const raw = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus().map((c) => c.model).join(','),
    ].join('|');

    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Get or create a persistent app instance ID.
   *
   * Reads from ~/.neuronest/app-id if it exists, otherwise generates a new
   * UUID and writes it to disk. This is the same file used by the auth
   * FlowController, ensuring a single consistent appId across the app.
   */
  static getOrCreateAppId(): string {
    const appIdPath = path.join(os.homedir(), '.neuronest', 'app-id');
    try {
      if (fs.existsSync(appIdPath)) {
        const existing = fs.readFileSync(appIdPath, 'utf-8').trim();
        if (existing) return existing;
      }
    } catch { /* fall through to create */ }
    const appId = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(appIdPath), { recursive: true });
      fs.writeFileSync(appIdPath, appId, { mode: 0o600 });
    } catch { /* best effort — return the generated ID even if write fails */ }
    return appId;
  }

  /**
   * Validate that a string matches the invitation code format:
   * `PQC-XXXXXXXX-YYYYYYYY` where X/Y are uppercase alphanumeric.
   *
   * Requirement: 1.2
   */
  static isValidInvitationCode(code: string): boolean {
    return INVITATION_CODE_REGEX.test(code);
  }

  /**
   * Read the stored license from the SQLite config table.
   *
   * Returns `null` if no license data is stored (specifically if `license:key`
   * is not found).
   *
   * Requirements: 9.5, 3.1
   */
  getStoredLicense(): LicenseData | null {
    if (!this.db) {
      console.warn('[LicenseManager] Cannot read stored license — database unavailable');
      return null;
    }
    const get = this.db.prepare('SELECT value FROM config WHERE key = ?');

    const licenseKeyRow = get.get('license:key') as { value: string } | undefined;
    if (!licenseKeyRow) {
      return null;
    }

    const invitationCodeRow = get.get('license:invitation-code') as { value: string } | undefined;
    const emailRow = get.get('license:email') as { value: string } | undefined;
    const algorithmRow = get.get('license:algorithm') as { value: string } | undefined;
    const featuresRow = get.get('license:features') as { value: string } | undefined;
    const expiresAtRow = get.get('license:expires-at') as { value: string } | undefined;
    const hwidRow = get.get('license:hwid') as { value: string } | undefined;
    const markUsedPendingRow = get.get('license:mark-used-pending') as { value: string } | undefined;
    const firstNameRow = get.get('license:first-name') as { value: string } | undefined;
    const lastNameRow = get.get('license:last-name') as { value: string } | undefined;
    const referralCodeRow = get.get('license:referral-code') as { value: string } | undefined;
    const referralUrlRow = get.get('license:referral-url') as { value: string } | undefined;
    const llmLicenseKeyRow = get.get('license:llm-license-key') as { value: string } | undefined;

    const features: string[] = featuresRow ? JSON.parse(featuresRow.value) : [];

    return {
      licenseKey: licenseKeyRow.value,
      invitationCode: invitationCodeRow?.value ?? '',
      email: emailRow?.value ?? '',
      algorithm: algorithmRow?.value ?? '',
      features,
      expiresAt: expiresAtRow?.value ?? '',
      plan: LicenseManager.derivePlan(features),
      hwid: hwidRow?.value ?? '',
      markUsedPending: markUsedPendingRow?.value === 'true',
      firstName: firstNameRow?.value ?? '',
      lastName: lastNameRow?.value ?? '',
      referralCode: referralCodeRow?.value ?? '',
      referralUrl: referralUrlRow?.value ?? '',
      llmLicenseKey: llmLicenseKeyRow?.value ?? '',
    };
  }

  /**
   * Persist license data to the SQLite config table.
   *
   * Each field is stored as a separate config row using INSERT OR REPLACE.
   * The `features` array is JSON-stringified before storage.
   *
   * Note: Intended for internal use only — called by API methods (fetchByCode,
   * generate, etc.). Left non-private for testability.
   *
   * Requirements: 1.3, 4.5, 6.2
   */
  storeLicense(data: LicenseData): void {
    if (!this.db) {
      console.warn('[LicenseManager] Cannot store license — database unavailable');
      return;
    }
    const upsert = this.db.prepare(
      "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );

    upsert.run('license:key', data.licenseKey);
    upsert.run('license:invitation-code', data.invitationCode);
    upsert.run('license:email', data.email);
    upsert.run('license:algorithm', data.algorithm);
    upsert.run('license:features', JSON.stringify(data.features));
    upsert.run('license:expires-at', data.expiresAt);
    upsert.run('license:hwid', data.hwid);
    upsert.run('license:mark-used-pending', String(data.markUsedPending));
    upsert.run('license:first-name', data.firstName);
    upsert.run('license:last-name', data.lastName);
    if (data.referralCode) upsert.run('license:referral-code', data.referralCode);
    if (data.referralUrl) upsert.run('license:referral-url', data.referralUrl);
    // The proxy bearer token is `NN_{32 lowercase hex}`. Persist when the
    // value matches the canonical shape OR is an empty string (community /
    // pre-issuance). A missing or malformed field never silently overwrites
    // a previously-valid token.
    if (typeof data.llmLicenseKey === 'string') {
      if (data.llmLicenseKey === '' || /^NN_[0-9a-f]{32}$/.test(data.llmLicenseKey)) {
        upsert.run('license:llm-license-key', data.llmLicenseKey);
      }
    }
  }

  /**
   * Fetch a license by invitation code from the API.
   *
   * Validates the code format, calls the API, maps the response to
   * `LicenseData`, and persists it locally. Sets `markUsedPending` to `true`
   * initially (caller is responsible for calling `markUsed` afterwards).
   *
   * Requirements: 1.2, 1.3, 1.5, 9.1
   */
  async fetchByCode(code: string): Promise<LicenseData> {
    if (!LicenseManager.isValidInvitationCode(code)) {
      throw new Error(`Invalid invitation code format: "${code}". Expected format: PQC-XXXXXXXX-YYYYYYYY`);
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/service/keys/${encodeURIComponent(code)}?platform=${encodeURIComponent(getPlatformString())}&version=${encodeURIComponent(getAppVersion())}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${API_BEARER_TOKEN}`,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error while fetching license for code "${code}": ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `License API returned ${response.status} for code "${code}"${body ? `: ${body}` : ''}`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Malformed JSON response from license API for code "${code}"`);
    }

    const apiResponse = data as Record<string, unknown>;

    // The API returns snake_case field names:
    //   license_key, code, user_email, algorithm, features, expiry_date
    // Also accept the camelCase variants from the design doc for forward compat.
    const licenseKey = (apiResponse.license_key ?? apiResponse.key) as string | undefined;
    const invitationCode = (apiResponse.code) as string | undefined;
    const email = (apiResponse.user_email ?? apiResponse.email) as string | undefined;
    const algorithm = (apiResponse.algorithm) as string | undefined;
    const features = apiResponse.features as string[] | undefined;
    const expiresAt = (apiResponse.expiry_date ?? apiResponse.expiresAt) as string | undefined;

    if (
      typeof licenseKey !== 'string' ||
      typeof invitationCode !== 'string' ||
      typeof email !== 'string' ||
      typeof algorithm !== 'string' ||
      !Array.isArray(features) ||
      typeof expiresAt !== 'string'
    ) {
      throw new Error(
        `Malformed API response for code "${code}": missing or invalid required fields`
      );
    }

    // Normalize features to lowercase for consistent plan derivation
    const normalizedFeatures = features.map((f: string) => f.toLowerCase());

    // Derive plan: prefer explicit plan field from API, fall back to feature-based derivation
    const apiPlan = (apiResponse.plan ?? apiResponse.subscription_plan ?? apiResponse.tier) as string | undefined;
    let derivedPlan: Plan;
    if (apiPlan && (apiPlan.toLowerCase() === 'professional' || apiPlan.toLowerCase() === 'pro')) {
      derivedPlan = 'professional';
    } else if (apiPlan && (apiPlan.toLowerCase() === 'enterprise' || apiPlan.toLowerCase() === 'ent')) {
      derivedPlan = 'enterprise';
    } else {
      derivedPlan = LicenseManager.derivePlan(normalizedFeatures);
    }

    console.log('[LicenseManager] fetchByCode plan derivation:', { code, features: normalizedFeatures, apiPlan, derivedPlan });

    // Extract the llm-proxy bearer token if the worker provided one.
    // The API may return the field as camelCase `llmLicenseKey` (new format)
    // or snake_case `llm_license_key` (legacy). Only persist values matching
    // the canonical `NN_{32 lowercase hex}` format. Pre-mint worker versions
    // return undefined here, in which case we preserve the existing stored
    // value rather than blanking it.
    const apiLlmKey = (apiResponse.llmLicenseKey ?? apiResponse['llm_license_key']) as string | undefined;
    let resolvedLlmKey = '';
    if (typeof apiLlmKey === 'string' && /^NN_[0-9a-f]{32}$/.test(apiLlmKey)) {
      resolvedLlmKey = apiLlmKey;
    } else if (apiLlmKey && typeof apiLlmKey === 'string') {
      // Malformed value — discard with a warning rather than persisting garbage.
      console.warn('[LicenseManager] Discarding malformed llmLicenseKey from API response:', apiLlmKey);
      // Preserve any existing stored value
      const prev = this.getStoredLicense();
      if (prev && prev.llmLicenseKey) {
        resolvedLlmKey = prev.llmLicenseKey;
      }
    } else {
      // No key in response — preserve any existing stored value across a
      // refresh from a worker version that does not yet return llmLicenseKey.
      const prev = this.getStoredLicense();
      if (prev && prev.llmLicenseKey) {
        resolvedLlmKey = prev.llmLicenseKey;
      }
    }

    const licenseData: LicenseData = {
      licenseKey,
      invitationCode,
      email,
      algorithm,
      features: normalizedFeatures,
      expiresAt,
      plan: derivedPlan,
      hwid: LicenseManager.getHWID(),
      markUsedPending: true,
      firstName: (apiResponse.first_name ?? apiResponse.firstName ?? '') as string,
      lastName: (apiResponse.last_name ?? apiResponse.lastName ?? '') as string,
      referralCode: ((apiResponse.referralCode ?? apiResponse.referral_code ?? apiResponse.refCode ?? apiResponse.ref_code) as string) || '',
      referralUrl: ((apiResponse.referralUrl ?? apiResponse.referral_url ?? apiResponse.refUrl ?? apiResponse.ref_url) as string) || '',
      llmLicenseKey: resolvedLlmKey,
    };

    this.storeLicense(licenseData);

    return licenseData;
  }

  /**
   * Generate a new license key via the API.
   *
   * Calls `POST /api/service/keys/generate` with the provided email, HWID,
   * algorithm, and features. Maps the response to `LicenseData`, derives the
   * plan, and persists it locally. Sets `markUsedPending` to `true` — the
   * caller is responsible for calling `markUsed()` afterwards.
   *
   * Requirements: 5.3, 5.4, 6.1, 6.2, 9.3
   */
  async generate(
    email: string,
    hwid: string,
    algorithm: string,
    features: string[]
  ): Promise<LicenseData> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/service/keys/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_BEARER_TOKEN}`,
        },
        body: JSON.stringify({ email, hwid, algorithm, features }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error while generating license key: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `License API returned ${response.status} while generating key${body ? `: ${body}` : ''}`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error('Malformed JSON response from license API during key generation');
    }

    const apiResponse = data as Record<string, unknown>;

    const licenseKey = (apiResponse.license_key ?? apiResponse.key) as string | undefined;
    const invitationCode = (apiResponse.code) as string | undefined;
    const genEmail = (apiResponse.user_email ?? apiResponse.email) as string | undefined;
    const genAlgorithm = (apiResponse.algorithm) as string | undefined;
    const genFeatures = apiResponse.features as string[] | undefined;
    const expiresAt = (apiResponse.expiry_date ?? apiResponse.expiresAt) as string | undefined;

    if (
      typeof licenseKey !== 'string' ||
      typeof invitationCode !== 'string' ||
      typeof genEmail !== 'string' ||
      typeof genAlgorithm !== 'string' ||
      !Array.isArray(genFeatures) ||
      typeof expiresAt !== 'string'
    ) {
      throw new Error(
        'Malformed API response during key generation: missing or invalid required fields'
      );
    }

    const normalizedFeatures = genFeatures.map((f: string) => f.toLowerCase());

    // The generate endpoint does not currently return llmLicenseKey, but
    // accept it forward-compatibly. Only persist values matching the
    // canonical `NN_{32 lowercase hex}` format. Discard malformed values
    // with a console warning.
    const apiLlmKey = (apiResponse.llmLicenseKey ?? apiResponse['llm_license_key']) as string | undefined;
    let resolvedLlmKey = '';
    if (typeof apiLlmKey === 'string' && /^NN_[0-9a-f]{32}$/.test(apiLlmKey)) {
      resolvedLlmKey = apiLlmKey;
    } else if (apiLlmKey && typeof apiLlmKey === 'string') {
      console.warn('[LicenseManager] Discarding malformed llmLicenseKey from API response:', apiLlmKey);
    }

    const licenseData: LicenseData = {
      licenseKey,
      invitationCode,
      email: genEmail,
      algorithm: genAlgorithm,
      features: normalizedFeatures,
      expiresAt,
      plan: LicenseManager.derivePlan(normalizedFeatures),
      hwid,
      markUsedPending: true,
      firstName: (apiResponse.first_name ?? apiResponse.firstName ?? '') as string,
      lastName: (apiResponse.last_name ?? apiResponse.lastName ?? '') as string,
      referralCode: '',
      referralUrl: '',
      llmLicenseKey: resolvedLlmKey,
    };

    this.storeLicense(licenseData);

    return licenseData;
  }

  /**
   * Mark a license key as used on this machine.
   *
   * Calls `PATCH /api/service/keys/{code}/use` with the given HWID, appId,
   * email, and optional feature.
   * On success, sets `license:mark-used-pending` to `"false"`.
   * On any failure (network error or non-OK response), sets
   * `license:mark-used-pending` to `"true"` so it can be retried on next launch.
   *
   * Requirements: 7.1, 7.2, 9.4
   */
  async markUsed(code: string, hwid: string, appId?: string, email?: string, feature?: string): Promise<{ success: boolean; referralCode?: string; referralUrl?: string }> {
    const upsert = this.db.prepare(
      "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );

    try {
      // Build the request body with all required fields
      // Resolve appId: if not provided or empty, read from ~/.neuronest/app-id
      const resolvedAppId = (appId && appId.trim()) ? appId : LicenseManager.getOrCreateAppId();
      const body: Record<string, string | undefined> = { hwid, appId: resolvedAppId, platform: getPlatformString(), version: getAppVersion() };
      
      // Include email — pull from stored license if not provided
      if (email) {
        body.email = email;
      } else {
        const stored = this.getStoredLicense();
        if (stored?.email) {
          body.email = stored.email;
        }
      }

      // Include feature if provided
      if (feature) {
        body.feature = feature;
      }

      console.log('[LicenseManager] markUsed PATCH body:', JSON.stringify(body));

      const response = await fetch(
        `${API_BASE_URL}/api/service/keys/${encodeURIComponent(code)}/use`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_BEARER_TOKEN}`,
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        upsert.run('license:mark-used-pending', 'true');
        return { success: false };
      }

      // Parse response to extract referralCode and referralUrl
      let referralCode: string | undefined;
      let referralUrl: string | undefined;
      try {
        const respData = await response.json() as Record<string, unknown>;
        console.log('[LicenseManager] markUsed response body:', JSON.stringify(respData));
        // Try multiple field name variants (camelCase, snake_case, etc.)
        referralCode = (respData.referralCode ?? respData.referral_code ?? respData.refCode ?? respData.ref_code) as string | undefined;
        referralUrl = (respData.referralUrl ?? respData.referral_url ?? respData.refUrl ?? respData.ref_url) as string | undefined;
        if (referralCode) upsert.run('license:referral-code', referralCode);
        if (referralUrl) upsert.run('license:referral-url', referralUrl);

        // Extract and persist the LLM license key if present and valid.
        // Only persist values matching the canonical `NN_{32 lowercase hex}`
        // format. Malformed values are discarded with a console warning.
        const llmKey = (respData.llmLicenseKey ?? respData.llm_license_key) as string | undefined;
        if (typeof llmKey === 'string' && /^NN_[0-9a-f]{32}$/.test(llmKey)) {
          upsert.run('license:llm-license-key', llmKey);
        } else if (llmKey && typeof llmKey === 'string') {
          console.warn('[LicenseManager] Discarding malformed llmLicenseKey from markUsed response:', llmKey);
        }
      } catch (parseErr) {
        console.log('[LicenseManager] markUsed response parse error:', parseErr);
      }

      upsert.run('license:mark-used-pending', 'false');
      return { success: true, referralCode, referralUrl };
    } catch {
      // Network error — mark as pending for retry on next launch
      upsert.run('license:mark-used-pending', 'true');
      return { success: false };
    }
  }

  /**
   * Update the features (plan) associated with a license key.
   *
   * Calls `PATCH /api/service/keys/{code}/use` with the new features array.
   * On success, updates the local license store with the new features and
   * derived plan.
   *
   * Requirements: 6.1, 6.2
   */
  async updateFeatures(code: string, features: string[]): Promise<{ success: boolean }> {
    const stored = this.getStoredLicense();
    const hwid = stored?.hwid ?? LicenseManager.getHWID();
    const appId = stored?.invitationCode ? '' : '';

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/service/keys/${encodeURIComponent(code)}/use`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_BEARER_TOKEN}`,
          },
          body: JSON.stringify({ hwid, features }),
        }
      );

      if (!response.ok) {
        return { success: false };
      }

      // Update local store with new features and derived plan
      if (stored) {
        const normalizedFeatures = features.map((f: string) => f.toLowerCase());
        stored.features = normalizedFeatures;
        stored.plan = LicenseManager.derivePlan(normalizedFeatures);
        this.storeLicense(stored);
      }

      return { success: true };
    } catch {
      return { success: false };
    }
  }

  /**
   * Validate the stored invitation code against the API.
   *
   * - If no stored license exists, returns `{ valid: false, offline: false }`.
   * - On successful API response, returns `{ valid: <API result>, offline: false }`.
   * - On network error, returns `{ valid: true, offline: true }` so the renderer
   *   can force community mode while still allowing the app to proceed.
   *
   * Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 9.2
   */
  async validate(): Promise<ValidationResult> {
    const stored = this.getStoredLicense();
    if (!stored) {
      return { valid: false, offline: false };
    }

    // Always attempt server validation first — the server is the source of truth
    // for expiry dates (the user may have extended validity on the backend).
    // Local expiry is only used as a fallback when the server is unreachable.
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/service/keys/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_BEARER_TOKEN}`,
        },
        body: JSON.stringify({ code: stored.invitationCode, platform: getPlatformString(), version: getAppVersion() }),
      });
    } catch {
      // Network error — offline fallback: use local expiry check
      if (stored.expiresAt) {
        const expiryDate = new Date(stored.expiresAt);
        if (expiryDate.getTime() > 0 && expiryDate < new Date()) {
          console.log('[LicenseManager] Offline + locally expired. expiresAt:', stored.expiresAt);
          return { valid: false, offline: false };
        }
      }
      return { valid: true, offline: true };
    }

    if (!response.ok) {
      return { valid: false, offline: false };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { valid: false, offline: false };
    }

    const result = data as Record<string, unknown>;
    console.log('[LicenseManager] validate response:', JSON.stringify(result));

    // If server explicitly says valid: true, trust it
    if (result.valid === true) {
      // But also update local expiry if server provides one
      const serverExpiry = (result.expiry_date ?? result.expiresAt ?? result.expires_at) as string | undefined;
      if (serverExpiry && stored.expiresAt !== serverExpiry) {
        const upsert = this.db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))");
        upsert.run('license:expires-at', serverExpiry);
      }
      return { valid: true, offline: false };
    }

    // Server says valid: false — check the error message
    const errorMsg = (typeof result.error === 'string') ? (result.error as string).toLowerCase() : '';

    // If error mentions "expired", update local expiry and return invalid
    if (errorMsg.includes('expired') || errorMsg.includes('expir') || result.expired === true) {
      console.log('[LicenseManager] Server reports license expired:', result.error);
      // Update local expiry to now so it stays expired on future checks
      const upsert = this.db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))");
      upsert.run('license:expires-at', new Date().toISOString());
      return { valid: false, offline: false };
    }

    // "Code already used" means the license is active on a device
    // But we need to verify it hasn't expired — re-fetch the license to get current expiry
    if (errorMsg.includes('already used')) {
      try {
        const checkResp = await fetch(`${API_BASE_URL}/api/service/keys/${encodeURIComponent(stored.invitationCode)}?platform=${encodeURIComponent(getPlatformString())}&version=${encodeURIComponent(getAppVersion())}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${API_BEARER_TOKEN}` },
        });
        if (checkResp.ok) {
          const checkData = await checkResp.json() as Record<string, unknown>;
          const serverExpiry = (checkData.expiry_date ?? checkData.expiresAt ?? checkData.expires_at) as string | undefined;
          if (serverExpiry) {
            // Update local expiry with the real server value
            const upsert = this.db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))");
            upsert.run('license:expires-at', serverExpiry);
            const realExpiry = new Date(serverExpiry);
            if (realExpiry.getTime() > 0 && realExpiry < new Date()) {
              console.log('[LicenseManager] License expired per server. expiry_date:', serverExpiry, 'now:', new Date().toISOString());
              return { valid: false, offline: false };
            }
          }
        }
      } catch { /* network error — assume valid for now */ }
      return { valid: true, offline: false };
    }

    // Any other invalid response — trust the server
    return { valid: false, offline: false };
  }

  /**
   * Send a heartbeat to the server (fire-and-forget).
   *
   * Called periodically in the background to report the app is active.
   * Does not affect app behavior — purely for server-side analytics.
   */
  async heartbeat(): Promise<void> {
    const stored = this.getStoredLicense();
    if (!stored?.invitationCode) return;

    try {
      await fetch(`${API_BASE_URL}/api/client/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_BEARER_TOKEN}`,
        },
        body: JSON.stringify({
          code: stored.invitationCode,
          platform: getPlatformString(),
          version: getAppVersion(),
        }),
      });
    } catch {
      // Fire-and-forget — ignore errors
    }
  }
}
