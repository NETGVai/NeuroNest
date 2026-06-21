/**
 * Dependency Grounding Service — Version-aware documentation and API validation.
 *
 * Resolves installed package versions from lockfiles (package-lock.json, yarn.lock,
 * pnpm-lock.yaml, Pipfile.lock, Cargo.lock, go.sum), fetches and caches versioned
 * documentation, and validates generated API calls against known symbols.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { readFile, readdir, stat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface VersionedDoc {
  packageName: string;
  version: string;
  ecosystem: string;
  symbols: Map<string, SymbolDoc>;
  fetchedAt: string;
  expiresAt: string;
}

export interface SymbolDoc {
  name: string;
  signature: string;
  description: string;
  deprecated: boolean;
  sinceVersion: string | null;
}

export interface GroundingConfig {
  cacheDir: string;
  cacheTtlDays: number;     // default 7
  maxCacheSizeMb: number;   // default 200
}

// ─── Serialization helpers ───────────────────────────────────────────────────

interface SerializedVersionedDoc {
  packageName: string;
  version: string;
  ecosystem: string;
  symbols: Record<string, SymbolDoc>;
  fetchedAt: string;
  expiresAt: string;
}

function serializeDoc(doc: VersionedDoc): string {
  const serialized: SerializedVersionedDoc = {
    packageName: doc.packageName,
    version: doc.version,
    ecosystem: doc.ecosystem,
    symbols: Object.fromEntries(doc.symbols),
    fetchedAt: doc.fetchedAt,
    expiresAt: doc.expiresAt,
  };
  return JSON.stringify(serialized);
}

function deserializeDoc(json: string): VersionedDoc {
  const parsed: SerializedVersionedDoc = JSON.parse(json);
  return {
    packageName: parsed.packageName,
    version: parsed.version,
    ecosystem: parsed.ecosystem,
    symbols: new Map(Object.entries(parsed.symbols)),
    fetchedAt: parsed.fetchedAt,
    expiresAt: parsed.expiresAt,
  };
}

// ─── Default Constants ───────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_DAYS = 7;
const DEFAULT_MAX_CACHE_SIZE_MB = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Registry fetch interface (injectable for testing) ───────────────────────

export interface RegistryFetcher {
  fetchDocumentation(packageName: string, version: string, ecosystem: string): Promise<VersionedDoc | null>;
}

/**
 * Default registry fetcher that queries public package registries.
 * Returns null if unable to fetch (network error, package not found, etc.)
 */
