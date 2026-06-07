/**
 * NeuroNest Secure Core — JS wrapper for native addon.
 *
 * Provides a safe interface to compiled cryptographic and security functions.
 * Falls back to Node.js crypto if native module is unavailable (dev mode).
 */

'use strict';

let nativeModule = null;

try {
  nativeModule = require('./build/Release/secure_core.node');
} catch (e) {
  try {
    nativeModule = require('./build/Debug/secure_core.node');
  } catch (e2) {
    // Native module not available — use JS fallback
    console.warn('[SecureCore] Native module not available, using JS fallback');
  }
}

// JS fallback using Node.js crypto
const crypto = require('node:crypto');

const fallback = {
  computeSHA256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
  },
  verifyToken(token, secret) {
    const dotPos = token.lastIndexOf('.');
    if (dotPos === -1) return false;
    const payload = token.substring(0, dotPos);
    const signature = token.substring(dotPos + 1);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  },
  signPayload(payload, secret) {
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return payload + '.' + sig;
  },
  secureRandom(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  },
  computeFileHash(filePath) {
    const fs = require('node:fs');
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      return '';
    }
  },
  validateTimestamp(timestamp, maxDrift = 300000) {
    const now = Date.now();
    const diff = now - timestamp;
    return diff >= 0 && diff <= maxDrift;
  },
  checkEnvironment() {
    const suspicious = !!(
      process.env.ELECTRON_ENABLE_LOGGING ||
      process.env.ELECTRON_DEBUG_NOTIFICATIONS ||
      process.env.NODE_DEBUG
    );
    return { safe: !suspicious, suspicious };
  },
};

module.exports = nativeModule || fallback;
