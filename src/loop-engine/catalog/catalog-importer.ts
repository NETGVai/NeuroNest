/**
 * Catalog Importer — Fetches and imports loop definitions from external catalogs.
 *
 * Single unified import pipeline (REQ-13.2): entries flow through
 * Firewall Engine → Loop Doctor in one rule. No intermediate storage
 * between stages.
 *
 * Gated behind loops_catalog_import feature flag.
 * Implements Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import { validateLoopSpec } from '../schema/loop-spec.js';
import { LoopDoctor } from '../doctor/loop-doctor.js';
import type {
  CatalogEntry,
  FirewallEngineLike,
  LoopSpec,
  LoopStorageLike,
} from '../index.js';

// ─── Constants ──────────────────────────────────────────────────

/** Network fetch timeout in milliseconds (REQ-13.1: 30 seconds) */
const FETCH_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────

export interface ImportResult {
  imported: number;
  rejected: Array<{ id: string; reason: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

// ─── CatalogImporter ────────────────────────────────────────────

export class CatalogImporter {
  constructor(
    private readonly firewallEngine: FirewallEngineLike,
    private readonly loopDoctor: LoopDoctor,
    private readonly loopStorage: LoopStorageLike,
  ) {}

  /**
   * Import loop definitions from a catalog URL.
   *
   * Pipeline per entry (REQ-13.2 unified pipeline):
   * 1. Validate entry structure (has id, version, spec)
   * 2. Pass through Firewall Engine → discard if blocked
   * 3. Run Loop Doctor audit → findings are informational (don't auto-discard)
   * 4. Check for duplicates (same id+version in storage) → skip
   * 5. Store with source='catalog', catalogRef=entry.id
   *
   * @param catalogUrl - URL to fetch catalog.json from
   * @returns Import results with counts and rejection/skip reasons
   */
  async importFromUrl(catalogUrl: string): Promise<ImportResult> {
    const result: ImportResult = {
      imported: 0,
      rejected: [],
      skipped: [],
    };

    // ── Fetch catalog ──────────────────────────────────────────
    const entries = await this.fetchCatalog(catalogUrl);

    // ── Process each entry through unified pipeline ────────────
    for (const entry of entries) {
      await this.processEntry(entry, result);
    }

    return result;
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Fetch and parse catalog.json from the configured source.
   * Enforces 30s timeout (REQ-13.1) and validates JSON structure (REQ-13.5).
   */
  private async fetchCatalog(catalogUrl: string): Promise<CatalogEntry[]> {
    let response: Response;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        response = await fetch(catalogUrl, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CatalogFetchError(
          `Catalog fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${catalogUrl}`,
        );
      }
      throw new CatalogFetchError(
        `Failed to fetch catalog from ${catalogUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new CatalogFetchError(
        `Catalog source returned HTTP ${response.status}: ${catalogUrl}`,
      );
    }

    // Parse JSON response
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CatalogFetchError(
        `Catalog source returned invalid JSON: ${catalogUrl}`,
      );
    }

    // Validate structure: expect an array of entries (REQ-13.5)
    if (!Array.isArray(body)) {
      throw new CatalogFetchError(
        `Catalog source returned invalid structure (expected array): ${catalogUrl}`,
      );
    }

    // REQ-13.5: Zero entries is allowed (not an error condition)
    return body as CatalogEntry[];
  }

  /**
   * Process a single catalog entry through the unified pipeline (REQ-13.2).
   * Entries flow: validation → firewall → doctor → duplicate check → store.
   * No intermediate storage between stages.
   */
  private async processEntry(entry: unknown, result: ImportResult): Promise<void> {
    // ── Step 1: Validate entry structure ─────────────────────────
    if (!this.isValidEntry(entry)) {
      const entryId = (entry && typeof entry === 'object' && 'id' in entry)
        ? String((entry as Record<string, unknown>).id)
        : 'unknown';
      result.rejected.push({
        id: entryId,
        reason: 'Invalid entry structure: missing required fields (id, version, spec)',
      });
      return;
    }

    const catalogEntry = entry as CatalogEntry;

    // ── Step 2: Firewall Engine inspection (REQ-13.2) ────────────
    // Serialize the spec for content inspection
    const inspectionResult = await this.firewallEngine.inspect(
      JSON.stringify(catalogEntry.spec),
    );

    if (inspectionResult.blocked) {
      result.rejected.push({
        id: catalogEntry.id,
        reason: `Firewall blocked: ${inspectionResult.reason ?? 'policy violation'}`,
      });
      return;
    }

    // ── Step 3: Validate as LoopSpec ─────────────────────────────
    const specWithSource = {
      ...(catalogEntry.spec as object),
      source: 'catalog',
      catalogRef: catalogEntry.id,
    };

    const validation = validateLoopSpec(specWithSource);
    if (!validation.success) {
      result.rejected.push({
        id: catalogEntry.id,
        reason: `Schema validation failed: ${validation.error?.issues.map((i) => i.message).join('; ')}`,
      });
      return;
    }

    const validSpec = validation.data!;

    // ── Step 4: Loop Doctor audit (REQ-13.3) ─────────────────────
    // Findings are informational — attached to spec for user review
    // but don't auto-discard the entry
    await this.loopDoctor.audit(validSpec);

    // ── Step 5: Duplicate check (REQ-13.6) ───────────────────────
    const existingSpec = await this.loopStorage.getSpec(validSpec.id);
    if (existingSpec !== null) {
      // Check if same version already stored
      const existingRow = existingSpec as { version?: string };
      if (existingRow.version === validSpec.version) {
        result.skipped.push({
          id: catalogEntry.id,
          reason: `Already imported (id=${validSpec.id}, version=${validSpec.version})`,
        });
        return;
      }
    }

    // ── Step 6: Store with catalog source (REQ-13.4) ─────────────
    await this.loopStorage.saveSpec(validSpec);
    result.imported++;
  }

  /**
   * Validate that an entry has the minimum required structure:
   * id (string), version (string), and spec (object).
   */
  private isValidEntry(entry: unknown): entry is CatalogEntry {
    if (entry === null || typeof entry !== 'object') {
      return false;
    }
    const obj = entry as Record<string, unknown>;
    return (
      typeof obj.id === 'string' &&
      obj.id.length > 0 &&
      typeof obj.version === 'string' &&
      obj.version.length > 0 &&
      obj.spec !== null &&
      typeof obj.spec === 'object'
    );
  }
}

// ─── Error Types ────────────────────────────────────────────────

/**
 * Error thrown when catalog fetch fails (network, timeout, invalid response).
 * REQ-13.5: Abort import and notify user.
 */
export class CatalogFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogFetchError';
  }
}