class DefaultRegistryFetcher implements RegistryFetcher {
  async fetchDocumentation(packageName: string, version: string, ecosystem: string): Promise<VersionedDoc | null> {
    try {
      const registryUrl = this.getRegistryUrl(packageName, version, ecosystem);
      if (!registryUrl) return null;

      const response = await fetch(registryUrl);
      if (!response.ok) {
        logger.debug('Registry fetch failed', { packageName, version, ecosystem, status: response.status });
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      return this.parseRegistryResponse(data, packageName, version, ecosystem);
    } catch (err) {
      logger.debug('Registry fetch error', {
        packageName,
        version,
        ecosystem,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private getRegistryUrl(packageName: string, version: string, ecosystem: string): string | null {
    switch (ecosystem) {
      case 'npm':
        return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
      case 'pypi':
        return `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${version}/json`;
      case 'cargo':
        return `https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}/${version}`;
      case 'go':
        return `https://proxy.golang.org/${encodeURIComponent(packageName)}/@v/${version}.info`;
      default:
        return null;
    }
  }

  private parseRegistryResponse(
    data: Record<string, unknown>,
    packageName: string,
    version: string,
    ecosystem: string
  ): VersionedDoc {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_CACHE_TTL_DAYS * MS_PER_DAY);
    const symbols = new Map<string, SymbolDoc>();

    // Extract exports/symbols based on ecosystem
    if (ecosystem === 'npm' && data.exports && typeof data.exports === 'object') {
      for (const [key, value] of Object.entries(data.exports as Record<string, unknown>)) {
        symbols.set(key, {
          name: key,
          signature: typeof value === 'string' ? value : String(value),
          description: '',
          deprecated: false,
          sinceVersion: null,
        });
      }
    }

    return {
      packageName,
      version,
      ecosystem,
      symbols,
      fetchedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }
}

// ─── DependencyGroundingService Implementation ───────────────────────────────

/**
 * Service that resolves installed dependency versions from lockfiles,
 * fetches versioned documentation, and validates API calls against
 * known symbol documentation to flag hallucinated function calls.
 */
export class DependencyGroundingService {
  private docCache: Map<string, VersionedDoc>;
  private config: Required<GroundingConfig>;
  private registryFetcher: RegistryFetcher;

  constructor(config: GroundingConfig, registryFetcher?: RegistryFetcher) {
    this.config = {
      cacheDir: config.cacheDir,
      cacheTtlDays: config.cacheTtlDays ?? DEFAULT_CACHE_TTL_DAYS,
      maxCacheSizeMb: config.maxCacheSizeMb ?? DEFAULT_MAX_CACHE_SIZE_MB,
    };
    this.docCache = new Map();
    this.registryFetcher = registryFetcher ?? new DefaultRegistryFetcher();

    logger.info('DependencyGroundingService initialized', {
      cacheDir: this.config.cacheDir,
      cacheTtlDays: this.config.cacheTtlDays,
      maxCacheSizeMb: this.config.maxCacheSizeMb,
    });
  }

  /**
   * Get documentation for a package by resolving its installed version
   * from lockfiles and fetching docs with cache-first strategy.
   */
  async getDocumentation(packageName: string, projectDir: string): Promise<VersionedDoc | null> {
    // Step 1: resolve installed version from lockfile
    const version = await this.resolveVersion(packageName, projectDir);
    if (!version) {
      logger.debug('Could not resolve version for package', { packageName, projectDir });
      return null;
    }

    const ecosystem = await this.detectEcosystem(projectDir);
    const cacheKey = `${ecosystem}:${packageName}@${version}`;

    // Step 2: check in-memory cache
    const memCached = this.docCache.get(cacheKey);
    if (memCached && !this.isExpired(memCached)) {
      logger.debug('Documentation found in memory cache', { packageName, version });
      return memCached;
    }

    // Step 3: check disk cache
    const diskCached = await this.loadFromDiskCache(cacheKey);
    if (diskCached && !this.isExpired(diskCached)) {
      this.docCache.set(cacheKey, diskCached);
      logger.debug('Documentation found in disk cache', { packageName, version });
      return diskCached;
    }

    // Step 4: fetch from registry
    const fetched = await this.registryFetcher.fetchDocumentation(packageName, version, ecosystem);
    if (fetched) {
      // Set proper expiry
      const now = new Date();
      fetched.fetchedAt = now.toISOString();
      fetched.expiresAt = new Date(now.getTime() + this.config.cacheTtlDays * MS_PER_DAY).toISOString();

      this.docCache.set(cacheKey, fetched);
      await this.saveToDiskCache(cacheKey, fetched);
      logger.debug('Documentation fetched from registry', { packageName, version, ecosystem });
      return fetched;
    }

    logger.debug('No documentation available', { packageName, version, ecosystem });
    return null;
  }

  /**
   * Validate whether a generated function call exists in the cached API
   * documentation for the given package and version.
   */
  validateApiCall(
    packageName: string,
    functionName: string,
    version: string
  ): { valid: boolean; suggestion?: string } {
    // Search all cached docs for this package@version
    for (const [_key, doc] of this.docCache) {
      if (doc.packageName === packageName && doc.version === version) {
        // Exact match
        if (doc.symbols.has(functionName)) {
          const symbolDoc = doc.symbols.get(functionName)!;
          if (symbolDoc.deprecated) {
            return {
              valid: true,
              suggestion: `Warning: '${functionName}' is deprecated in ${packageName}@${version}`,
            };
          }
          return { valid: true };
        }

        // No exact match — try to find closest symbol for suggestion
        const suggestion = this.findClosestSymbol(functionName, doc.symbols);
        return {
          valid: false,
          suggestion: suggestion
            ? `'${functionName}' not found in ${packageName}@${version}. Did you mean '${suggestion}'?`
            : `'${functionName}' not found in ${packageName}@${version}. This may be a hallucinated API call.`,
        };
      }
    }

    // No docs cached for this package/version — can't validate
    return { valid: false, suggestion: `No documentation cached for ${packageName}@${version}. Unable to validate.` };
  }

  /**
   * Parse lockfiles to determine the installed version of a package.
   * Supports: package-lock.json, yarn.lock, pnpm-lock.yaml, Pipfile.lock,
   * Cargo.lock, and go.sum.
   */
  async resolveVersion(packageName: string, projectDir: string): Promise<string | null> {
    const dir = resolve(projectDir);

    // Try each lockfile format in order of commonality
    const resolvers: Array<{ file: string; parse: (content: string) => string | null }> = [
      { file: 'package-lock.json', parse: (c) => this.parsePackageLock(c, packageName) },
      { file: 'yarn.lock', parse: (c) => this.parseYarnLock(c, packageName) },
      { file: 'pnpm-lock.yaml', parse: (c) => this.parsePnpmLock(c, packageName) },
      { file: 'Pipfile.lock', parse: (c) => this.parsePipfileLock(c, packageName) },
      { file: 'Cargo.lock', parse: (c) => this.parseCargoLock(c, packageName) },
      { file: 'go.sum', parse: (c) => this.parseGoSum(c, packageName) },
    ];

    for (const { file, parse } of resolvers) {
      try {
        const filePath = join(dir, file);
        const content = await readFile(filePath, 'utf-8');
        const version = parse(content);
        if (version) {
          logger.debug('Version resolved from lockfile', { packageName, version, lockfile: file });
          return version;
        }
      } catch {
        // File doesn't exist or can't be read — try next
      }
    }

    return null;
  }

  // ─── Lockfile Parsers ──────────────────────────────────────────────────────

  /**
   * Parse package-lock.json (npm v2/v3 format).
   * Looks up packages["node_modules/{name}"].version
   */
  private parsePackageLock(content: string, packageName: string): string | null {
    try {
      const lock = JSON.parse(content);

      // npm v2/v3 lockfile format: packages["node_modules/{name}"]
      if (lock.packages) {
        const key = `node_modules/${packageName}`;
        const entry = lock.packages[key];
        if (entry && entry.version) {
          return entry.version;
        }
      }

      // npm v1 lockfile format: dependencies[name]
      if (lock.dependencies) {
        const entry = lock.dependencies[packageName];
        if (entry && entry.version) {
          return entry.version;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse yarn.lock entries.
   * Format: "{name}@{range}:" followed by "  version "x.y.z""
   */
  private parseYarnLock(content: string, packageName: string): string | null {
    // Match patterns like:
    // "package-name@^1.0.0":
    //   version "1.2.3"
    // or (yarn v1):
    // package-name@^1.0.0:
    //   version "1.2.3"
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `"?${escapedName}@[^":\\n]+?"?:\\s*\\n\\s+version\\s+"([^"]+)"`,
      'm'
    );
    const match = content.match(pattern);
    return match ? match[1] : null;
  }

  /**
   * Parse pnpm-lock.yaml packages section.
   * Format: packages section with entries like /{name}/{version}: or /{name}@{version}:
   */
  private parsePnpmLock(content: string, packageName: string): string | null {
    // pnpm-lock v6+ format: /{name}@{version}:  or  /{name}/{version}:
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Try v6+ format: /package-name@1.2.3:
    const v6Pattern = new RegExp(`/${escapedName}@(\\d+\\.\\d+\\.\\d+[^:]*):`, 'm');
    const v6Match = content.match(v6Pattern);
    if (v6Match) return v6Match[1];

    // Try v5 format: /package-name/1.2.3:
    const v5Pattern = new RegExp(`/${escapedName}/(\\d+\\.\\d+\\.\\d+[^:]*):`, 'm');
    const v5Match = content.match(v5Pattern);
    if (v5Match) return v5Match[1];

    // Try lockfile version 9 format: 'package-name@version':
    const v9Pattern = new RegExp(`'${escapedName}@(\\d+\\.\\d+\\.\\d+[^']*)'`, 'm');
    const v9Match = content.match(v9Pattern);
    if (v9Match) return v9Match[1];

    return null;
  }

  /**
   * Parse Pipfile.lock (JSON format).
   * Looks at packages[name].version (stripped of "==" prefix)
   */
  private parsePipfileLock(content: string, packageName: string): string | null {
    try {
      const lock = JSON.parse(content);
      const packages = lock.default || {};
      const entry = packages[packageName] || packages[packageName.toLowerCase()];
      if (entry && entry.version) {
        // Pipfile.lock versions are like "==1.2.3"
        return entry.version.replace(/^==/, '');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse Cargo.lock [[package]] sections.
   * Format:
   * [[package]]
   * name = "package-name"
   * version = "1.2.3"
   */
  private parseCargoLock(content: string, packageName: string): string | null {
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `\\[\\[package\\]\\]\\s*\\nname\\s*=\\s*"${escapedName}"\\s*\\nversion\\s*=\\s*"([^"]+)"`,
      'm'
    );
    const match = content.match(pattern);
    return match ? match[1] : null;
  }

  /**
   * Parse go.sum lines.
   * Format: module v1.2.3 h1:hash=
   * or:     module v1.2.3/go.mod h1:hash=
   */
  private parseGoSum(content: string, packageName: string): string | null {
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: module v1.2.3 h1:... (prefer non /go.mod entries)
    const pattern = new RegExp(`^${escapedName}\\s+v(\\S+?)(?:/go\\.mod)?\\s+h1:`, 'm');
    const match = content.match(pattern);
    return match ? match[1] : null;
  }

  // ─── Cache Management ──────────────────────────────────────────────────────

  private isExpired(doc: VersionedDoc): boolean {
    return new Date(doc.expiresAt).getTime() < Date.now();
  }

  private getCacheFilePath(cacheKey: string): string {
    // Sanitize the key for filesystem use
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9@._-]/g, '_');
    return join(this.config.cacheDir, `${safeKey}.json`);
  }

  private async loadFromDiskCache(cacheKey: string): Promise<VersionedDoc | null> {
    try {
      const filePath = this.getCacheFilePath(cacheKey);
      const content = await readFile(filePath, 'utf-8');
      return deserializeDoc(content);
    } catch {
      return null;
    }
  }

  private async saveToDiskCache(cacheKey: string, doc: VersionedDoc): Promise<void> {
    try {
      await mkdir(this.config.cacheDir, { recursive: true });

      // Enforce cache size limit before writing
      await this.enforceCacheSizeLimit();

      const filePath = this.getCacheFilePath(cacheKey);
      await writeFile(filePath, serializeDoc(doc), 'utf-8');
    } catch (err) {
      logger.warn('Failed to save documentation to disk cache', {
        cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Enforce maximum cache size by removing oldest files when limit is exceeded.
   */
  private async enforceCacheSizeLimit(): Promise<void> {
    try {
      const maxBytes = this.config.maxCacheSizeMb * 1024 * 1024;
      const files = await readdir(this.config.cacheDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      // Get file stats and sort by modification time (oldest first)
      const fileStats: Array<{ name: string; path: string; size: number; mtime: number }> = [];
      let totalSize = 0;

      for (const file of jsonFiles) {
        const filePath = join(this.config.cacheDir, file);
        try {
          const s = await stat(filePath);
          fileStats.push({ name: file, path: filePath, size: s.size, mtime: s.mtimeMs });
          totalSize += s.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }

      if (totalSize <= maxBytes) return;

      // Sort oldest first and remove until under limit
      fileStats.sort((a, b) => a.mtime - b.mtime);

      for (const file of fileStats) {
        if (totalSize <= maxBytes) break;
        try {
          await unlink(file.path);
          totalSize -= file.size;
          // Also remove from memory cache if present
          const keyFromFile = file.name.replace('.json', '').replace(/_/g, '/');
          this.docCache.delete(keyFromFile);
          logger.debug('Evicted cache file to enforce size limit', { file: file.name });
        } catch {
          // Skip files that can't be deleted
        }
      }
    } catch {
      // Cache dir may not exist yet — that's fine
    }
  }

  /**
   * Detect the primary ecosystem of a project directory.
   */
  private async detectEcosystem(projectDir: string): Promise<string> {
    const dir = resolve(projectDir);
    const checks: Array<{ file: string; ecosystem: string }> = [
      { file: 'package-lock.json', ecosystem: 'npm' },
      { file: 'yarn.lock', ecosystem: 'npm' },
      { file: 'pnpm-lock.yaml', ecosystem: 'npm' },
      { file: 'Cargo.lock', ecosystem: 'cargo' },
      { file: 'go.sum', ecosystem: 'go' },
      { file: 'Pipfile.lock', ecosystem: 'pypi' },
    ];

    for (const { file, ecosystem } of checks) {
      try {
        await stat(join(dir, file));
        return ecosystem;
      } catch {
        // Continue
      }
    }

    return 'unknown';
  }

  /**
   * Find the closest symbol name using Levenshtein distance.
   */
  private findClosestSymbol(target: string, symbols: Map<string, SymbolDoc>): string | null {
    let bestMatch: string | null = null;
    let bestDistance = Infinity;
    const maxDistance = Math.max(3, Math.floor(target.length * 0.4));

    for (const name of symbols.keys()) {
      const distance = this.levenshteinDistance(target.toLowerCase(), name.toLowerCase());
      if (distance < bestDistance && distance <= maxDistance) {
        bestDistance = distance;
        bestMatch = name;
      }
    }

    return bestMatch;
  }

  /**
   * Compute Levenshtein distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= a.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,        // deletion
          matrix[i][j - 1] + 1,        // insertion
          matrix[i - 1][j - 1] + cost  // substitution
        );
      }
    }

    return matrix[a.length][b.length];
  }
}
