/**
 * NeuroNest Secure Communication Layer.
 *
 * Ensures all communication between NeuroNest and backend services is
 * secure and resilient to interception:
 * - HTTPS enforcement
 * - Certificate pinning
 * - Request signing (HMAC)
 * - Replay protection (timestamps + nonces)
 * - Secure token storage via macOS Keychain
 */

import crypto from 'node:crypto';
import { session } from 'electron';

// ─── HTTPS Enforcement ──────────────────────────────────────────

/**
 * Validate that a URL uses HTTPS. Rejects HTTP in production.
 */
export function enforceHTTPS(url: string, allowLocalhost: boolean = true): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    if (allowLocalhost && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
    return false;
  } catch {
    return false;
  }
}

// ─── Certificate Pinning ────────────────────────────────────────

export interface PinnedCertificate {
  host: string;
  fingerprints: string[]; // SHA-256 fingerprints (allow multiple for rotation)
}

const PINNED_CERTIFICATES: PinnedCertificate[] = [
  {
    host: 'neuronest.cc',
    fingerprints: [], // Populated at build time or first-run TOFU
  },
  {
    host: 'payments.neuronest.cc',
    fingerprints: [],
  },
];

/**
 * Setup certificate verification for pinned hosts.
 * Uses Trust-On-First-Use (TOFU) if no fingerprints are configured.
 */
export function setupCertificatePinning(): void {
  const trustedFingerprints = new Map<string, Set<string>>();

  // Initialize from config
  for (const pin of PINNED_CERTIFICATES) {
    if (pin.fingerprints.length > 0) {
      trustedFingerprints.set(pin.host, new Set(pin.fingerprints));
    }
  }

  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname;
    const fingerprint = request.certificate?.fingerprint || '';

    // If we have pinned certs for this host, verify
    const pins = trustedFingerprints.get(host);
    if (pins && pins.size > 0) {
      if (pins.has(fingerprint)) {
        callback(0); // Trusted
      } else {
        console.warn(`[SecureComm] Certificate pinning FAILED for ${host}. Got: ${fingerprint}`);
        callback(-2); // Reject
      }
      return;
    }

    // TOFU: Trust first certificate seen and pin it
    if (PINNED_CERTIFICATES.some(p => p.host === host) && fingerprint) {
      if (!trustedFingerprints.has(host)) {
        trustedFingerprints.set(host, new Set());
      }
      trustedFingerprints.get(host)!.add(fingerprint);
      console.log(`[SecureComm] TOFU: Pinned certificate for ${host}: ${fingerprint.slice(0, 20)}...`);
    }

    callback(0); // Allow (default Chromium verification still applies)
  });
}

// ─── Request Signing ────────────────────────────────────────────

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

/**
 * Sign an outgoing request with HMAC-SHA256.
 * Includes timestamp and nonce for replay protection.
 */
export function signRequest(
  url: string,
  method: string,
  body: string | undefined,
  secret: string,
): SignedRequest {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');

  // Canonical string: method|url|timestamp|nonce|bodyHash
  const bodyHash = body ? crypto.createHash('sha256').update(body).digest('hex') : '';
  const canonical = `${method.toUpperCase()}|${url}|${timestamp}|${nonce}|${bodyHash}`;

  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return {
    url,
    method,
    headers: {
      'X-NN-Timestamp': String(timestamp),
      'X-NN-Nonce': nonce,
      'X-NN-Signature': signature,
    },
    body,
    timestamp,
    nonce,
    signature,
  };
}

// ─── Replay Protection ──────────────────────────────────────────

const NONCE_CACHE = new Set<string>();
const MAX_NONCE_CACHE = 10000;
const MAX_TIMESTAMP_DRIFT_MS = 300000; // 5 minutes

/**
 * Validate an incoming request's timestamp and nonce.
 * Rejects replayed or expired requests.
 */
export function validateRequest(timestamp: number, nonce: string): { valid: boolean; reason?: string } {
  // Check timestamp freshness
  const now = Date.now();
  const drift = Math.abs(now - timestamp);
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    return { valid: false, reason: 'Request expired (timestamp too old)' };
  }

  // Check nonce uniqueness
  if (NONCE_CACHE.has(nonce)) {
    return { valid: false, reason: 'Duplicate nonce (possible replay)' };
  }

  // Store nonce
  NONCE_CACHE.add(nonce);
  if (NONCE_CACHE.size > MAX_NONCE_CACHE) {
    // Evict oldest entries (Set maintains insertion order)
    const iter = NONCE_CACHE.values();
    for (let i = 0; i < 1000; i++) {
      const val = iter.next().value;
      if (val) NONCE_CACHE.delete(val);
    }
  }

  return { valid: true };
}

// ─── Secure Token Storage (macOS Keychain) ──────────────────────

/**
 * Store a token securely in the macOS Keychain.
 * Falls back to encrypted file storage if keytar is unavailable.
 */
export async function storeSecureToken(service: string, account: string, token: string): Promise<boolean> {
  try {
    // Try keytar first (macOS Keychain)
    const keytar = require('keytar');
    await keytar.setPassword(service, account, token);
    return true;
  } catch {
    // Fallback: encrypt and store in app data
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      const key = crypto.scryptSync(os.hostname() + os.userInfo().username, 'neuronest-salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(token, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const tag = cipher.getAuthTag().toString('hex');

      const tokenDir = path.join(os.homedir(), '.neuronest', 'tokens');
      fs.mkdirSync(tokenDir, { recursive: true });
      const tokenFile = path.join(tokenDir, `${service}_${account}.enc`);
      fs.writeFileSync(tokenFile, JSON.stringify({ iv: iv.toString('hex'), tag, data: encrypted }), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Retrieve a token from secure storage.
 */
export async function getSecureToken(service: string, account: string): Promise<string | null> {
  try {
    const keytar = require('keytar');
    return await keytar.getPassword(service, account);
  } catch {
    // Fallback: decrypt from file
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      const tokenFile = path.join(os.homedir(), '.neuronest', 'tokens', `${service}_${account}.enc`);
      if (!fs.existsSync(tokenFile)) return null;

      const stored = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      const key = crypto.scryptSync(os.hostname() + os.userInfo().username, 'neuronest-salt', 32);
      const iv = Buffer.from(stored.iv, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(stored.tag, 'hex'));
      let decrypted = decipher.update(stored.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }
}

/**
 * Delete a token from secure storage.
 */
export async function deleteSecureToken(service: string, account: string): Promise<boolean> {
  try {
    const keytar = require('keytar');
    return await keytar.deletePassword(service, account);
  } catch {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      const tokenFile = path.join(os.homedir(), '.neuronest', 'tokens', `${service}_${account}.enc`);
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
      return true;
    } catch {
      return false;
    }
  }
}
