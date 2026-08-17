/**
 * Tool_Spill_Service — Stores oversized Canonical_Tool_Values and provides
 * bounded previews with authorized range retrieval.
 *
 * Implements:
 * - Spill storage when tool results exceed configured threshold (Requirement 4.5)
 * - Content-type-aware bounded previews (Requirement 4.5)
 * - Authorized locator with scope/expiry/range validation (Requirement 4.6)
 * - Structured errors without revealing other locators (Requirement 4.7)
 * - Scope-validated retrieval (Requirement 4.6–4.7)
 *
 * Requirements: 4.5–4.7, 37.3–37.4, 37.8–37.9
 */

import crypto from 'node:crypto';
import type { SharedDatabase } from '../database/shared-database.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type { CanonicalToolValueV1 } from '../contracts/tool-value.js';
import type {
  SpillConfig,
  SpillRecord,
  SpillPreview,
  SpillRangeRequest,
  SpillRangeResult,
  SpillError,
} from './compaction-types.js';

// ─── Locator Generation ─────────────────────────────────────────

/**
 * Generate a cryptographically random authorized locator.
 * Locators are opaque tokens that do not reveal storage details.
 */
function generateLocator(): string {
  return `spill:${crypto.randomUUID()}:${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Compute a content digest (SHA-256) for a serialized value.
 */
function computeDigest(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─── Content-Aware Preview Generation ───────────────────────────

/**
 * Generate a bounded preview of content based on media type.
 * Truncates intelligently based on content structure.
 */
function generatePreview(data: string, mediaType: string, maxBytes: number): string {
  if (data.length <= maxBytes) {
    return data;
  }

  // JSON: truncate at a reasonable boundary
  if (mediaType.includes('json')) {
    const truncated = data.slice(0, maxBytes);
    // Try to end at a complete JSON structure boundary
    const lastBrace = Math.max(truncated.lastIndexOf('}'), truncated.lastIndexOf(']'));
    if (lastBrace > maxBytes * 0.5) {
      return truncated.slice(0, lastBrace + 1);
    }
    return truncated + '...';
  }

  // Text: truncate at newline boundary
  if (mediaType.startsWith('text/')) {
    const truncated = data.slice(0, maxBytes);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > maxBytes * 0.5) {
      return truncated.slice(0, lastNewline + 1) + '...';
    }
    return truncated + '...';
  }

  // Default: raw truncation
  return data.slice(0, maxBytes) + '...';
}

// ─── Scope Validation ───────────────────────────────────────────

/**
 * Validate that a caller's scope is authorized to access a spill record.
 * A caller must share at least the session scope of the spill record.
 */
function isScopeAuthorized(
  callerScope: ScopeDescriptorV1,
  recordScope: ScopeDescriptorV1,
): boolean {
  // Session-level match is the minimum required access
  if (recordScope.sessionId && callerScope.sessionId !== recordScope.sessionId) {
    return false;
  }

  // If record has userId scope, caller must match
  if (recordScope.userId && callerScope.userId !== recordScope.userId) {
    return false;
  }

  // If record has workspace scope, caller must match
  if (recordScope.workspaceId && callerScope.workspaceId !== recordScope.workspaceId) {
    return false;
  }

  return true;
}

// ─── Tool Spill Service ─────────────────────────────────────────

/**
 * Tool_Spill_Service — Manages oversized tool result storage with
 * bounded previews and authorized range retrieval.
 *
 * Spill records are stored in the Shared_Database. The actual content
 * is stored in a BLOB column. Locators are opaque tokens used for
 * secure retrieval.
 */
export class ToolSpillService {
  private readonly db: SharedDatabase;
  private readonly config: SpillConfig;

  constructor(db: SharedDatabase, config: SpillConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Ensure the spill storage table exists.
   * Called during service initialization.
   */
  ensureSchema(): void {
    this.db.raw.exec(`
      CREATE TABLE IF NOT EXISTS harness_spill (
        spillId TEXT PRIMARY KEY,
        callId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        branchId TEXT NOT NULL,
        locator TEXT NOT NULL UNIQUE,
        mediaType TEXT NOT NULL,
        data TEXT NOT NULL,
        totalBytes INTEGER NOT NULL,
        scope TEXT NOT NULL,
        expiresAt TEXT,
        contentDigest TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);

    this.db.raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_spill_locator ON harness_spill(locator)
    `);

    this.db.raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_spill_session ON harness_spill(sessionId, branchId)
    `);

    this.db.raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_spill_expiry ON harness_spill(expiresAt)
    `);
  }

  /**
   * Check if a tool value should be spilled based on byte size threshold.
   */
  shouldSpill(value: CanonicalToolValueV1): boolean {
    const serialized = JSON.stringify(value.value);
    return Buffer.byteLength(serialized, 'utf8') > this.config.spillThresholdBytes;
  }

  /**
   * Spill an oversized Canonical_Tool_Value.
   *
   * Stores the complete value and returns a bounded preview with an
   * authorized locator for range retrieval.
   *
   * @returns The spill preview (with locator) or null if value doesn't need spilling
   */
  spill(
    value: CanonicalToolValueV1,
    sessionId: string,
    branchId: string,
    scope: ScopeDescriptorV1,
  ): SpillPreview | null {
    const serialized = JSON.stringify(value.value);
    const totalBytes = Buffer.byteLength(serialized, 'utf8');

    if (totalBytes <= this.config.spillThresholdBytes) {
      return null;
    }

    const spillId = crypto.randomUUID();
    const locator = generateLocator();
    const contentDigest = computeDigest(serialized);
    const createdAt = new Date().toISOString();
    const expiresAt = this.config.defaultExpiryMs > 0
      ? new Date(Date.now() + this.config.defaultExpiryMs).toISOString()
      : undefined;

    // Store in database
    const stmt = this.db.raw.prepare(`
      INSERT INTO harness_spill (spillId, callId, sessionId, branchId, locator, mediaType, data, totalBytes, scope, expiresAt, contentDigest, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      spillId,
      value.callId,
      sessionId,
      branchId,
      locator,
      value.mediaType,
      serialized,
      totalBytes,
      JSON.stringify(scope),
      expiresAt ?? null,
      contentDigest,
      createdAt,
    );

    // Generate bounded preview
    const previewData = generatePreview(
      serialized,
      value.mediaType,
      this.config.previewSizeLimitBytes,
    );

    return {
      locator,
      mediaType: value.mediaType,
      previewData,
      totalBytes,
      previewBytes: Buffer.byteLength(previewData, 'utf8'),
      rangeRetrievalAvailable: true,
    };
  }

  /**
   * Retrieve a preview for an existing spill by locator.
   */
  getPreview(locator: string, callerScope: ScopeDescriptorV1): SpillPreview | SpillError {
    const record = this.findByLocator(locator);

    if (!record) {
      return { code: 'invalid_locator', message: 'The specified locator is not valid' };
    }

    // Check expiry
    if (record.expiresAt) {
      const expiryTime = new Date(record.expiresAt).getTime();
      if (Date.now() > expiryTime) {
        return {
          code: 'expired_locator',
          message: 'The specified locator has expired',
          expiredAt: record.expiresAt,
        };
      }
    }

    // Check scope
    const recordScope = JSON.parse(record.scopeJson) as ScopeDescriptorV1;
    if (!isScopeAuthorized(callerScope, recordScope)) {
      return { code: 'scope_mismatch', message: 'Caller scope does not match spill record scope' };
    }

    const previewData = generatePreview(
      record.data,
      record.mediaType,
      this.config.previewSizeLimitBytes,
    );

    return {
      locator,
      mediaType: record.mediaType,
      previewData,
      totalBytes: record.totalBytes,
      previewBytes: Buffer.byteLength(previewData, 'utf8'),
      rangeRetrievalAvailable: true,
    };
  }

  /**
   * Read a byte range from a spilled tool value (Requirement 4.6).
   *
   * Validates locator, expiry, scope, and enforces configured retrieval limit.
   * Returns structured errors for invalid/expired locators (Requirement 4.7).
   */
  readRange(request: SpillRangeRequest): SpillRangeResult | SpillError {
    const record = this.findByLocator(request.locator);

    if (!record) {
      return { code: 'invalid_locator', message: 'The specified locator is not valid' };
    }

    // Check expiry
    if (record.expiresAt) {
      const expiryTime = new Date(record.expiresAt).getTime();
      if (Date.now() > expiryTime) {
        return {
          code: 'expired_locator',
          message: 'The specified locator has expired',
          expiredAt: record.expiresAt,
        };
      }
    }

    // Check scope
    const recordScope = JSON.parse(record.scopeJson) as ScopeDescriptorV1;
    if (!isScopeAuthorized(request.callerScope, recordScope)) {
      return { code: 'scope_mismatch', message: 'Caller scope does not match spill record scope' };
    }

    // Validate range
    const requestedLength = Math.min(request.byteLength, this.config.retrievalLimitBytes);
    if (request.byteLength > this.config.retrievalLimitBytes) {
      return {
        code: 'range_exceeded',
        message: `Requested range exceeds maximum retrieval limit of ${this.config.retrievalLimitBytes} bytes`,
        maxBytes: this.config.retrievalLimitBytes,
      };
    }

    // Extract the requested range
    const dataBytes = Buffer.from(record.data, 'utf8');
    if (request.byteOffset >= dataBytes.length) {
      return {
        data: '',
        mediaType: record.mediaType,
        totalBytes: record.totalBytes,
        returnedBytes: 0,
      };
    }

    const end = Math.min(request.byteOffset + requestedLength, dataBytes.length);
    const slice = dataBytes.slice(request.byteOffset, end);

    return {
      data: slice.toString('utf8'),
      mediaType: record.mediaType,
      totalBytes: record.totalBytes,
      returnedBytes: slice.length,
    };
  }

  /**
   * Clean up expired spill records.
   * Should be called periodically by the session service.
   */
  cleanupExpired(): number {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(
      `DELETE FROM harness_spill WHERE expiresAt IS NOT NULL AND expiresAt < ?`
    ).run(now);
    return result.changes;
  }

  /**
   * Get spill record metadata (without data) for a session.
   */
  getSessionSpills(sessionId: string, branchId: string): Omit<SpillRecord, 'scope'>[] {
    const rows = this.db.raw.prepare(`
      SELECT spillId, callId, sessionId, branchId, locator, mediaType, totalBytes, expiresAt, contentDigest, createdAt
      FROM harness_spill
      WHERE sessionId = ? AND branchId = ?
      ORDER BY createdAt ASC
    `).all(sessionId, branchId) as Array<{
      spillId: string;
      callId: string;
      sessionId: string;
      branchId: string;
      locator: string;
      mediaType: string;
      totalBytes: number;
      expiresAt: string | null;
      contentDigest: string;
      createdAt: string;
    }>;

    return rows.map((row) => ({
      spillId: row.spillId,
      callId: row.callId,
      sessionId: row.sessionId,
      branchId: row.branchId,
      locator: row.locator,
      mediaType: row.mediaType,
      totalBytes: row.totalBytes,
      ...(row.expiresAt != null ? { expiresAt: row.expiresAt } : {}),
      contentDigest: row.contentDigest,
      createdAt: row.createdAt,
    }));
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private findByLocator(locator: string): {
    spillId: string;
    callId: string;
    sessionId: string;
    branchId: string;
    mediaType: string;
    data: string;
    totalBytes: number;
    scopeJson: string;
    expiresAt: string | null;
    contentDigest: string;
  } | undefined {
    const row = this.db.raw.prepare(`
      SELECT spillId, callId, sessionId, branchId, mediaType, data, totalBytes, scope, expiresAt, contentDigest
      FROM harness_spill
      WHERE locator = ?
    `).get(locator) as {
      spillId: string;
      callId: string;
      sessionId: string;
      branchId: string;
      mediaType: string;
      data: string;
      totalBytes: number;
      scope: string;
      expiresAt: string | null;
      contentDigest: string;
    } | undefined;

    if (!row) return undefined;

    return {
      spillId: row.spillId,
      callId: row.callId,
      sessionId: row.sessionId,
      branchId: row.branchId,
      mediaType: row.mediaType,
      data: row.data,
      totalBytes: row.totalBytes,
      scopeJson: row.scope,
      expiresAt: row.expiresAt,
      contentDigest: row.contentDigest,
    };
  }
}

// Export helpers for testing
export { generateLocator, computeDigest, generatePreview, isScopeAuthorized };
